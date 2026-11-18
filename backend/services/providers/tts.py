"""Uniform TTS adapters. Every adapter returns a canonical 16-bit WAV.

synthesize(text, language, *, speaker_id=None, gender_hint=None) -> bytes | None
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable

import httpx

from services.audio_utils import normalize_tts_audio

logger = logging.getLogger("interpreter.tts")


def _base(code: str | None) -> str:
    base = (code or "en").split("-")[0].lower()
    return base or "en"


def _looks_like_mp3(data: bytes) -> bool:
    return data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0)


class AzureTts:
    name = "azure"

    def __init__(self) -> None:
        from services.azure_tts_client import AzureTtsClient

        self._client = AzureTtsClient(
            api_key=os.getenv("AZURE_SPEECH_KEY", ""), region=os.getenv("AZURE_SPEECH_REGION", "eastus")
        )

    async def synthesize(self, text: str, language: str, *, speaker_id: str | None = None, gender_hint: str | None = None) -> bytes | None:
        audio = await self._client.text_to_speech(
            text=text, language=_base(language), gender_hint=gender_hint, speaker_id=speaker_id
        )
        return normalize_tts_audio(audio)

    async def close(self) -> None:
        await self._client.close()


class SonioxTts:
    """Soniox TTS REST: POST https://tts-rt.soniox.com/tts (docs.soniox.com/tts/rest-api)."""

    name = "soniox"

    def __init__(self) -> None:
        self.api_key = os.getenv("SONIOX_API_KEY", "")
        self.url = os.getenv("SONIOX_TTS_URL", "").strip() or "https://tts-rt.soniox.com/tts"
        self.model = os.getenv("SONIOX_TTS_MODEL", "").strip() or "tts-rt-v2"
        voices = os.getenv("SONIOX_TTS_VOICES", "").strip()
        self.voices = [v.strip() for v in voices.split(",") if v.strip()] or [
            os.getenv("SONIOX_TTS_VOICE", "").strip() or "Adrian"
        ]
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))

    def _voice(self, language: str, speaker_id: str | None) -> str:
        per_lang = os.getenv(f"SONIOX_TTS_VOICE_{language.upper()}", "").strip()
        if per_lang:
            return per_lang
        if speaker_id and speaker_id.isdigit():
            return self.voices[(int(speaker_id) - 1) % len(self.voices)]
        return self.voices[0]

    async def synthesize(self, text: str, language: str, *, speaker_id: str | None = None, gender_hint: str | None = None) -> bytes | None:
        if not self.api_key:
            raise ValueError("SONIOX_API_KEY is not set")
        lang = _base(language)
        resp = await self._client.post(
            self.url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "language": lang,
                "voice": self._voice(lang, speaker_id),
                "audio_format": "pcm_s16le",
                "sample_rate": 16000,
                "text": text[:5000],
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Soniox TTS HTTP {resp.status_code}: {resp.text[:200]}")
        if "json" in resp.headers.get("content-type", ""):
            raise RuntimeError(f"Soniox TTS error: {resp.text[:200]}")
        return normalize_tts_audio(resp.content, assume_pcm_rate=16000)

    async def close(self) -> None:
        await self._client.aclose()


# Flux TTS voices, first listed voice per language (developers.deepgram.com/docs/flux-tts/voices).
DEEPGRAM_FLUX_VOICES = {
    "en": "flux-haley-en",
    "es": "flux-aina-es",
    "fr": "flux-arnaud-fr",
    "de": "flux-benjamin-de",
    "it": "flux-angela-it",
    "pt": "flux-bianca-pt",
    "nl": "flux-anouk-nl",
    "ja": "flux-ayumi-ja",
    "hi": "flux-ajay-hi",
    "ru": "flux-andrei-ru",
    "zh": "flux-bo-zh",
    "ko": "flux-eunji-ko",
    "pl": "flux-bartosz-pl",
    "tr": "flux-dilek-tr",
    "sv": "flux-axel-sv",
    "gu": "flux-bhavna-gu",
    "bn": "flux-afsana-bn",
    "ta": "flux-gokul-ta",
    "te": "flux-pavan-te",
    "mr": "flux-pooja-mr",
    "ur": "flux-ambreen-ur",
    "kn": "flux-manjunath-kn",
}


class DeepgramTts:
    """Deepgram Flux TTS REST: POST /v2/speak?model=...&encoding=linear16."""

    name = "deepgram"

    def __init__(self) -> None:
        self.api_key = os.getenv("DEEPGRAM_API_KEY", "")
        self.url = os.getenv("DEEPGRAM_TTS_URL", "").strip() or "https://api.deepgram.com/v2/speak"
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))

    def _model(self, language: str) -> str | None:
        return os.getenv(f"DEEPGRAM_TTS_MODEL_{language.upper()}", "").strip() or DEEPGRAM_FLUX_VOICES.get(language)

    async def synthesize(self, text: str, language: str, *, speaker_id: str | None = None, gender_hint: str | None = None) -> bytes | None:
        if not self.api_key:
            raise ValueError("DEEPGRAM_API_KEY is not set")
        lang = _base(language)
        model = self._model(lang)
        if not model:
            return None
        resp = await self._client.post(
            self.url,
            params={"model": model, "encoding": "linear16", "sample_rate": "16000", "container": "none"},
            headers={"Authorization": f"Token {self.api_key}", "Content-Type": "application/json"},
            json={"text": text},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Deepgram TTS HTTP {resp.status_code}: {resp.text[:200]}")
        return normalize_tts_audio(resp.content, assume_pcm_rate=16000)

    async def close(self) -> None:
        await self._client.aclose()


class MinimaxTts:
    name = "minimax"

    def __init__(self) -> None:
        from services.minimax_client import MinimaxClient

        self._client = MinimaxClient(
            api_key=os.getenv("MINIMAX_API_KEY", ""), group_id=os.getenv("MINIMAX_GROUP_ID", "")
        )

    async def synthesize(self, text: str, language: str, *, speaker_id: str | None = None, gender_hint: str | None = None) -> bytes | None:
        audio = await self._client.text_to_speech(text=text, language=_base(language))
        if not audio:
            return None
        if _looks_like_mp3(audio):
            return audio  # playable in the offscreen player, not injectable into Meet
        return normalize_tts_audio(audio, assume_pcm_rate=self._client.tts_sample_rate)

    async def close(self) -> None:
        await self._client.close()


class SpeechmaticsTts:
    name = "speechmatics"

    def __init__(self) -> None:
        from services.speechmatics_tts_client import SpeechmaticsTTSClient

        self._client = SpeechmaticsTTSClient(api_key=os.getenv("SPEECHMATICS_API_KEY", ""))

    async def synthesize(self, text: str, language: str, *, speaker_id: str | None = None, gender_hint: str | None = None) -> bytes | None:
        audio = await self._client.text_to_speech(text=text, language=_base(language))
        return normalize_tts_audio(audio, assume_pcm_rate=16000)

    async def close(self) -> None:
        await self._client.close()


TTS_BUILDERS: dict[str, Callable[[], Any]] = {
    "azure": AzureTts,
    "soniox": SonioxTts,
    "deepgram": DeepgramTts,
    "minimax": MinimaxTts,
    "speechmatics": SpeechmaticsTts,
}
