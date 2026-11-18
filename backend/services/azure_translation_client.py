"""
Azure Speech Translation client.

Wraps azure.cognitiveservices.speech.translation.TranslationRecognizer
with the same callback shape as SpeechmaticsClient, so main.py can
switch providers with a single line change.

Key points:
- PushAudioInputStream is fed from `send_audio(pcm_bytes)`.
- The SDK is sync/callback-based; we marshal every callback back to
  the caller's asyncio loop via run_coroutine_threadsafe.
- Best-effort speaker gender is captured from each recognition event
  and exposed via `self.last_speaker_gender` for the TTS layer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Awaitable, Callable

import azure.cognitiveservices.speech as speechsdk

logger = logging.getLogger("interpreter.azure_translation")


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
    "gu": "gu-IN",
    "bn": "bn-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "mr": "mr-IN",
    "ur": "ur-IN",
    "pa": "pa-IN",
    "kn": "kn-IN",
    "ml": "ml-IN",
}

_TARGET_LANG_MAP: dict[str, str] = {code: code for code in _SOURCE_LOCALE_MAP.keys()}
_TARGET_LANG_MAP["zh"] = "zh-Hans"

# Default voices for server-side TTS synthesis (one per target language).
_SYNTHESIS_VOICES: dict[str, str] = {
    "en": "en-US-JennyNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "hi": "hi-IN-SwaraNeural",
    "ar": "ar-SA-ZariyahNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "nl": "nl-NL-ColetteNeural",
    "sv": "sv-SE-SofieNeural",
    "pl": "pl-PL-AgnieszkaNeural",
    "tr": "tr-TR-EmelNeural",
    "gu": "gu-IN-DhwaniNeural",
    "bn": "bn-IN-TanishaaNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-ShrutiNeural",
    "mr": "mr-IN-AarohiNeural",
    "ur": "ur-IN-GulNeural",
    "pa": "pa-IN-VaaniNeural",
    "kn": "kn-IN-SapnaNeural",
    "ml": "ml-IN-SobhanaNeural",
}


class AzureTranslationClient:
    """Streaming STT + translation against Azure Speech Services.

    When ``on_audio`` is provided, the TranslationRecognizer also performs
    server-side TTS synthesis: the ``Synthesizing`` event streams audio
    chunks of the *translated* text directly, eliminating a separate TTS
    round-trip.  Set ``has_builtin_tts`` so the caller can skip external TTS.
    """

    def __init__(
        self,
        api_key: str,
        region: str,
        language: str = "en",
        target_language: str | None = None,
        on_transcript: Callable[[str, bool], Awaitable[None]] | None = None,
        on_translation: Callable[[str, bool], Awaitable[None]] | None = None,
        on_audio: Callable[[bytes], Awaitable[None]] | None = None,
        on_error: Callable[..., Awaitable[None]] | None = None,
    ):
        self.api_key = api_key
        self.on_error = on_error
        self.region = region
        self.source_locale = _SOURCE_LOCALE_MAP.get(language, language)
        self.target_lang = _TARGET_LANG_MAP.get(target_language, target_language) if target_language else None
        self.on_transcript = on_transcript
        self.on_translation = on_translation
        self.on_audio = on_audio
        self.has_builtin_tts: bool = on_audio is not None
        self._raw_target_lang: str = target_language or "en"

        self.is_connected = False
        self.last_speaker_gender: str | None = None
        self.last_speaker_id: str | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._push_stream: speechsdk.audio.PushAudioInputStream | None = None
        self._recognizer: speechsdk.translation.TranslationRecognizer | None = None

    async def connect(self) -> None:
        if not self.api_key or not self.region:
            raise ValueError("Azure translation requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")
        if not self.target_lang:
            raise ValueError("Azure translation requires a target_language")

        self._loop = asyncio.get_running_loop()

        translation_config = speechsdk.translation.SpeechTranslationConfig(
            subscription=self.api_key,
            region=self.region,
        )
        translation_config.speech_recognition_language = self.source_locale
        translation_config.add_target_language(self.target_lang)

        segmentation_ms = os.getenv("AZURE_SEGMENTATION_SILENCE_MS", "300").strip() or "300"
        translation_config.set_property(
            speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
            segmentation_ms,
        )
        translation_config.set_property(
            speechsdk.PropertyId.SpeechServiceResponse_RequestDetailedResultTrueFalse,
            "true",
        )
        translation_config.output_format = speechsdk.OutputFormat.Detailed

        # ── Server-side TTS synthesis ──────────────────────────────────
        # When voice_name is set, Azure synthesizes the translated text
        # and fires the Synthesizing event with streaming audio chunks.
        # This collapses STT → translate → TTS into one server call.
        if self.on_audio:
            voice = self._pick_synthesis_voice()
            translation_config.voice_name = voice
            translation_config.set_property(
                speechsdk.PropertyId.SpeechServiceConnection_SynthOutputFormat,
                "raw-16khz-16bit-mono-pcm",
            )

        audio_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=16000,
            bits_per_sample=16,
            channels=1,
        )
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)

        self._recognizer = speechsdk.translation.TranslationRecognizer(
            translation_config=translation_config,
            audio_config=audio_config,
        )

        self._recognizer.recognizing.connect(self._on_recognizing)
        self._recognizer.recognized.connect(self._on_recognized)
        self._recognizer.canceled.connect(self._on_canceled)
        self._recognizer.session_stopped.connect(self._on_session_stopped)

        # Subscribe to synthesis events for streaming audio
        if self.on_audio:
            self._recognizer.synthesizing.connect(self._on_synthesizing)

        # The sync start call blocks until the session opens; keep it off the loop.
        recognizer = self._recognizer
        await asyncio.get_running_loop().run_in_executor(None, recognizer.start_continuous_recognition)
        self.is_connected = True
        logger.info(
            "Azure translation connected (source=%s target=%s segmentation=%sms synthesis=%s)",
            self.source_locale,
            self.target_lang,
            segmentation_ms,
            self._pick_synthesis_voice() if self.on_audio else "off",
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
        if not self.is_connected and self._recognizer is None:
            return
        self.is_connected = False
        try:
            if self._push_stream is not None:
                self._push_stream.close()
        except (RuntimeError, OSError):
            pass
        try:
            if self._recognizer is not None:
                recognizer = self._recognizer
                await asyncio.get_running_loop().run_in_executor(None, recognizer.stop_continuous_recognition)
        except (RuntimeError, OSError) as e:
            logger.warning("Azure stop_continuous_recognition error: %s", e)
        self._push_stream = None
        self._recognizer = None
        logger.info("Azure translation closed")

    def _on_recognizing(self, evt) -> None:
        transcript = evt.result.text or ""
        translation = ""
        if self.target_lang and evt.result.translations:
            translation = evt.result.translations.get(self.target_lang, "") or ""
        self._update_gender_from_event(evt)
        self._emit(transcript, translation, is_final=False)

    def _on_recognized(self, evt) -> None:
        if evt.result.reason != speechsdk.ResultReason.TranslatedSpeech:
            return
        transcript = evt.result.text or ""
        translation = ""
        if self.target_lang and evt.result.translations:
            translation = evt.result.translations.get(self.target_lang, "") or ""
        self._update_gender_from_event(evt)
        self._emit(transcript, translation, is_final=True)

    def _on_canceled(self, evt) -> None:
        logger.error(
            "Azure translation canceled: reason=%s error_code=%s details=%s",
            evt.reason,
            getattr(evt, "error_code", None),
            evt.error_details,
        )
        self.is_connected = False
        if (
            getattr(evt, "reason", None) == speechsdk.CancellationReason.Error
            and self.on_error
            and self._loop
        ):
            asyncio.run_coroutine_threadsafe(
                self.on_error(evt.error_details or "recognition canceled"), self._loop
            )

    def _on_session_stopped(self, _evt) -> None:
        logger.info("Azure translation session stopped")
        self.is_connected = False

    def _update_gender_from_event(self, evt) -> None:
        raw = evt.result.properties.get(
            speechsdk.PropertyId.SpeechServiceResponse_JsonResult
        )
        raw_str = raw or ""
        gender = self._parse_gender(raw_str)
        if gender:
            self.last_speaker_gender = gender
        speaker_id = self._parse_speaker_id(raw_str)
        if speaker_id:
            self.last_speaker_id = speaker_id

    def _on_synthesizing(self, evt) -> None:
        """Stream synthesized audio chunks to the client in real-time."""
        try:
            audio = evt.result.audio if hasattr(evt.result, "audio") else None
            if audio and len(audio) > 0 and self.on_audio and self._loop:
                asyncio.run_coroutine_threadsafe(
                    self.on_audio(audio),
                    self._loop,
                )
        except Exception as e:
            logger.error("Synthesizing event error: %s", e)

    def _pick_synthesis_voice(self) -> str:
        """Pick a TTS voice for the target language."""
        lang = self._raw_target_lang.lower()
        if lang.startswith("zh"):
            lang = "zh"
        return _SYNTHESIS_VOICES.get(lang, "en-US-JennyNeural")

    def _emit(self, transcript: str, translation: str, is_final: bool) -> None:
        if self._loop is None:
            return
        speaker = self.last_speaker_id
        if transcript and self.on_transcript is not None:
            asyncio.run_coroutine_threadsafe(
                self.on_transcript(transcript, is_final, speaker=speaker),
                self._loop,
            )
        if translation and self.on_translation is not None:
            asyncio.run_coroutine_threadsafe(
                self.on_translation(translation, is_final, speaker=speaker),
                self._loop,
            )

    @staticmethod
    def _parse_gender(raw_json: str) -> str | None:
        """Best-effort speaker gender extraction from an Azure result JSON blob."""
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

    @staticmethod
    def _parse_speaker_id(raw_json: str) -> str | None:
        """Best-effort speaker ID extraction from Azure detailed JSON result."""
        if not raw_json:
            return None
        try:
            payload = json.loads(raw_json)
        except (ValueError, TypeError):
            return None
        if not isinstance(payload, dict):
            return None
        sid = payload.get("SpeakerId")
        if isinstance(sid, str) and sid.strip():
            return sid.strip()
        # Some results put it inside NBest
        nbest = payload.get("NBest")
        if isinstance(nbest, list) and nbest:
            first = nbest[0]
            if isinstance(first, dict):
                sid = first.get("SpeakerId")
                if isinstance(sid, str) and sid.strip():
                    return sid.strip()
        return None
