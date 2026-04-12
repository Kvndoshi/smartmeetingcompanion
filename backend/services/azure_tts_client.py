"""
Azure Neural TTS client — streaming.

Wraps azure.cognitiveservices.speech.SpeechSynthesizer with:
- Language + speaker -> voice name rotation (multiple distinct voices)
- Streaming synthesis via `synthesizing` event — audio chunks sent to
  the client as they're generated, not after the full sentence completes.
- Cached SpeechConfig to avoid per-call setup overhead.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Awaitable, Callable

import azure.cognitiveservices.speech as speechsdk

logger = logging.getLogger("interpreter.azure_tts")


# Pool of voices per language, ordered so speaker rotation picks distinct ones.
# Index 0 = speaker 1, index 1 = speaker 2, wraps around.
_VOICE_POOL: dict[str, list[str]] = {
    "en": ["en-US-SteffanNeural", "en-US-JennyNeural", "en-US-AriaNeural", "en-US-GuyNeural"],
    "es": ["es-ES-AlvaroNeural", "es-ES-ElviraNeural", "es-MX-JorgeNeural", "es-MX-DaliaNeural"],
    "fr": ["fr-FR-HenriNeural", "fr-FR-DeniseNeural", "fr-CA-JeanNeural", "fr-CA-SylvieNeural"],
    "de": ["de-DE-ConradNeural", "de-DE-KatjaNeural", "de-AT-JonasNeural", "de-AT-IngridNeural"],
    "it": ["it-IT-DiegoNeural", "it-IT-ElsaNeural", "it-IT-GiuseppeNeural", "it-IT-LisandroNeural"],
    "pt": ["pt-BR-AntonioNeural", "pt-BR-FranciscaNeural", "pt-PT-DuarteNeural", "pt-PT-RaquelNeural"],
    "zh": ["zh-CN-YunxiNeural", "zh-CN-XiaoxiaoNeural", "zh-CN-YunjianNeural", "zh-CN-XiaohanNeural"],
    "ja": ["ja-JP-KeitaNeural", "ja-JP-NanamiNeural", "ja-JP-DaichiNeural", "ja-JP-ShioriNeural"],
    "ko": ["ko-KR-InJoonNeural", "ko-KR-SunHiNeural", "ko-KR-BongJinNeural", "ko-KR-GookMinNeural"],
    "hi": ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"],
    "ar": ["ar-SA-HamedNeural", "ar-SA-ZariyahNeural"],
    "ru": ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"],
    # Fallbacks for any unmapped language
}

# Gender-mapped defaults (used when speaker_id is None)
_GENDER_DEFAULTS: dict[tuple[str, str], str] = {
    ("en", "male"): "en-US-SteffanNeural",
    ("en", "female"): "en-US-JennyNeural",
    ("es", "male"): "es-ES-AlvaroNeural",
    ("es", "female"): "es-ES-ElviraNeural",
    ("fr", "male"): "fr-FR-HenriNeural",
    ("fr", "female"): "fr-FR-DeniseNeural",
    ("de", "male"): "de-DE-ConradNeural",
    ("de", "female"): "de-DE-KatjaNeural",
    ("it", "male"): "it-IT-DiegoNeural",
    ("it", "female"): "it-IT-ElsaNeural",
    ("pt", "male"): "pt-BR-AntonioNeural",
    ("pt", "female"): "pt-BR-FranciscaNeural",
    ("zh", "male"): "zh-CN-YunxiNeural",
    ("zh", "female"): "zh-CN-XiaoxiaoNeural",
    ("ja", "male"): "ja-JP-KeitaNeural",
    ("ja", "female"): "ja-JP-NanamiNeural",
    ("ko", "male"): "ko-KR-InJoonNeural",
    ("ko", "female"): "ko-KR-SunHiNeural",
    ("hi", "male"): "hi-IN-MadhurNeural",
    ("hi", "female"): "hi-IN-SwaraNeural",
    ("ar", "male"): "ar-SA-HamedNeural",
    ("ar", "female"): "ar-SA-ZariyahNeural",
    ("ru", "male"): "ru-RU-DmitryNeural",
    ("ru", "female"): "ru-RU-SvetlanaNeural",
}


class AzureTtsClient:
    """Azure Neural TTS — streaming synthesis with multi-speaker voice rotation."""

    def __init__(self, api_key: str, region: str):
        self.api_key = api_key
        self.region = region
        # Cached SpeechConfig — reused across calls, only voice name swapped.
        self._speech_config = speechsdk.SpeechConfig(
            subscription=api_key, region=region
        )
        self._speech_config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm
        )

    def _pick_voice(self, language: str, gender_hint: str | None = None, speaker_id: str | None = None) -> str:
        """Pick a voice for the given language, optionally using speaker rotation."""
        lang = (language or "en").strip().lower()

        # Speaker-specific env override takes highest priority
        if speaker_id and speaker_id.isdigit():
            env_key = f"AZURE_TTS_VOICE_{lang.upper()}_SPEAKER{speaker_id}"
            override = os.getenv(env_key, "").strip()
            if override:
                return override

        # Speaker rotation from the pool (takes priority over gender when speaker is known)
        if speaker_id and speaker_id.isdigit():
            pool = _VOICE_POOL.get(lang, _VOICE_POOL["en"])
            idx = (int(speaker_id) - 1) % len(pool)
            return pool[idx]

        # Gender-based env override
        if gender_hint:
            gender = gender_hint.strip().lower()
            if gender in {"male", "female"}:
                env_key = f"AZURE_TTS_VOICE_{lang.upper()}_{gender.upper()}"
                override = os.getenv(env_key, "").strip()
                if override:
                    return override

        # Gender-based fallback
        gender = (gender_hint or "female").strip().lower()
        if gender not in {"male", "female"}:
            gender = "female"
        voice = _GENDER_DEFAULTS.get((lang, gender))
        if voice:
            return voice

        # Unknown language — use English pool
        pool = _VOICE_POOL["en"]
        return pool[0] if gender == "male" else pool[1]

    async def text_to_speech_streaming(
        self,
        text: str,
        language: str = "en",
        gender_hint: str | None = None,
        speaker_id: str | None = None,
        on_chunk: Callable[[bytes], Awaitable[None]] | None = None,
    ) -> bytes | None:
        """Stream TTS audio. Calls on_chunk with each audio fragment as it arrives.

        If on_chunk is provided, audio chunks are streamed incrementally.
        Always returns the full audio data as well.
        """
        if not text.strip():
            return None
        if not self.api_key or not self.region:
            raise ValueError("Azure TTS requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")

        voice_name = self._pick_voice(language, gender_hint, speaker_id)
        return await asyncio.to_thread(
            self._synthesize_streaming_blocking, text, voice_name, on_chunk
        )

    def _synthesize_streaming_blocking(
        self,
        text: str,
        voice_name: str,
        on_chunk: Callable[[bytes], Awaitable[None]] | None,
    ) -> bytes | None:
        loop = asyncio.get_running_loop() if on_chunk else None

        # Create a fresh synthesizer (cheap) with the shared speech_config.
        # Swap voice name per call.
        self._speech_config.speech_synthesis_voice_name = voice_name
        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=self._speech_config,
            audio_config=None,
        )

        full_audio = bytearray()
        chunk_event = threading.Event()

        def on_synthesizing(evt: speechsdk.SpeechSynthesisEventArgs) -> None:
            chunk = evt.result.audio_data
            if chunk and on_chunk and loop:
                full_audio.extend(chunk)
                asyncio.run_coroutine_threadsafe(on_chunk(bytes(chunk)), loop)

        def on_completed(evt: speechsdk.SpeechSynthesisEventArgs) -> None:
            chunk_event.set()

        def on_canceled(evt: speechsdk.SpeechSynthesisEventArgs) -> None:
            chunk_event.set()

        synthesizer.synthesizing.connect(on_synthesizing)
        synthesizer.synthesis_completed.connect(on_completed)
        synthesizer.synthesis_canceled.connect(on_canceled)

        result = synthesizer.speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            # If streaming was active, full_audio already has all chunks.
            # Otherwise grab from result.
            audio = bytes(full_audio) if full_audio else result.audio_data
            logger.info("Azure TTS streamed %d bytes (voice=%s)", len(audio), voice_name)
            return audio

        if result.reason == speechsdk.ResultReason.Canceled:
            cancellation = result.cancellation_details
            logger.error(
                "Azure TTS canceled: reason=%s error_code=%s details=%s",
                cancellation.reason,
                getattr(cancellation, "error_code", None),
                cancellation.error_details,
            )
            return None

        logger.warning("Azure TTS unexpected result reason: %s", result.reason)
        return None

    async def text_to_speech(
        self,
        text: str,
        language: str = "en",
        gender_hint: str | None = None,
        speaker_id: str | None = None,
    ) -> bytes | None:
        """Non-streaming convenience wrapper."""
        return await self.text_to_speech_streaming(
            text=text,
            language=language,
            gender_hint=gender_hint,
            speaker_id=speaker_id,
            on_chunk=None,
        )

    async def close(self) -> None:
        return None
