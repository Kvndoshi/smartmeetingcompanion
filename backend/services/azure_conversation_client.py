"""
Azure Conversation Transcriber client with speaker diarization.

Uses ConversationTranscriber (not TranslationRecognizer) to get real
speaker IDs (Guest-1, Guest-2, …) via the
SpeechServiceResponse_DiarizeIntermediateResults property.

Because ConversationTranscriber only does STT (not translation), this
client also calls the Azure Translator Text REST API v3.0 for each
final transcript to produce translations.  Partial transcripts are also
translated (throttled) so the user sees translated text in near-real-time
while the speaker is still talking.

Same callback interface as AzureTranslationClient so main.py can swap
providers with one line.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Awaitable, Callable

import azure.cognitiveservices.speech as speechsdk
import httpx

logger = logging.getLogger("interpreter.azure_conversation")

# ── Locale helpers (shared with azure_translation_client) ────────────

_SOURCE_LOCALE_MAP: dict[str, str] = {
    "en": "en-US",
    "es": "es-ES",
    "fr": "fr-FR",
    "de": "de-DE",
    "it": "it-IT",
    "pt": "pt-BR",
    "zh": "zh-CN",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "ar": "ar-SA",
    "hi": "hi-IN",
    "ru": "ru-RU",
    "nl": "nl-NL",
    "sv": "sv-SE",
    "pl": "pl-PL",
    "tr": "tr-TR",
}

# Azure Translator Text API expects short codes or BCP-47.
# zh-Hans covers Simplified Chinese; others pass through.
_TRANSLATOR_LANG_MAP: dict[str, str] = {
    "zh": "zh-Hans",
    "zh-CN": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant",
}


class AzureConversationClient:
    """STT with speaker diarization + text translation via Azure Translator."""

    def __init__(
        self,
        api_key: str,
        region: str,
        language: str = "en",
        target_language: str | None = None,
        on_transcript: Callable[[str, bool], Awaitable[None]] | None = None,
        on_translation: Callable[[str, bool], Awaitable[None]] | None = None,
        on_error: Callable[..., Awaitable[None]] | None = None,
    ):
        self.api_key = api_key
        self.on_error = on_error
        # Translator needs a Translator (or multi-service) key; a Speech-only key 401s.
        self.translator_key = os.getenv("AZURE_TRANSLATOR_KEY", "").strip()
        self.translator_region = os.getenv("AZURE_TRANSLATOR_REGION", "").strip() or region
        self._final_generation = 0
        self.region = region
        self.source_locale = _SOURCE_LOCALE_MAP.get(language, language)
        self.target_lang_code = target_language or "es"
        self.translator_target = _TRANSLATOR_LANG_MAP.get(
            self.target_lang_code, self.target_lang_code
        )
        self.on_transcript = on_transcript
        self.on_translation = on_translation

        self.is_connected = False
        self.last_speaker_gender: str | None = None
        self.last_speaker_id: str | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._push_stream: speechsdk.audio.PushAudioInputStream | None = None
        self._transcriber: speechsdk.transcription.ConversationTranscriber | None = None
        self._http_client: httpx.AsyncClient | None = None

        # Throttle partial translations to avoid hammering the REST API.
        self._last_partial_emit_at: float = 0.0
        self._last_partial_text: str = ""

    async def connect(self) -> None:
        if not self.api_key or not self.region:
            raise ValueError(
                "Azure conversation client requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION"
            )

        self._loop = asyncio.get_running_loop()
        self._http_client = httpx.AsyncClient(timeout=10.0)

        speech_config = speechsdk.SpeechConfig(
            subscription=self.api_key,
            region=self.region,
        )
        speech_config.speech_recognition_language = self.source_locale

        # Enable speaker diarization
        speech_config.set_property(
            property_id=speechsdk.PropertyId.SpeechServiceResponse_DiarizeIntermediateResults,
            value="true",
        )

        segmentation_ms = os.getenv("AZURE_SEGMENTATION_SILENCE_MS", "300").strip() or "300"
        speech_config.set_property(
            speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
            segmentation_ms,
        )
        speech_config.set_property(
            speechsdk.PropertyId.SpeechServiceResponse_RequestDetailedResultTrueFalse,
            "true",
        )
        speech_config.output_format = speechsdk.OutputFormat.Detailed

        audio_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=16000,
            bits_per_sample=16,
            channels=1,
        )
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)

        self._transcriber = speechsdk.transcription.ConversationTranscriber(
            speech_config=speech_config,
            audio_config=audio_config,
        )

        self._transcriber.transcribing.connect(self._on_transcribing)
        self._transcriber.transcribed.connect(self._on_transcribed)
        self._transcriber.canceled.connect(self._on_canceled)
        self._transcriber.session_stopped.connect(self._on_session_stopped)

        # .get() blocks; run it off the event loop.
        await asyncio.get_running_loop().run_in_executor(
            None, lambda: self._transcriber.start_transcribing_async().get()
        )
        self.is_connected = True
        logger.info(
            "Azure conversation transcriber connected (source=%s segmentation=%sms)",
            self.source_locale,
            segmentation_ms,
        )

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if not self.is_connected or self._push_stream is None:
            return
        try:
            self._push_stream.write(pcm_bytes)
        except (RuntimeError, OSError) as e:
            logger.error("Azure push_stream.write failed: %s", e)
            self.is_connected = False

    async def close(self) -> None:
        if not self.is_connected and self._transcriber is None:
            return
        self.is_connected = False
        try:
            if self._push_stream is not None:
                self._push_stream.close()
        except (RuntimeError, OSError):
            pass
        try:
            if self._transcriber is not None:
                transcriber = self._transcriber
                await asyncio.get_running_loop().run_in_executor(
                    None, lambda: transcriber.stop_transcribing_async().get()
                )
        except (RuntimeError, OSError) as e:
            logger.warning("Azure stop_transcribing error: %s", e)
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
        self._push_stream = None
        self._transcriber = None
        logger.info("Azure conversation transcriber closed")

    # ── SDK callbacks (called from background thread) ────────────────

    def _on_transcribing(self, evt) -> None:
        """Partial recognition — emit transcript and translate (throttled)."""
        text = evt.result.text or ""
        if not text.strip():
            return
        speaker_id = self._extract_speaker_id(evt)
        if speaker_id:
            self.last_speaker_id = speaker_id
        self._update_gender(evt)
        if self._loop and self.on_transcript:
            asyncio.run_coroutine_threadsafe(
                self.on_transcript(text, False, speaker=speaker_id or self.last_speaker_id),
                self._loop,
            )
        # Throttled partial translation: translate every ~400ms or when text
        # grows by 10+ chars so the user sees translations while still speaking.
        if self._loop and self.on_translation and self._http_client:
            now = time.monotonic()
            delta_chars = len(text) - len(self._last_partial_text)
            if (
                now - self._last_partial_emit_at >= 0.4
                and delta_chars >= 6
            ):
                self._last_partial_emit_at = now
                self._last_partial_text = text
                asyncio.run_coroutine_threadsafe(
                    self._translate_and_emit_partial(text, self._final_generation),
                    self._loop,
                )

    def _on_transcribed(self, evt) -> None:
        """Final recognition — emit transcript AND translate."""
        if evt.result.reason != speechsdk.ResultReason.RecognizedSpeech:
            return
        text = evt.result.text or ""
        if not text.strip():
            return

        speaker_id = self._extract_speaker_id(evt)
        if speaker_id:
            self.last_speaker_id = speaker_id
        self._update_gender(evt)

        if self._loop is None:
            return

        self._final_generation += 1
        self._last_partial_text = ""
        # Emit final transcript
        if self.on_transcript:
            asyncio.run_coroutine_threadsafe(
                self.on_transcript(text, True, speaker=speaker_id or self.last_speaker_id),
                self._loop,
            )

        # Translate via REST API and emit translation
        if self.on_translation and self._http_client:
            asyncio.run_coroutine_threadsafe(
                self._translate_and_emit(text),
                self._loop,
            )

    def _on_canceled(self, evt) -> None:
        logger.error(
            "Azure conversation transcriber canceled: reason=%s error_code=%s details=%s",
            evt.reason,
            getattr(evt, "error_code", None),
            evt.error_details if hasattr(evt, "error_details") else "",
        )
        self.is_connected = False
        if (
            getattr(evt, "reason", None) == speechsdk.CancellationReason.Error
            and self.on_error
            and self._loop
        ):
            details = getattr(evt, "error_details", "") or "recognition canceled"
            asyncio.run_coroutine_threadsafe(self.on_error(details), self._loop)

    def _on_session_stopped(self, _evt) -> None:
        logger.info("Azure conversation transcriber session stopped")
        self.is_connected = False

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _extract_speaker_id(evt) -> str | None:
        """Extract speaker ID from ConversationTranscriber event.

        The SDK puts SpeakerId directly on the result for ConversationTranscriber.
        """
        # Primary path: direct property on the event result
        speaker_id = getattr(evt.result, "speaker_id", None)
        if speaker_id and speaker_id.strip() and speaker_id != "Unknown":
            return speaker_id.strip()
        # Fallback: parse from JSON
        raw = evt.result.properties.get(
            speechsdk.PropertyId.SpeechServiceResponse_JsonResult
        )
        if raw:
            return AzureConversationClient._parse_speaker_id_from_json(raw)
        return None

    @staticmethod
    def _parse_speaker_id_from_json(raw_json: str) -> str | None:
        if not raw_json:
            return None
        try:
            payload = json.loads(raw_json)
        except (ValueError, TypeError):
            return None
        if not isinstance(payload, dict):
            return None
        # Direct SpeakerId field
        sid = payload.get("SpeakerId")
        if isinstance(sid, str) and sid.strip() and sid.strip() != "Unknown":
            return sid.strip()
        # Inside NBest
        nbest = payload.get("NBest")
        if isinstance(nbest, list) and nbest:
            first = nbest[0]
            if isinstance(first, dict):
                sid = first.get("SpeakerId")
                if isinstance(sid, str) and sid.strip() and sid.strip() != "Unknown":
                    return sid.strip()
        return None

    def _update_gender(self, evt) -> None:
        raw = evt.result.properties.get(
            speechsdk.PropertyId.SpeechServiceResponse_JsonResult
        )
        if not raw:
            return
        gender = self._parse_gender(raw)
        if gender:
            self.last_speaker_gender = gender

    @staticmethod
    def _parse_gender(raw_json: str) -> str | None:
        if not raw_json:
            return None
        try:
            payload = json.loads(raw_json)
        except (ValueError, TypeError):
            return None
        candidates: list[str] = []
        if isinstance(payload, dict):
            if isinstance(payload.get("Gender"), str):
                candidates.append(payload["Gender"])
            nbest = payload.get("NBest")
            if isinstance(nbest, list) and nbest:
                first = nbest[0]
                if isinstance(first, dict) and isinstance(first.get("Gender"), str):
                    candidates.append(first["Gender"])
        for raw in candidates:
            normalized = raw.strip().lower()
            if normalized in {"male", "female"}:
                return normalized
        return None

    async def _translate_and_emit(self, text: str) -> None:
        """Call Azure Translator Text REST API and emit the translation."""
        if not text.strip() or not self._http_client:
            return
        try:
            translated = await self._call_translator(text)
            if translated and self.on_translation and self._loop:
                await self.on_translation(translated, True)
        except Exception as e:
            logger.error("Translation API error: %s", e)

    async def _translate_and_emit_partial(self, text: str, generation: int = 0) -> None:
        """Translate a partial transcript and emit as a non-final translation."""
        if not text.strip() or not self._http_client:
            return
        try:
            translated = await self._call_translator(text)
            # Drop partials that resolve after the utterance's final was emitted.
            if generation != self._final_generation:
                return
            if translated and self.on_translation and self._loop:
                await self.on_translation(translated, False)
        except Exception:
            pass  # Partial failures are fine — the final will succeed.

    async def _call_translator(self, text: str) -> str | None:
        """Azure Translator Text API v3.0 — translate a single string."""
        query = (
            f"?api-version=3.0"
            f"&from={self.source_locale.split('-')[0]}"
            f"&to={self.translator_target}"
        )
        headers = {
            "Content-Type": "application/json",
            "X-ClientTraceId": str(uuid.uuid4()),
        }
        if self.translator_key:
            # Dedicated Translator resource → global endpoint + region header.
            endpoint = "https://api.cognitive.microsofttranslator.com/translate" + query
            headers["Ocp-Apim-Subscription-Key"] = self.translator_key
            if self.translator_region:
                headers["Ocp-Apim-Subscription-Region"] = self.translator_region
        else:
            # Multi-service Azure AI resource → regional endpoint with the speech key.
            endpoint = (
                f"https://{self.region}.api.cognitive.microsoft.com/translator/text/v3.0/translate" + query
            )
            headers["Ocp-Apim-Subscription-Key"] = self.api_key
        body = [{"text": text}]

        resp = await self._http_client.post(endpoint, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

        if isinstance(data, list) and data:
            translations = data[0].get("translations", [])
            if translations:
                return translations[0].get("text", "")
        return None
