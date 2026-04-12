"""Unit tests for AzureTtsClient pure helpers."""

from __future__ import annotations

import pytest

from services.azure_tts_client import AzureTtsClient


@pytest.fixture
def client() -> AzureTtsClient:
    return AzureTtsClient(api_key="dummy", region="eastus")


@pytest.mark.parametrize(
    "language,gender,expected",
    [
        ("en", "male", "en-US-SteffanNeural"),
        ("en", "female", "en-US-JennyNeural"),
        ("en", None, "en-US-JennyNeural"),
        ("es", "male", "es-ES-AlvaroNeural"),
        ("es", "female", "es-ES-ElviraNeural"),
        ("es", None, "es-ES-ElviraNeural"),
        ("zh", "male", "zh-CN-YunxiNeural"),
        ("zh", "female", "zh-CN-XiaoxiaoNeural"),
        ("fr", "female", "fr-FR-DeniseNeural"),
        ("de", "male", "de-DE-ConradNeural"),
        ("ja", "female", "ja-JP-NanamiNeural"),
    ],
)
def test_pick_voice_defaults(client: AzureTtsClient, language: str, gender, expected: str):
    assert client._pick_voice(language, gender) == expected


def test_pick_voice_unknown_lang_falls_back_to_english(client: AzureTtsClient):
    assert client._pick_voice("xx", "male") == "en-US-SteffanNeural"


def test_pick_voice_env_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AZURE_TTS_VOICE_EN_FEMALE", "en-US-AriaNeural")
    client = AzureTtsClient(api_key="dummy", region="eastus")
    assert client._pick_voice("en", "female") == "en-US-AriaNeural"
    assert client._pick_voice("en", "male") == "en-US-SteffanNeural"


def test_pick_voice_case_insensitive_gender(client: AzureTtsClient):
    assert client._pick_voice("en", "MALE") == "en-US-SteffanNeural"
    assert client._pick_voice("en", "Female") == "en-US-JennyNeural"


def test_speaker_rotation_en(client: AzureTtsClient):
    # Speaker 1 → pool[0] = Steffan, Speaker 2 → pool[1] = Jenny
    assert client._pick_voice("en", speaker_id="1") == "en-US-SteffanNeural"
    assert client._pick_voice("en", speaker_id="2") == "en-US-JennyNeural"
    assert client._pick_voice("en", speaker_id="3") == "en-US-AriaNeural"
    assert client._pick_voice("en", speaker_id="4") == "en-US-GuyNeural"
    # Wraps around
    assert client._pick_voice("en", speaker_id="5") == "en-US-SteffanNeural"


def test_speaker_rotation_zh(client: AzureTtsClient):
    assert client._pick_voice("zh", speaker_id="1") == "zh-CN-YunxiNeural"
    assert client._pick_voice("zh", speaker_id="2") == "zh-CN-XiaoxiaoNeural"


def test_speaker_rotation_ignores_gender_when_speaker_set(client: AzureTtsClient):
    # When speaker_id is given, pool rotation takes priority over gender
    assert client._pick_voice("en", gender_hint="female", speaker_id="1") == "en-US-SteffanNeural"
