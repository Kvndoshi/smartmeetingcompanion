"""Shared fixtures: isolated env + DB, fake providers, fake LLM (zero API keys)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.fakes import install_fakes


class FakeLLM:
    """Stands in for OpenAICompatLLM. `responses` feed complete(); `chunks` feed stream()."""

    provider = "fake"
    model = "fake-model"

    def __init__(self, responses: list[str] | None = None, chunks: list[str] | None = None) -> None:
        self.responses = list(responses or [])
        self.chunks = list(chunks or ["Alice ", "owns the ", "budget [00:05]."])
        self.calls: list[list[dict[str, str]]] = []
        self.closed = 0

    async def complete(self, messages, **_: Any) -> str:
        self.calls.append(messages)
        if self.responses:
            return self.responses.pop(0)
        return json.dumps(SAMPLE_SUMMARY)

    async def stream(self, messages, **_: Any):
        self.calls.append(messages)
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed += 1


SAMPLE_SUMMARY = {
    "title": "Q3 budget review",
    "overview": "The team reviewed the Q3 budget and agreed on the launch date.",
    "key_points": ["Budget is 10% under plan"],
    "decisions": ["Launch moves to October 3"],
    "action_items": [{"task": "Send the revised budget", "owner": "Alice", "due": "Friday"}],
    "open_questions": ["Do we need a second vendor?"],
    "topics": [{"title": "Budget", "timestamp": "00:05", "summary": "Budget status"}],
    "next_steps": ["Meet again next Tuesday"],
}


_PROVIDER_PREFIXES = ("SONIOX_", "DEEPGRAM_", "SPEECHMATICS_", "AZURE_", "MINIMAX_", "GEMINI_", "GROQ_", "SUPERMEMORY_")
_TUNING_VARS = (
    "STT_PROVIDER", "TTS_PROVIDER", "LLM_PROVIDER", "TRANSLATION_PROVIDER", "LLM_TRANSLATION_PROVIDER",
    "AUTO_SUMMARY", "SUMMARY_LANGUAGE", "TRANSLATION_TRIGGER_CHAR_THRESHOLD", "TRANSLATION_FLUSH_MS",
    "TRANSLATION_PARTIAL_MIN_DELTA_CHARS", "TRANSLATION_PARTIAL_MIN_INTERVAL_MS", "MEMORY_CHECKPOINT_SECONDS",
    "USE_SPEECHMATICS_TRANSLATION", "ALLOWED_ORIGIN_REGEX",
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch):
    """Tests never see the developer's backend/.env keys or tuning (restored afterwards)."""
    import os

    import main  # noqa: F401 — its load_dotenv() must run before we scrub

    for name in list(os.environ):
        if name.startswith(_PROVIDER_PREFIXES) or name in _TUNING_VARS:
            monkeypatch.delenv(name)


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch, tmp_path):
    return install_fakes(monkeypatch, tmp_path)


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch, fakes) -> FakeLLM:
    """Route every build_llm() call to one FakeLLM and mark an LLM as configured."""
    from services.providers import registry

    llm = FakeLLM()
    monkeypatch.setenv("GROQ_API_KEY", "test-groq")
    monkeypatch.setattr(registry, "build_llm", lambda provider=None, fast=False: llm)
    return llm


@pytest.fixture
def client(fakes):
    import main

    with TestClient(main.app) as c:
        c.fakes = fakes  # type: ignore[attr-defined]
        yield c


def make_meeting(segments: list[tuple[str | None, str]] | None = None, **kwargs: Any) -> dict[str, Any]:
    """Create a meeting with (speaker, text) segments, 5 s apart."""
    from services import meeting_store

    kwargs.setdefault("tab_url", "https://meet.google.com/abc-defg-hij")
    kwargs.setdefault("tab_title", "Meet - abc-defg-hij")
    meeting = meeting_store.create_meeting(**kwargs)
    for i, (speaker, text) in enumerate(segments or []):
        meeting_store.add_segment(meeting["id"], text=text, speaker=speaker, start_ms=i * 5000, end_ms=i * 5000 + 4000)
    return meeting_store.get_meeting(meeting["id"])  # type: ignore[return-value]


def parse_sse(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
