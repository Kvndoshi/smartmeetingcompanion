"""Fake STT/TTS providers and an isolated environment for tests (zero API keys)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from services.audio_utils import pcm_to_wav

FAKE_WAV = pcm_to_wav(b"\x01\x00" * 1600)

ALL_KEY_VARS = [
    "SONIOX_API_KEY", "DEEPGRAM_API_KEY", "SPEECHMATICS_API_KEY", "AZURE_SPEECH_KEY",
    "AZURE_TRANSLATOR_KEY", "MINIMAX_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
    "SUPERMEMORY_API_KEY", "STT_PROVIDER", "TTS_PROVIDER", "LLM_PROVIDER",
    "TRANSLATION_PROVIDER", "LLM_TRANSLATION_PROVIDER",
]


@dataclass
class Fakes:
    fail_connect: bool = False
    native_translation: bool = True
    script: list[tuple] = field(default_factory=list)
    close_script: list[tuple] = field(default_factory=list)  # emitted from close(), like a provider flush
    last_stt: Any = None
    stts: list[Any] = field(default_factory=list)
    tts_calls: list[tuple[str, str]] = field(default_factory=list)


class FakeStt:
    def __init__(self, fakes: Fakes, language: str, target: str | None, cb: Any) -> None:
        self.fakes = fakes
        self.language = language
        self.target = target
        self.cb = cb
        self.is_connected = False
        self.closed = False
        self.audio: list[bytes] = []
        self._emitted = False
        fakes.last_stt = self
        fakes.stts.append(self)

    async def connect(self) -> None:
        if self.fakes.fail_connect:
            raise ValueError("Fake STT requires FAKE_KEY")
        self.is_connected = True

    async def send_audio(self, data: bytes) -> None:
        self.audio.append(data)
        if self._emitted:
            return
        self._emitted = True
        script = self.fakes.script or [
            ("transcript", "hello", False, "1"),
            ("transcript", "hello world", True, "1"),
            ("translation", "hola mundo", True, "1"),
        ]
        for kind, text, is_final, speaker in script:
            if kind == "transcript":
                await self.cb.on_transcript(text, is_final, speaker=speaker, start_ms=0, end_ms=900)
            elif kind == "translation" and self.cb.on_translation:
                await self.cb.on_translation(text, is_final, speaker=speaker)

    async def close(self) -> None:
        for kind, text, is_final, speaker in self.fakes.close_script:
            if kind == "transcript":
                await self.cb.on_transcript(text, is_final, speaker=speaker, start_ms=1000, end_ms=1900)
        self.closed = True
        self.is_connected = False


class FakeTts:
    def __init__(self, fakes: Fakes) -> None:
        self.fakes = fakes

    async def synthesize(self, text: str, language: str, **_: Any) -> bytes:
        self.fakes.tts_calls.append((text, language))
        return FAKE_WAV

    async def close(self) -> None:
        return None


def install_fakes(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Fakes:
    import main  # noqa: F401 — import first so its load_dotenv runs before we scrub env
    from services import meeting_store, profile_store
    from services.providers import registry, tts

    for var in ALL_KEY_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("FAKE_KEY", "x")
    monkeypatch.setenv("STT_PROVIDER", "fake")
    monkeypatch.setenv("TTS_PROVIDER", "fake")

    fakes = Fakes()
    stt_spec = registry.ProviderSpec("fake", "Fake STT", ("FAKE_KEY",), diarization=True, native_translation=True)
    monkeypatch.setitem(registry.STT_SPECS, "fake", stt_spec)
    monkeypatch.setitem(registry.STT_BUILDERS, "fake", lambda lang, target, cb: FakeStt(fakes, lang, target, cb))
    monkeypatch.setitem(registry.TTS_SPECS, "fake", registry.ProviderSpec("fake", "Fake TTS", ("FAKE_KEY",)))
    monkeypatch.setitem(tts.TTS_BUILDERS, "fake", lambda: FakeTts(fakes))

    db = tmp_path / "test.db"
    monkeypatch.setattr(meeting_store, "DB_PATH", db)
    monkeypatch.setattr(profile_store, "DB_PATH", db)
    meeting_store.reset_connections()
    monkeypatch.setattr(main, "ENV_PATH", tmp_path / ".env")
    return fakes
