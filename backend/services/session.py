"""LiveSession — the per-connection pipeline behind /ws/translate.

Audio (16 kHz mono Int16 PCM) → STT provider → transcript segments (stored in
the meeting) → optional translation (native or text translator) → optional
TTS → WAV audio back to the extension.

Protocol (client → server):
  {"type":"config", source_lang ("auto" = detect per segment), target_lang,
   mode:{translate,transcribe}, source:"tab"|"mic", meeting_id?, tab_url?,
   tab_title?, stt_provider?, tts_provider?, translator?}
  A later config on the same socket re-configures it (e.g. a new target).
  binary PCM chunks
  {"type":"stop", end_meeting?: bool} · {"type":"end_meeting"} · {"type":"ping"}

Server → client:
  {"type":"session", meeting_id, stt_provider, tts_provider, translator,
   source_lang, target_lang, auto_language, ...}
  {"type":"transcript", text, is_final, speaker, source, language, segment_id?, start_ms?}
  {"type":"translated_text_partial"|"translated_text", text, language, segment_id?, ...}
  `language` = ISO base code of what was said (null when unknown). Segments
  already in target_lang are neither translated nor spoken.
  binary WAV audio · {"type":"stopped"} · {"type":"meeting_ended", meeting_id}
  {"type":"error", message, code} · {"type":"warning", message} · {"type":"pong"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from services import background, meeting_store
from services.providers import registry
from services.providers.registry import ProviderConfigError, SttCallbacks

logger = logging.getLogger("interpreter.session")

SENTENCE_END = (".", "!", "?", "。", "！", "？", "…")


def _lang(code: str | None, default: str) -> str:
    code = (code or "").strip()
    return code or default


def _base(code: str) -> str:
    return code.split("-")[0].lower()


def _norm(text: str) -> str:
    """Comparable form of a sentence: case-folded word characters only."""
    return re.sub(r"[\W_]+", "", text.casefold())


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name, "").strip() or default))
    except ValueError:
        logger.warning("Ignoring invalid %s=%r", name, os.getenv(name))
        return default


class LiveSession:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.open = True
        self.source_lang = "en"
        self.target_lang = "es"
        self.auto_source = False  # source_lang "auto": the provider identifies each segment's language
        self.translate = True
        self.transcribe = True
        self.source = "tab"
        self.meeting: dict[str, Any] | None = None
        self.config: dict[str, Any] = {}

        self.stt: Any = None
        self.stt_provider: str | None = None
        self.native_translation = False
        self.tts_chain: list[str] = []
        self._tts_clients: dict[str, Any] = {}
        self.translator: Any = None
        self.translator_id: str | None = None

        self.queue: asyncio.Queue[tuple[Any, ...] | None] = asyncio.Queue()
        self.worker: asyncio.Task[None] | None = None
        self._pending: list[tuple[str, int | None]] = []
        self._pending_speaker: str | None = None
        self._pending_language: str | None = None
        self._last_final_text = ""
        self._flush_task: asyncio.Task[None] | None = None
        self._last_segment_id: int | None = None
        self._stt_t0: float | None = None
        self._reconnect_attempts = 0
        self._next_reconnect_at = 0.0
        self._warned_no_stt = False
        self._last_tts_warning = 0.0
        self._last_memory_checkpoint = time.time()

        self.translation_trigger_chars = _env_int("TRANSLATION_TRIGGER_CHAR_THRESHOLD", 60)
        self.translation_flush_s = _env_int("TRANSLATION_FLUSH_MS", 1200) / 1000.0
        self.memory_checkpoint_s = _env_int("MEMORY_CHECKPOINT_SECONDS", 300)

    # ── transport ────────────────────────────────────────────────────

    async def send_json(self, payload: dict[str, Any]) -> bool:
        if not self.open:
            return False
        try:
            await self.ws.send_json(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            self.open = False
            return False

    async def send_bytes(self, payload: bytes) -> bool:
        if not self.open:
            return False
        try:
            await self.ws.send_bytes(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            self.open = False
            return False

    async def send_error(self, message: str, code: str = "error") -> None:
        logger.warning("[session] %s: %s", code, message)
        await self.send_json({"type": "error", "message": message, "code": code})

    async def send_warning(self, message: str) -> None:
        logger.warning("[session] warning: %s", message)
        await self.send_json({"type": "warning", "message": message})

    # ── main loop ────────────────────────────────────────────────────

    async def run(self) -> None:
        await self.ws.accept()
        self.worker = asyncio.create_task(self._worker())
        try:
            while True:
                data = await self.ws.receive()
                if data.get("type") == "websocket.disconnect":
                    break
                if data.get("text") is not None:
                    await self._handle_text(data["text"])
                elif data.get("bytes") is not None:
                    await self._handle_audio(data["bytes"])
        except WebSocketDisconnect:
            pass
        except RuntimeError as exc:
            logger.error("WebSocket error: %s", exc)
        finally:
            await self._cleanup()

    async def _handle_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            await self.send_error("Malformed JSON message", code="bad_message")
            return
        kind = msg.get("type")
        if kind == "config":
            await self._configure(msg)
        elif kind == "ping":
            await self.send_json({"type": "pong", "t": msg.get("t")})
        elif kind == "stop":
            await self._stop(end=bool(msg.get("end_meeting")))
        elif kind == "end_meeting":
            await self._end_meeting()
        else:
            await self.send_error(f"Unknown message type '{kind}'", code="bad_message")

    async def _handle_audio(self, data: bytes) -> None:
        if self.stt is None:
            if not self._warned_no_stt:
                self._warned_no_stt = True
                logger.info("Dropping audio: no speech-to-text stream (not configured, or nothing to do)")
            return
        if not self.stt.is_connected:
            await self._maybe_reconnect()
            if self.stt is None or not self.stt.is_connected:
                return
        await self.stt.send_audio(data)

    # ── configuration ────────────────────────────────────────────────

    async def _configure(self, msg: dict[str, Any]) -> None:
        await self._close_stt()
        await self._close_aux()
        # A re-config (e.g. a new target language) must not speak queued text in the old one.
        self._pending = []
        self._drain_queue()
        self.config = msg
        self.source_lang = _lang(msg.get("source_lang"), "en")
        self.target_lang = _lang(msg.get("target_lang"), "es")
        self.auto_source = registry.is_auto_language(self.source_lang)
        if self.auto_source:
            self.source_lang = "auto"
        mode = msg.get("mode") if isinstance(msg.get("mode"), dict) else {}
        self.translate = bool(mode.get("translate", True))
        self.transcribe = bool(mode.get("transcribe", True))
        self.source = "mic" if msg.get("source") == "mic" else "tab"
        # With auto-detect every segment may be in another language; same-language
        # segments are skipped one by one (see _same_as_target).
        want_translation = self.translate and (
            self.auto_source or _base(self.source_lang) != _base(self.target_lang)
        )

        if not want_translation and not self.transcribe:
            # Nothing to translate or transcribe, e.g. "others hear my own voice" with
            # notes off. Don't hold a provider connection open; a later config wakes it.
            await self._configure_idle()
            return

        try:
            stt_id = registry.resolve(
                "stt", msg.get("stt_provider"), language=self.source_lang, require_auto=self.auto_source
            )
        except ProviderConfigError as exc:
            await self.send_error(str(exc), code="provider_config")
            return
        spec = registry.STT_SPECS[stt_id]
        self.native_translation = want_translation and spec.native_translation

        warnings: list[str] = []
        self.translator_id = None
        if want_translation and not self.native_translation:
            try:
                self.translator_id = registry.resolve("translator", msg.get("translator"))
                self.translator = registry.build_translator(self.translator_id)
            except Exception as exc:  # noqa: BLE001 — degrade to transcription only
                warnings.append(f"Translation unavailable: {exc}")
                self.translator = None
                self.translator_id = None

        self.tts_chain = []
        if want_translation:
            try:
                self.tts_chain = registry.tts_chain(msg.get("tts_provider"), self.target_lang)
            except ProviderConfigError as exc:
                warnings.append(f"Translated audio unavailable: {exc}")

        if self.transcribe:
            self.meeting = None
            mid = msg.get("meeting_id")
            if isinstance(mid, str) and mid:
                self.meeting = meeting_store.resume_meeting(mid)
            if self.meeting is None:
                self.meeting = meeting_store.create_meeting(
                    tab_url=msg.get("tab_url") or None,
                    tab_title=msg.get("tab_title") or None,
                    source_lang=self.source_lang,
                    target_lang=self.target_lang,
                    stt_provider=stt_id,
                    tts_provider=self.tts_chain[0] if self.tts_chain else None,
                )
        else:
            self.meeting = None

        callbacks = SttCallbacks(
            on_transcript=self._on_transcript,
            on_translation=self._on_translation if self.native_translation else None,
            on_error=self._on_stt_error,
        )
        try:
            self.stt = registry.build_stt(
                stt_id,
                language=self.source_lang,
                target_language=self.target_lang if self.native_translation else None,
                callbacks=callbacks,
            )
            await self.stt.connect()
        except Exception as exc:  # noqa: BLE001 — report and keep the socket usable
            self.stt = None
            code = "provider_config" if isinstance(exc, ValueError) else "provider_connect"
            await self.send_error(f"Could not start {spec.label}: {exc}", code=code)
            return

        self.stt_provider = stt_id
        self._stt_t0 = time.time()
        self._reconnect_attempts = 0
        self._warned_no_stt = False
        logger.info(
            "Session configured: stt=%s tts=%s translator=%s %s→%s translate=%s transcribe=%s source=%s meeting=%s",
            stt_id, self.tts_chain, self.translator_id, self.source_lang, self.target_lang,
            self.translate, self.transcribe, self.source, self.meeting and self.meeting["id"],
        )
        await self.send_json(
            {
                "type": "session",
                "meeting_id": self.meeting["id"] if self.meeting else None,
                "meeting_title": self.meeting["title"] if self.meeting else None,
                "stt_provider": stt_id,
                "tts_provider": self.tts_chain[0] if self.tts_chain else None,
                "translator": self.translator_id or (stt_id if self.native_translation else None),
                "translate": self.translate,
                "transcribe": self.transcribe,
                "source": self.source,
                "diarization": spec.diarization,
                "source_lang": self.source_lang,
                "target_lang": self.target_lang,
                "auto_language": self.auto_source,
            }
        )
        for warning in warnings:
            await self.send_warning(warning)

    async def _configure_idle(self) -> None:
        self.native_translation = False
        self.translator = None
        self.translator_id = None
        self.tts_chain = []
        self.meeting = None
        self.stt_provider = None
        logger.info("Session idle: %s→%s, nothing to translate or transcribe", self.source_lang, self.target_lang)
        await self.send_json(
            {
                "type": "session",
                "meeting_id": None,
                "meeting_title": None,
                "stt_provider": None,
                "tts_provider": None,
                "translator": None,
                "translate": self.translate,
                "transcribe": False,
                "source": self.source,
                "diarization": False,
                "source_lang": self.source_lang,
                "target_lang": self.target_lang,
                "auto_language": self.auto_source,
                "idle": True,
            }
        )

    async def _maybe_reconnect(self) -> None:
        now = time.time()
        if now < self._next_reconnect_at or not self.config or self._reconnect_attempts >= 5:
            return
        self._reconnect_attempts += 1
        self._next_reconnect_at = now + 5 * self._reconnect_attempts
        logger.info("STT disconnected; reconnect attempt %d", self._reconnect_attempts)
        await self.send_json({"type": "status", "status": "reconnecting"})
        config = dict(self.config)
        if self.meeting:
            config["meeting_id"] = self.meeting["id"]
        config["stt_provider"] = self.stt_provider
        attempts = self._reconnect_attempts
        await self._configure(config)
        self._reconnect_attempts = attempts if self.stt is None else 0

    # ── provider callbacks ───────────────────────────────────────────

    def _speaker(self, speaker: Any) -> str | None:
        if self.source == "mic":
            return "me"
        if speaker is None:
            return None
        text = str(speaker).strip()
        if not text or text.lower() in {"unknown", "uu"}:
            return None
        digits = re.findall(r"\d+", text)
        return f"S{digits[0]}" if digits else text[:24]

    def _rel_ms(self, provider_ms: Any) -> int | None:
        if provider_ms is None or self.meeting is None or self._stt_t0 is None:
            return None
        try:
            absolute = self._stt_t0 + float(provider_ms) / 1000.0
        except (TypeError, ValueError):
            return None
        return max(0, int((absolute - self.meeting["started_at"]) * 1000))

    def _segment_language(self, detected: Any) -> str | None:
        """ISO base code of what was said: detected by the provider, else the fixed source language."""
        if isinstance(detected, str) and detected.strip():
            return _base(detected.strip())
        return None if self.auto_source else _base(self.source_lang)

    def _same_as_target(self, language: str | None) -> bool:
        return bool(language) and language == _base(self.target_lang)

    async def _on_transcript(
        self,
        text: str,
        is_final: bool,
        speaker: Any = None,
        start_ms: Any = None,
        end_ms: Any = None,
        language: Any = None,
        **_: Any,
    ) -> None:
        if not text:
            return  # note: no `self.open` check — finals flushed during close are still stored
        spk = self._speaker(speaker)
        lang = self._segment_language(language)
        payload: dict[str, Any] = {
            "type": "transcript",
            "text": text,
            "is_final": is_final,
            "speaker": spk,
            "source": self.source,
            "language": lang,
        }
        segment_id: int | None = None
        if is_final and text.strip():
            self._last_final_text = text.strip()
            if self.meeting:
                seg = meeting_store.add_segment(
                    self.meeting["id"],
                    text=text,
                    source=self.source,
                    speaker=spk,
                    start_ms=self._rel_ms(start_ms),
                    end_ms=self._rel_ms(end_ms),
                    language=lang,
                )
                segment_id = seg["id"]
                payload["segment_id"] = segment_id
                payload["start_ms"] = seg["start_ms"]
                self._last_segment_id = segment_id
                self._maybe_checkpoint_memory()
            # Already in the listener's language → nothing to translate or speak.
            if self.translator is not None and self.open and not self._same_as_target(lang):
                await self._buffer_for_translation(text.strip(), segment_id, spk, lang)
        await self.send_json(payload)

    async def _on_translation(
        self, text: str, is_final: bool, speaker: Any = None, language: Any = None, **_: Any
    ) -> None:
        if not self.translate:
            return
        lang = self._segment_language(language)
        if self._same_as_target(lang):
            return  # a provider "translating" speech that is already in the target language
        spk = self._speaker(speaker)
        if not is_final:
            await self.send_json(
                {"type": "translated_text_partial", "text": text, "speaker": spk, "source": self.source, "language": lang}
            )
            return
        if self.auto_source and self._last_final_text and _norm(text) == _norm(self._last_final_text):
            return  # echo of the original (language unknown): don't re-speak it
        segment_id = self._last_segment_id
        await self.send_json(
            {
                "type": "translated_text",
                "text": text,
                "segment_id": segment_id,
                "speaker": spk,
                "source": self.source,
                "language": lang,
            }
        )
        if segment_id is not None and self.meeting and text.strip():
            meeting_store.set_segment_translation(segment_id, text)
        if text.strip() and self.tts_chain and self.open:
            await self.queue.put(("tts", text.strip(), spk))

    async def _on_stt_error(self, message: str, fatal: bool = True, **_: Any) -> None:
        label = registry.STT_SPECS.get(self.stt_provider or "", None)
        name = label.label if label else "Speech provider"
        await self.send_error(f"{name}: {message}", code="provider_error" if fatal else "provider_warning")

    # ── text-translation buffering (providers without native translation) ──

    async def _buffer_for_translation(
        self, text: str, segment_id: int | None, speaker: str | None, language: str | None = None
    ) -> None:
        if self._pending and (speaker != self._pending_speaker or language != self._pending_language):
            await self._flush_translation()
        self._pending.append((text, segment_id))
        self._pending_speaker = speaker
        self._pending_language = language
        joined = " ".join(t for t, _ in self._pending)
        if len(joined) >= self.translation_trigger_chars or joined.rstrip().endswith(SENTENCE_END):
            await self._flush_translation()
        else:
            self._schedule_flush()

    def _schedule_flush(self) -> None:
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()

        async def later() -> None:
            await asyncio.sleep(self.translation_flush_s)
            await self._flush_translation()

        self._flush_task = asyncio.create_task(later())

    async def _flush_translation(self) -> None:
        if self._flush_task and not self._flush_task.done() and self._flush_task is not asyncio.current_task():
            self._flush_task.cancel()
        if not self._pending:
            return
        text = " ".join(t for t, _ in self._pending)
        ids = [sid for _, sid in self._pending if sid is not None]
        speaker = self._pending_speaker
        language = self._pending_language
        self._pending = []
        await self.queue.put(("translate", text, ids, speaker, language))

    # ── worker: translation + TTS, strictly in order ─────────────────

    async def _worker(self) -> None:
        while True:
            item = await self.queue.get()
            try:
                if item is None:
                    return
                if item[0] == "tts":
                    await self._speak(item[1], item[2])
                elif item[0] == "translate":
                    await self._translate_and_speak(item[1], item[2], item[3], item[4])
            except Exception as exc:  # noqa: BLE001 — never kill the worker
                logger.exception("Session worker error: %s", exc)
            finally:
                self.queue.task_done()

    async def _translate_and_speak(
        self, text: str, segment_ids: list[int], speaker: str | None, language: str | None = None
    ) -> None:
        if not self.open or self.translator is None:
            return
        source = language or self.source_lang  # "auto" when the segment's language is unknown
        try:
            translated = await self.translator.translate(text, source, self.target_lang)
        except Exception as exc:  # noqa: BLE001
            await self.send_warning(f"Translation failed: {exc}")
            return
        if not translated:
            return
        if self.auto_source and _norm(translated) == _norm(text):
            return  # it was already in the target language
        segment_id = segment_ids[-1] if segment_ids else None
        await self.send_json(
            {
                "type": "translated_text",
                "text": translated,
                "segment_id": segment_id,
                "speaker": speaker,
                "source": self.source,
                "language": language,
            }
        )
        if segment_id is not None and self.meeting:
            meeting_store.set_segment_translation(segment_id, translated)
        if self.tts_chain:
            await self._speak(translated, speaker)

    def _tts_client(self, provider_id: str) -> Any:
        client = self._tts_clients.get(provider_id)
        if client is None:
            client = registry.build_tts(provider_id)
            self._tts_clients[provider_id] = client
        return client

    async def _speak(self, text: str, speaker: str | None) -> None:
        if not self.open or not text.strip():
            return
        speaker_num = None
        if speaker and speaker != "me":
            digits = re.findall(r"\d+", speaker)
            speaker_num = digits[0] if digits else None
        gender = getattr(self.stt, "last_speaker_gender", None)
        errors: list[str] = []
        for provider_id in self.tts_chain:
            try:
                audio = await self._tts_client(provider_id).synthesize(
                    text, self.target_lang, speaker_id=speaker_num, gender_hint=gender
                )
            except Exception as exc:  # noqa: BLE001 — try the next provider
                logger.warning("TTS provider %s failed: %s", provider_id, exc)
                errors.append(f"{provider_id}: {exc}")
                continue
            if audio:
                await self.send_bytes(audio)
                return
            errors.append(f"{provider_id}: no audio")
        now = time.time()
        if now - self._last_tts_warning > 30:
            self._last_tts_warning = now
            await self.send_warning("Text-to-speech failed (" + "; ".join(errors)[:300] + ")")

    # ── stop / end / cleanup ─────────────────────────────────────────

    def _drain_queue(self) -> None:
        while True:
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                break

    async def _stop(self, end: bool = False) -> None:
        await self._close_stt()
        self._pending = []
        self._drain_queue()
        await self.send_json({"type": "stopped", "meeting_id": self.meeting["id"] if self.meeting else None})
        if end:
            await self._end_meeting()

    async def _end_meeting(self) -> None:
        if not self.meeting:
            await self.send_json({"type": "meeting_ended", "meeting_id": None})
            return
        meeting_id = self.meeting["id"]
        meeting_store.end_meeting(meeting_id)
        await self.send_json({"type": "meeting_ended", "meeting_id": meeting_id})
        from services import postprocess

        background.spawn(postprocess.finalize_meeting(meeting_id), name=f"finalize-{meeting_id}")

    def _maybe_checkpoint_memory(self) -> None:
        if not self.meeting or not os.getenv("SUPERMEMORY_API_KEY", "").strip():
            return
        now = time.time()
        if now - self._last_memory_checkpoint < self.memory_checkpoint_s:
            return
        self._last_memory_checkpoint = now
        from supermemory import sync

        background.spawn(sync.sync_meeting(self.meeting["id"]), name=f"memory-checkpoint-{self.meeting['id']}")

    async def _close_stt(self) -> None:
        stt, self.stt = self.stt, None
        if stt is not None:
            try:
                await stt.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error closing STT client: %s", exc)

    async def _close_aux(self) -> None:
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()
        clients, self._tts_clients = self._tts_clients, {}
        for client in clients.values():
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        translator, self.translator = self.translator, None
        if translator is not None:
            try:
                await translator.close()
            except Exception:  # noqa: BLE001
                pass

    async def _cleanup(self) -> None:
        self.open = False
        await self._close_stt()
        if self.worker:
            self._drain_queue()
            await self.queue.put(None)
            try:
                await asyncio.wait_for(self.worker, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self.worker.cancel()
        await self._close_aux()
        if self.meeting:
            meeting_store.touch_meeting(self.meeting["id"])
            if os.getenv("SUPERMEMORY_API_KEY", "").strip() and meeting_store.count_segments(self.meeting["id"]):
                from supermemory import sync

                background.spawn(sync.sync_meeting(self.meeting["id"]), name=f"memory-close-{self.meeting['id']}")
        logger.info("Session cleaned up")
