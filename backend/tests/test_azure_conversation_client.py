"""Unit tests for AzureConversationClient pure helpers."""

from __future__ import annotations

import pytest

from services.azure_conversation_client import AzureConversationClient


@pytest.fixture
def client() -> AzureConversationClient:
    return AzureConversationClient(api_key="dummy", region="eastus")


def test_locale_mapping_en(client: AzureConversationClient):
    assert client.source_locale == "en-US"


def test_locale_mapping_zh():
    c = AzureConversationClient(api_key="k", region="r", language="zh")
    assert c.source_locale == "zh-CN"


def test_locale_mapping_passthrough():
    c = AzureConversationClient(api_key="k", region="r", language="en-US")
    assert c.source_locale == "en-US"


def test_translator_lang_zh():
    c = AzureConversationClient(api_key="k", region="r", target_language="zh")
    assert c.translator_target == "zh-Hans"


def test_translator_lang_passthrough():
    c = AzureConversationClient(api_key="k", region="r", target_language="es")
    assert c.translator_target == "es"


def test_parse_speaker_id_from_json():
    assert AzureConversationClient._parse_speaker_id_from_json(
        '{"SpeakerId": "Guest-1"}'
    ) == "Guest-1"


def test_parse_speaker_id_from_nbest():
    assert AzureConversationClient._parse_speaker_id_from_json(
        '{"NBest": [{"SpeakerId": "Guest-2"}]}'
    ) == "Guest-2"


def test_parse_speaker_id_unknown_returns_none():
    assert AzureConversationClient._parse_speaker_id_from_json(
        '{"SpeakerId": "Unknown"}'
    ) is None


def test_parse_speaker_id_empty_returns_none():
    assert AzureConversationClient._parse_speaker_id_from_json("") is None
    assert AzureConversationClient._parse_speaker_id_from_json("{}") is None


def test_parse_speaker_id_invalid_json():
    assert AzureConversationClient._parse_speaker_id_from_json("not json") is None


def test_parse_gender_male():
    assert AzureConversationClient._parse_gender('{"Gender": "Male"}') == "male"


def test_parse_gender_female_from_nbest():
    assert AzureConversationClient._parse_gender(
        '{"NBest": [{"Gender": "Female"}]}'
    ) == "female"


def test_parse_gender_none_on_empty():
    assert AzureConversationClient._parse_gender("") is None
    assert AzureConversationClient._parse_gender("{}") is None
