"""Unit tests for AzureTranslationClient pure helpers."""

from __future__ import annotations

import json

from services.azure_translation_client import AzureTranslationClient


def test_parse_gender_from_nbest_male():
    raw = json.dumps({
        "NBest": [
            {"Gender": "Male", "Display": "Hello"},
        ]
    })
    assert AzureTranslationClient._parse_gender(raw) == "male"


def test_parse_gender_from_nbest_female():
    raw = json.dumps({
        "NBest": [
            {"Gender": "Female", "Display": "Hello"},
        ]
    })
    assert AzureTranslationClient._parse_gender(raw) == "female"


def test_parse_gender_top_level_field():
    raw = json.dumps({"Gender": "male"})
    assert AzureTranslationClient._parse_gender(raw) == "male"


def test_parse_gender_missing_returns_none():
    raw = json.dumps({"Display": "Hello", "NBest": [{"Display": "Hello"}]})
    assert AzureTranslationClient._parse_gender(raw) is None


def test_parse_gender_empty_string_returns_none():
    assert AzureTranslationClient._parse_gender("") is None


def test_parse_gender_invalid_json_returns_none():
    assert AzureTranslationClient._parse_gender("not json {{") is None


def test_parse_gender_unexpected_value_returns_none():
    raw = json.dumps({"NBest": [{"Gender": "Robot"}]})
    assert AzureTranslationClient._parse_gender(raw) is None
