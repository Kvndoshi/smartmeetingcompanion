"""
Azure Neural TTS client.

Wraps azure.cognitiveservices.speech.SpeechSynthesizer with a
language + gender -> voice name picker and a simple async
`text_to_speech(text, language, gender_hint)` method.
"""

from __future__ import annotations

import asyncio
import logging
import os

import azure.cognitiveservices.speech as speechsdk

logger = logging.getLogger("interpreter.azure_tts")


_DEFAULT_VOICE_MAP: dict[tuple[str, str], str] = {
    ("en", "male"):   "en-US-SteffanNeural",
    ("en", "female"): "en-US-JennyNeural",
    ("es", "male"):   "es-ES-AlvaroNeural",
    ("es", "female"): "es-ES-ElviraNeural",
    ("fr", "male"):   "fr-FR-HenriNeural",
    ("fr", "female"): "fr-FR-DeniseNeural",
    ("de", "male"):   "de-DE-ConradNeural",
    ("de", "female"): "de-DE-KatjaNeural",
    ("it", "male"):   "it-IT-DiegoNeural",
    ("it", "female"): "it-IT-ElsaNeural",
    ("pt", "male"):   "pt-BR-AntonioNeural",
    ("pt", "female"): "pt-BR-FranciscaNeural",
    ("zh", "male"):   "zh-CN-YunxiNeural",
    ("zh", "female"): "zh-CN-XiaoxiaoNeural",
    ("ja", "male"):   "ja-JP-KeitaNeural",
    ("ja", "female"): "ja-JP-NanamiNeural",
    ("ko", "male"):   "ko-KR-InJoonNeural",
    ("ko", "female"): "ko-KR-SunHiNeural",
    ("hi", "male"):   "hi-IN-MadhurNeural",
    ("hi", "female"): "hi-IN-SwaraNeural",
    ("ar", "male"):   "ar-SA-HamedNeural",
    ("ar", "female"): "ar-SA-ZariyahNeural",
    ("ru", "male"):   "ru-RU-DmitryNeural",
    ("ru", "female"): "ru-RU-SvetlanaNeural",
}


class AzureTtsClient:
    """Azure Neural TTS wrapper.

    Accepts (language, gender_hint) and returns synthesized audio bytes.
    Voice selection is data-driven: defaults baked in per
    (language, gender), overridable per-pair via env var
    AZURE_TTS_VOICE_<LANG>_<GENDER>, e.g. AZURE_TTS_VOICE_EN_FEMALE.
    """

    def __init__(self, api_key: str, region: str):
        self.api_key = api_key
        self.region = region

    def _pick_voice(self, language: str, gender_hint: str | None) -> str:
        lang = (language or "en").strip().lower()
        gender = (gender_hint or "female").strip().lower()
        if gender not in {"male", "female"}:
            gender = "female"

        env_key = f"AZURE_TTS_VOICE_{lang.upper()}_{gender.upper()}"
        override = os.getenv(env_key, "").strip()
        if override:
            return override

        voice = _DEFAULT_VOICE_MAP.get((lang, gender))
        if voice:
            return voice

        return _DEFAULT_VOICE_MAP[("en", gender)]

    async def text_to_speech(
        self,
        text: str,
        language: str = "en",
        gender_hint: str | None = None,
    ) -> bytes | None:
        """Synthesize text into WAV/PCM bytes using Azure Neural TTS.

        Runs the sync Speech SDK call on a worker thread so it doesn't
        block the FastAPI event loop.
        """
        if not text.strip():
            return None
        if not self.api_key or not self.region:
            raise ValueError("Azure TTS requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")

        voice_name = self._pick_voice(language, gender_hint)
        return await asyncio.to_thread(self._synthesize_blocking, text, voice_name)

    def _synthesize_blocking(self, text: str, voice_name: str) -> bytes | None:
        speech_config = speechsdk.SpeechConfig(subscription=self.api_key, region=self.region)
        speech_config.speech_synthesis_voice_name = voice_name
        speech_config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
        )

        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=speech_config,
            audio_config=None,
        )
        result = synthesizer.speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logger.info(
                "Azure TTS synthesized %d bytes (voice=%s)",
                len(result.audio_data),
                voice_name,
            )
            return result.audio_data

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

    async def close(self) -> None:
        return None
