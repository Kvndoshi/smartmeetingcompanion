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
        ("en", "male", "en-US-AndrewNeural"),
        ("en", "female", "en-US-AvaNeural"),
        ("en", None, "en-US-AvaNeural"),
        ("es", "male", "es-ES-AlvaroNeural"),
        ("es", "female", "es-ES-ElviraNeural"),
        ("es", None, "es-ES-ElviraNeural"),
        ("zh", "male", "zh-CN-YunxiNeural"),
        ("zh", "female", "zh-CN-XiaoxiaoNeural"),
        ("fr", "female", "fr-FR-DeniseNeural"),
        ("de", "male", "de-DE-ConradNeural"),
        ("ja", "female", "ja-JP-NanamiNeural"),
        ("nl", "female", "nl-NL-ColetteNeural"),
        ("tr", "male", "tr-TR-AhmetNeural"),
        ("pt-BR", "female", "pt-BR-FranciscaNeural"),
    ],
)
def test_pick_voice_defaults(client: AzureTtsClient, language: str, gender, expected: str):
    assert client._pick_voice(language, gender) == expected


def test_pick_voice_unknown_lang_raises_so_the_next_provider_is_tried(client: AzureTtsClient):
    # Reading another language with an English voice is worse than falling through the chain.
    with pytest.raises(ValueError):
        client._pick_voice("xx", "male")


@pytest.mark.parametrize(
    "language, gender, expected",
    [
        ("gu", "female", "gu-IN-DhwaniNeural"),
        ("gu", "male", "gu-IN-NiranjanNeural"),
        ("ta-IN", "female", "ta-IN-PallaviNeural"),
        ("ml", "male", "ml-IN-MidhunNeural"),
    ],
)
def test_pick_voice_indic_languages(client: AzureTtsClient, language: str, gender: str, expected: str):
    assert client._pick_voice(language, gender) == expected
    assert client._pick_voice(language, None, speaker_id="2").startswith(language.split("-")[0])


def test_pick_voice_env_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AZURE_TTS_VOICE_EN_FEMALE", "en-US-AriaNeural")
    client = AzureTtsClient(api_key="dummy", region="eastus")
    assert client._pick_voice("en", "female") == "en-US-AriaNeural"
    assert client._pick_voice("en", "male") == "en-US-AndrewNeural"


def test_pick_voice_case_insensitive_gender(client: AzureTtsClient):
    assert client._pick_voice("en", "MALE") == "en-US-AndrewNeural"
    assert client._pick_voice("en", "Female") == "en-US-AvaNeural"


def test_speaker_rotation_en(client: AzureTtsClient):
    # Speaker 1 → pool[0] = Andrew, Speaker 2 → pool[1] = Ava
    assert client._pick_voice("en", speaker_id="1") == "en-US-AndrewNeural"
    assert client._pick_voice("en", speaker_id="2") == "en-US-AvaNeural"
    assert client._pick_voice("en", speaker_id="3") == "en-US-EmmaNeural"
    assert client._pick_voice("en", speaker_id="4") == "en-US-GuyNeural"
    # Wraps around
    assert client._pick_voice("en", speaker_id="5") == "en-US-AndrewNeural"


def test_speaker_rotation_ru_voices_are_distinct(client: AzureTtsClient):
    voices = {client._pick_voice("ru", speaker_id=str(i)) for i in (1, 2, 3)}
    assert len(voices) == 3


def test_non_english_languages_never_fall_back_to_english_pool(client: AzureTtsClient):
    for lang in ("nl", "sv", "pl", "tr"):
        assert client._pick_voice(lang, speaker_id="1").startswith(lang)
        assert client._pick_voice(lang, "female").startswith(lang)


def test_speaker_rotation_zh(client: AzureTtsClient):
    assert client._pick_voice("zh", speaker_id="1") == "zh-CN-YunxiNeural"
    assert client._pick_voice("zh", speaker_id="2") == "zh-CN-XiaoxiaoNeural"


def test_speaker_rotation_ignores_gender_when_speaker_set(client: AzureTtsClient):
    # When speaker_id is given, pool rotation takes priority over gender
    assert client._pick_voice("en", gender_hint="female", speaker_id="1") == "en-US-AndrewNeural"
