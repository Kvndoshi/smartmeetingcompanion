"""Soniox realtime STT (+ optional one-way translation, speaker diarization).

Docs: https://soniox.com/docs/api-reference/stt/websocket-api
- Auth: ``Authorization: Bearer <key>`` on the upgrade request.
- First text frame: config JSON; then binary PCM frames.
- Empty text frame ("") finalizes; server sends ``finished`` then closes.
- ``{"type":"keepalive"}`` at least every 20 s when no audio flows.
- Tokens carry ``is_final``, ``speaker``, ``translation_status``
  (none|original|translation); ``<end>``/``<fin>`` are control tokens.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

import websockets

logger = logging.getLogger("interpreter.soniox")

DEFAULT_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
DEFAULT_MODEL = "stt-rt-v6"
CONTROL_TOKENS = {"<end>", "<fin>"}
SENTENCE_END = (".", "!", "?", "。", "！", "？", "…")


def _base(code: str | None) -> str:
    return (code or "").split("-")[0].lower()


class _Utterance:
    """Accumulates finalized tokens for one speaker turn."""

    def __init__(self) -> None:
        self.tokens: list[dict[str, Any]] = []

    @property
    def text(self) -> str:
        return "".join(t.get("text", "") for t in self.tokens).strip()

    @property
    def speaker(self) -> str | None:
        for t in self.tokens:
            if t.get("speaker") is not None:
                return str(t["speaker"])
        return None

    def bounds(self) -> tuple[int | None, int | None]:
        starts = [t["start_ms"] for t in self.tokens if isinstance(t.get("start_ms"), (int, float))]
        ends = [t["end_ms"] for t in self.tokens if isinstance(t.get("end_ms"), (int, float))]
        return (int(min(starts)) if starts else None, int(max(ends)) if ends else None)

    def clear(self) -> None:
        self.tokens = []


class SonioxClient:
    def __init__(
        self,
        api_key: str,
        language: str = "en",
        target_language: str | None = None,
        on_transcript: Callable[..., Awaitable[None]] | None = None,
        on_translation: Callable[..., Awaitable[None]] | None = None,
        on_error: Callable[..., Awaitable[None]] | None = None,
        *,
        connect_fn: Callable[..., Any] | None = None,
    ) -> None:
        self.api_key = api_key
        self.language = language
        self.target_language = target_language
        self.on_transcript = on_transcript
        self.on_translation = on_translation
        self.on_error = on_error
        self.url = os.getenv("SONIOX_WS_URL", "").strip() or DEFAULT_URL
        self.model = os.getenv("SONIOX_STT_MODEL", "").strip() or DEFAULT_MODEL
        self._connect_fn = connect_fn or websockets.connect

        self.is_connected = False
        self.last_speaker_id: str | None = None
        self.last_speaker_gender: str | None = None

        self._ws: Any = None
        self._recv_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self._translation_timer: asyncio.Task[None] | None = None
        self._closing = False
        self._finished = asyncio.Event()
        self._last_audio_at = 0.0

        self._orig = _Utterance()
        self._trans = _Utterance()

    # ── config ───────────────────────────────────────────────────────

    def build_config(self) -> dict[str, Any]:
        config: dict[str, Any] = {
            "model": self.model,
            "audio_format": "pcm_s16le",
            "sample_rate": 16000,
            "num_channels": 1,
            "enable_speaker_diarization": True,
            "enable_endpoint_detection": True,
        }
        lang = _base(self.language)
        if lang in {"", "auto", "multi"}:
            config["enable_language_identification"] = True
        else:
            config["language_hints"] = [lang]
        delay = os.getenv("SONIOX_MAX_ENDPOINT_DELAY_MS", "").strip()
        if delay.isdigit():
            config["max_endpoint_delay_ms"] = max(500, min(3000, int(delay)))
        if self.target_language:
            config["translation"] = {"type": "one_way", "target_language": _base(self.target_language)}
        return config

    # ── lifecycle ────────────────────────────────────────────────────

    async def connect(self) -> None:
        if not self.api_key:
            raise ValueError("Soniox requires SONIOX_API_KEY")
        try:
            self._ws = await self._connect_fn(
                self.url,
                additional_headers={"Authorization": f"Bearer {self.api_key}"},
                max_size=None,
                open_timeout=10,
            )
        except websockets.InvalidStatus as exc:  # type: ignore[attr-defined]
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (401, 403):
                raise ValueError("Soniox rejected the API key (check SONIOX_API_KEY)") from exc
            raise ConnectionError(f"Soniox handshake failed (HTTP {status})") from exc
        await self._ws.send(json.dumps(self.build_config()))
        self.is_connected = True
        self._closing = False
        self._finished.clear()
        self._last_audio_at = time.monotonic()
        self._recv_task = asyncio.create_task(self._receive_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        logger.info(
            "Soniox connected (model=%s lang=%s translate=%s)", self.model, self.language, self.target_language
        )

    async def send_audio(self, pcm: bytes) -> None:
        if not self.is_connected or self._ws is None or not pcm:
            return
        try:
            await self._ws.send(pcm)
            self._last_audio_at = time.monotonic()
        except websockets.ConnectionClosed:
            self.is_connected = False

    async def close(self) -> None:
        if self._ws is None:
            return
        self._closing = True
        ws = self._ws
        if self.is_connected:
            try:
                await ws.send("")  # finalize: flush remaining results, then `finished`
                await asyncio.wait_for(self._finished.wait(), timeout=4.0)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass
        self.is_connected = False
        for task in (self._keepalive_task, self._translation_timer):
            if task and not task.done():
                task.cancel()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self._recv_task and not self._recv_task.done():
            try:
                await asyncio.wait_for(self._recv_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._recv_task.cancel()
        await self._flush_all()
        self._ws = None
        logger.info("Soniox closed")

    async def _keepalive_loop(self) -> None:
        try:
            while self.is_connected:
                await asyncio.sleep(5)
                if self.is_connected and time.monotonic() - self._last_audio_at > 8 and self._ws is not None:
                    await self._ws.send(json.dumps({"type": "keepalive"}))
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            return

    async def _receive_loop(self) -> None:
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                await self.handle_message(msg)
                if msg.get("finished"):
                    self._finished.set()
                    break
        except websockets.ConnectionClosed as exc:
            if not self._closing:
                await self._report(f"connection closed ({exc.code}) {exc.reason or ''}".strip())
        except asyncio.CancelledError:
            return
        finally:
            self.is_connected = False
            self._finished.set()

    async def _report(self, message: str) -> None:
        self.is_connected = False
        logger.error("Soniox error: %s", message)
        if self.on_error:
            await self.on_error(message)

    # ── token assembly (public for tests) ────────────────────────────

    async def handle_message(self, msg: dict[str, Any]) -> None:
        if msg.get("error_code") or msg.get("error_message"):
            await self._report(f"{msg.get('error_type') or msg.get('error_code')}: {msg.get('error_message', '')}".strip())
            return
        tokens = msg.get("tokens") or []
        nonfinal_orig: list[dict[str, Any]] = []
        nonfinal_trans: list[dict[str, Any]] = []
        endpoint = False
        for tok in tokens:
            text = tok.get("text", "")
            if text in CONTROL_TOKENS:
                if tok.get("is_final", True):
                    endpoint = True
                continue
            is_translation = tok.get("translation_status") == "translation"
            if tok.get("is_final"):
                if is_translation:
                    self._trans.tokens.append(tok)
                else:
                    if self._trans.tokens:
                        # Original speech resumed → previous translation chunk is complete.
                        await self._flush_translation()
                    spk = tok.get("speaker")
                    if self._orig.tokens and spk is not None and self._orig.speaker not in (None, str(spk)):
                        await self._flush_original()
                    self._orig.tokens.append(tok)
            else:
                (nonfinal_trans if is_translation else nonfinal_orig).append(tok)

        if endpoint:
            await self._flush_original()
        elif self._orig.tokens and len(self._orig.text) > 500 and self._orig.text.endswith(SENTENCE_END):
            await self._flush_original()  # very long monologue: cut at a sentence boundary

        if self._trans.tokens and self._trans.text.endswith(SENTENCE_END) and not nonfinal_trans:
            await self._flush_translation()
        elif self._trans.tokens:
            self._arm_translation_timer()

        partial_orig = (self._orig.text + "".join(t.get("text", "") for t in nonfinal_orig)).strip()
        if nonfinal_orig and partial_orig and self.on_transcript:
            speaker = next((str(t["speaker"]) for t in nonfinal_orig if t.get("speaker") is not None), self._orig.speaker)
            await self.on_transcript(partial_orig, False, speaker=speaker)
        partial_trans = (self._trans.text + "".join(t.get("text", "") for t in nonfinal_trans)).strip()
        if nonfinal_trans and partial_trans and self.on_translation:
            await self.on_translation(partial_trans, False, speaker=self.last_speaker_id)

    async def _flush_original(self) -> None:
        text = self._orig.text
        if not text:
            self._orig.clear()
            return
        speaker = self._orig.speaker
        start, end = self._orig.bounds()
        self._orig.clear()
        if speaker:
            self.last_speaker_id = speaker
        if self.on_transcript:
            await self.on_transcript(text, True, speaker=speaker, start_ms=start, end_ms=end)

    async def _flush_translation(self) -> None:
        if self._translation_timer and not self._translation_timer.done() and self._translation_timer is not asyncio.current_task():
            self._translation_timer.cancel()
        text = self._trans.text
        self._trans.clear()
        if not text:
            return
        # Emit the source segment first so the session attaches this
        # translation to the right transcript segment.
        if self._orig.tokens:
            await self._flush_original()
        if self.on_translation:
            await self.on_translation(text, True, speaker=self.last_speaker_id)

    def _arm_translation_timer(self) -> None:
        if self._translation_timer and not self._translation_timer.done():
            self._translation_timer.cancel()

        async def later() -> None:
            await asyncio.sleep(0.9)
            await self._flush_translation()

        self._translation_timer = asyncio.create_task(later())

    async def _flush_all(self) -> None:
        await self._flush_original()
        await self._flush_translation()
