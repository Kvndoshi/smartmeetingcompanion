"""Deepgram realtime STT with speaker diarization.

Docs: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
- ``wss://api.deepgram.com/v1/listen?...`` with ``Authorization: Token <key>``.
- ``Results`` messages: ``is_final`` chunks, ``speech_final`` at utterance end,
  words carry ``speaker`` (int) when diarization is on.
- ``{"type":"KeepAlive"}`` every 3–5 s during gaps; ``{"type":"CloseStream"}``
  flushes and closes. Fatal errors arrive as close frames (1008/1011).
Deepgram has no native translation; the session uses a text translator.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

import websockets

logger = logging.getLogger("interpreter.deepgram")

DEFAULT_URL = "wss://api.deepgram.com/v1/listen"
DEFAULT_MODEL = "nova-3"


def _base(code: str | None) -> str:
    return (code or "").split("-")[0].lower()


class DeepgramClient:
    def __init__(
        self,
        api_key: str,
        language: str = "en",
        on_transcript: Callable[..., Awaitable[None]] | None = None,
        on_error: Callable[..., Awaitable[None]] | None = None,
        *,
        connect_fn: Callable[..., Any] | None = None,
    ) -> None:
        self.api_key = api_key
        self.language = language
        self.on_transcript = on_transcript
        self.on_error = on_error
        self.url = os.getenv("DEEPGRAM_WS_URL", "").strip() or DEFAULT_URL
        self.model = os.getenv("DEEPGRAM_STT_MODEL", "").strip() or DEFAULT_MODEL
        self._connect_fn = connect_fn or websockets.connect

        self.is_connected = False
        self.last_speaker_id: str | None = None
        self.last_speaker_gender: str | None = None

        self._ws: Any = None
        self._recv_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self._closing = False
        self._closed_event = asyncio.Event()
        self._last_audio_at = 0.0
        self._words: list[dict[str, Any]] = []  # finalized words of the current utterance

    def build_params(self) -> dict[str, str]:
        lang = _base(self.language) or "en"
        params = {
            "model": self.model,
            "encoding": "linear16",
            "sample_rate": "16000",
            "channels": "1",
            "interim_results": "true",
            "punctuate": "true",
            "smart_format": "true",
            "endpointing": os.getenv("DEEPGRAM_ENDPOINTING_MS", "300").strip() or "300",
            "utterance_end_ms": os.getenv("DEEPGRAM_UTTERANCE_END_MS", "1200").strip() or "1200",
            "language": "multi" if lang in {"auto", "multi"} else lang,
        }
        # diarize=true is deprecated in favour of diarize_model (Nov 2026 docs).
        diarize = os.getenv("DEEPGRAM_DIARIZE", "diarize_model=latest").strip()
        if diarize and "=" in diarize:
            key, value = diarize.split("=", 1)
            params[key.strip()] = value.strip()
        return params

    async def connect(self) -> None:
        if not self.api_key:
            raise ValueError("Deepgram requires DEEPGRAM_API_KEY")
        url = f"{self.url}?{urlencode(self.build_params())}"
        try:
            self._ws = await self._connect_fn(
                url,
                additional_headers={"Authorization": f"Token {self.api_key}"},
                max_size=None,
                open_timeout=10,
            )
        except websockets.InvalidStatus as exc:  # type: ignore[attr-defined]
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
            body = ""
            try:
                body = (response.body or b"").decode("utf-8", "ignore")[:200]  # type: ignore[union-attr]
            except Exception:  # noqa: BLE001
                pass
            if status in (401, 403):
                raise ValueError("Deepgram rejected the API key (check DEEPGRAM_API_KEY)") from exc
            raise ConnectionError(f"Deepgram handshake failed (HTTP {status}) {body}".strip()) from exc
        self.is_connected = True
        self._closing = False
        self._closed_event.clear()
        self._last_audio_at = time.monotonic()
        self._recv_task = asyncio.create_task(self._receive_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        logger.info("Deepgram connected (model=%s language=%s)", self.model, self.language)

    async def send_audio(self, pcm: bytes) -> None:
        # Never send empty frames: Deepgram treats them as close requests.
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
                await ws.send(json.dumps({"type": "CloseStream"}))
                await asyncio.wait_for(self._closed_event.wait(), timeout=4.0)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass
        self.is_connected = False
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self._recv_task and not self._recv_task.done():
            try:
                await asyncio.wait_for(self._recv_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._recv_task.cancel()
        await self._flush()
        self._ws = None
        logger.info("Deepgram closed")

    async def _keepalive_loop(self) -> None:
        try:
            while self.is_connected:
                await asyncio.sleep(3)
                if self.is_connected and time.monotonic() - self._last_audio_at > 3 and self._ws is not None:
                    await self._ws.send(json.dumps({"type": "KeepAlive"}))
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
        except websockets.ConnectionClosed as exc:
            if not self._closing:
                await self._report(f"connection closed ({exc.code}) {exc.reason or ''}".strip())
        except asyncio.CancelledError:
            return
        finally:
            self.is_connected = False
            self._closed_event.set()

    async def _report(self, message: str, fatal: bool = True) -> None:
        if fatal:
            self.is_connected = False
        logger.error("Deepgram error: %s", message)
        if self.on_error:
            await self.on_error(message, fatal=fatal)

    # ── message handling (public for tests) ──────────────────────────

    @staticmethod
    def _word_text(word: dict[str, Any]) -> str:
        return str(word.get("punctuated_word") or word.get("word") or "")

    @staticmethod
    def _speaker(word: dict[str, Any]) -> str | None:
        spk = word.get("speaker")
        if isinstance(spk, int):
            return str(spk + 1)  # 0-based → "1", "2", …
        return None

    async def handle_message(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "Error":
            await self._report(str(msg.get("description") or msg.get("message") or "error"), fatal=False)
            return
        if kind == "UtteranceEnd":
            await self._flush()
            return
        if kind != "Results":
            return
        alts = (msg.get("channel") or {}).get("alternatives") or []
        if not alts:
            return
        alt = alts[0]
        words = [w for w in alt.get("words") or [] if self._word_text(w)]
        if msg.get("is_final"):
            for word in words:
                spk = self._speaker(word)
                if self._words and spk is not None and self._speaker(self._words[-1]) not in (None, spk):
                    await self._flush()
                self._words.append(word)
            if msg.get("speech_final"):
                await self._flush()
            elif self._words and self.on_transcript:
                await self.on_transcript(self._joined(self._words), False, speaker=self._speaker(self._words[-1]))
            return
        interim = " ".join(self._word_text(w) for w in words) or str(alt.get("transcript") or "")
        if not interim.strip() and not self._words:
            return
        text = (self._joined(self._words) + " " + interim).strip() if self._words else interim.strip()
        speaker = self._speaker(words[0]) if words else (self._speaker(self._words[-1]) if self._words else None)
        if self.on_transcript:
            await self.on_transcript(text, False, speaker=speaker)

    def _joined(self, words: list[dict[str, Any]]) -> str:
        return " ".join(self._word_text(w) for w in words).strip()

    async def _flush(self) -> None:
        if not self._words:
            return
        words, self._words = self._words, []
        text = self._joined(words)
        speaker = next((self._speaker(w) for w in words if self._speaker(w) is not None), None)
        start = words[0].get("start")
        end = words[-1].get("end")
        if speaker:
            self.last_speaker_id = speaker
        if text and self.on_transcript:
            await self.on_transcript(
                text,
                True,
                speaker=speaker,
                start_ms=int(float(start) * 1000) if isinstance(start, (int, float)) else None,
                end_ms=int(float(end) * 1000) if isinstance(end, (int, float)) else None,
            )
