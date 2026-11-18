"""Auto-detected spoken language, per-segment language routing and two-way re-config."""

from __future__ import annotations

import asyncio
import json
import sqlite3

import httpx
import pytest

from services.providers.deepgram_client import DeepgramClient
from services.providers.soniox_client import SonioxClient
from tests.fakes import ALL_KEY_VARS
from tests.test_session_features import FakeTranslator, config, drain_until_pong, is_type
from tests.test_stt_parsers import Recorder, dg_result, run, tok
from tests.test_ws_contract import _recv_until


def ltok(text, lang, final=True, speaker="1", status="original"):
    t = tok(text, final=final, speaker=speaker, status=status)
    t["language"] = lang
    return t


class LangRecorder(Recorder):
    """Recorder that also keeps the `language` each callback received."""

    def __init__(self) -> None:
        super().__init__()
        self.final_langs: list[tuple[str, str | None]] = []
        self.partial_langs: list[str | None] = []
        self.translation_langs: list[tuple[str, str | None]] = []

    async def on_transcript(self, text, is_final, speaker=None, start_ms=None, end_ms=None, language=None, **kw):
        await super().on_transcript(text, is_final, speaker=speaker, start_ms=start_ms, end_ms=end_ms)
        (self.final_langs.append((text, language)) if is_final else self.partial_langs.append(language))

    async def on_translation(self, text, is_final, language=None, **kw):
        await super().on_translation(text, is_final)
        if is_final:
            self.translation_langs.append((text, language))


def auto_soniox(rec: Recorder, target: str | None = "en") -> SonioxClient:
    return SonioxClient(
        api_key="k", language="auto", target_language=target,
        on_transcript=rec.on_transcript, on_translation=rec.on_translation, on_error=rec.on_error,
    )


# ── Soniox ────────────────────────────────────────────────────────────


def test_soniox_auto_config_identifies_language_without_hints():
    cfg = auto_soniox(Recorder()).build_config()
    assert cfg["enable_language_identification"] is True
    assert "language_hints" not in cfg
    assert cfg["translation"] == {"type": "one_way", "target_language": "en"}


def test_soniox_final_and_partial_carry_dominant_language():
    rec = LangRecorder()
    client = auto_soniox(rec, target=None)

    async def go():
        # Hinglish: mostly Hindi with an English word mid-sentence stays one Hindi segment.
        await client.handle_message({"tokens": [ltok("मैं", "hi"), ltok(" meeting", "en"), ltok(" में हूँ", "hi", final=False)]})
        await client.handle_message({"tokens": [ltok(" में हूँ।", "hi"), tok("<end>")]})

    run(go())
    assert rec.partial_langs == ["hi"]
    assert rec.final_langs == [("मैं meeting में हूँ।", "hi")]


def test_soniox_splits_on_language_change_only_at_sentence_end():
    rec = LangRecorder()
    client = auto_soniox(rec, target=None)

    async def go():
        await client.handle_message({"tokens": [ltok("Hello", "en"), ltok(" everyone.", "en")]})
        await client.handle_message({"tokens": [ltok("કેમ છો", "gu"), tok("<end>")]})

    run(go())
    assert rec.final_langs == [("Hello everyone.", "en"), ("કેમ છો", "gu")]


def test_soniox_translation_carries_its_source_language():
    rec = LangRecorder()
    client = auto_soniox(rec, target="en")

    async def go():
        await client.handle_message({"tokens": [ltok("नमस्ते", "hi"), ltok(" सबको।", "hi")]})
        await client.handle_message({"tokens": [tok("Hello", status="translation"), tok(" everyone.", status="translation")]})

    run(go())
    assert rec.order == ["T:नमस्ते सबको।", "X:Hello everyone."]
    assert rec.translation_langs == [("Hello everyone.", "hi")]


# ── Deepgram ──────────────────────────────────────────────────────────


def lang_words(result, langs):
    for word, lang in zip(result["channel"]["alternatives"][0]["words"], langs):
        word["language"] = lang
    return result


def test_deepgram_multi_uses_fast_endpointing_and_word_languages():
    rec = LangRecorder()
    client = DeepgramClient(api_key="k", language="auto", on_transcript=rec.on_transcript, on_error=rec.on_error)
    params = client.build_params()
    assert params["language"] == "multi" and params["endpointing"] == "100"

    async def go():
        msg = dg_result([("Namaste", 0.0, 0.4, 0), ("sabko", 0.5, 0.9, 0), ("hello.", 1.0, 1.2, 0)], is_final=True, speech_final=True)
        await client.handle_message(lang_words(msg, ["hi", "hi", "en"]))

    run(go())
    assert rec.final_langs == [("Namaste sabko hello.", "hi")]


def test_deepgram_falls_back_to_result_languages_then_none():
    rec = LangRecorder()
    client = DeepgramClient(api_key="k", language="en", on_transcript=rec.on_transcript, on_error=rec.on_error)
    assert client.build_params()["endpointing"] == "300"

    async def go():
        msg = dg_result([("Bonjour.", 0.0, 0.4, 0)], is_final=True, speech_final=True)
        msg["channel"]["alternatives"][0]["languages"] = ["fr"]
        await client.handle_message(msg)

    run(go())
    assert rec.final_langs == [("Bonjour.", "fr")]

    rec2 = LangRecorder()
    plain = DeepgramClient(api_key="k", language="en", on_transcript=rec2.on_transcript)
    run(plain.handle_message(dg_result([("Hi.", 0.0, 0.2, 0)], is_final=True, speech_final=True)))
    assert rec2.final_langs == [("Hi.", None)]


# ── Session: auto-detected source ─────────────────────────────────────


def finals(seen):
    return [m for m in seen if isinstance(m, dict) and m.get("type") == "transcript" and m["is_final"]]


def translations(seen):
    return [m for m in seen if isinstance(m, dict) and m.get("type") == "translated_text"]


def spoken(ws):
    """Everything up to the first audio, plus whatever else arrived before a ping was answered."""
    seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    return seen + drain_until_pong(ws) + drain_until_pong(ws)


def audio(seen):
    return [m for m in seen if isinstance(m, bytes)]


def test_auto_ack_and_my_language_segment_is_read_back_as_is_not_translated(client):
    """The extension silences the original audio, so same-language speech is spoken (once) too."""
    client.fakes.script = [
        ("transcript", "Good morning everyone.", True, "1", "en"),
        ("translation", "Good morning everyone.", True, "1", "en"),  # provider echo
    ]
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, source_lang="auto", target_lang="en")
        assert session["auto_language"] is True and session["source_lang"] == "auto"
        assert client.fakes.last_stt.language == "auto"
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
    assert finals(seen)[0]["language"] == "en"
    assert translations(seen) == []
    assert len(audio(seen)) == 1
    assert client.fakes.tts_calls == [("Good morning everyone.", "en")]
    segments = client.get(f"/api/meetings/{session['meeting_id']}").json()["segments"]
    assert segments[0]["language"] == "en" and not segments[0]["translated_text"]


def test_auto_my_language_segment_with_untagged_provider_echo_is_spoken_once(client):
    client.fakes.script = [
        ("transcript", "Good morning everyone.", True, "1", "en"),
        ("translation", "Good morning, everyone", True, "1"),  # echo without a language tag
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
    assert translations(seen) == [] and len(audio(seen)) == 1
    assert client.fakes.tts_calls == [("Good morning everyone.", "en")]


def test_auto_mixed_room_speaks_everyone_in_order(client):
    client.fakes.script = [
        ("transcript", "કેમ છો બધા", True, "2", "gu"),
        ("translation", "How is everyone", True, "2", "gu"),
        ("transcript", "I am fine, thanks.", True, "1", "en"),
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
        if len(audio(seen)) < 2:
            seen += _recv_until(ws, lambda m: isinstance(m, bytes))
    assert [t["text"] for t in translations(seen)] == ["How is everyone"]
    assert client.fakes.tts_calls == [("How is everyone", "en"), ("I am fine, thanks.", "en")]


def test_my_language_is_not_read_back_without_a_voice_or_in_fixed_mode(client):
    # Translated text only (no TTS): the originals stay audible, nothing is spoken.
    client.fakes.script = [("transcript", "Good morning everyone.", True, "1", "en")]
    with client.websocket_connect("/ws/translate") as ws:
        ack = config(ws, source_lang="auto", target_lang="en", tts_provider="no-such-voice")
        assert ack["tts_provider"] is None
        ws.send_bytes(b"\x00\x00" * 800)
        assert audio(drain_until_pong(ws) + drain_until_pong(ws)) == []
    assert client.fakes.tts_calls == []
    # Fixed source language (e.g. the outgoing "my voice" socket): unchanged, never read back.
    client.fakes.script = [
        ("transcript", "Good morning everyone.", True, "1", "en"),
        ("translation", "Good morning everyone.", True, "1", "en"),
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="es", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = drain_until_pong(ws) + drain_until_pong(ws)
    assert translations(seen) == [] and audio(seen) == [] and client.fakes.tts_calls == []


def test_auto_foreign_segment_is_translated_tagged_and_spoken(client):
    client.fakes.script = [
        ("transcript", "કેમ છો બધા", True, "2", "gu"),
        ("translation", "How is everyone", True, "2", "gu"),
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    assert finals(seen)[0]["language"] == "gu"
    out = translations(seen)
    assert [(t["text"], t["language"]) for t in out] == [("How is everyone", "gu")]
    assert client.fakes.tts_calls == [("How is everyone", "en")]


def test_auto_echo_translation_without_language_is_read_back_once_not_shown(client):
    client.fakes.script = [
        ("transcript", "Okay, thanks.", True, "1"),
        ("translation", "okay thanks", True, "1"),
        ("translation", "okay thanks", True, "1"),  # a repeated echo must not be spoken again
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
    assert finals(seen)[0]["language"] is None
    assert translations(seen) == [] and len(audio(seen)) == 1
    assert client.fakes.tts_calls == [("Okay, thanks.", "en")]


def test_fixed_source_language_is_reported_on_segments(client):
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="es-ES", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    assert finals(seen)[0]["language"] == "es"


def _use_text_translator(client, monkeypatch, translator):
    from services.providers import registry

    monkeypatch.setitem(
        registry.STT_SPECS, "fake",
        registry.ProviderSpec("fake", "Fake STT", ("FAKE_KEY",), diarization=True, auto_language=True),
    )
    monkeypatch.setitem(registry.TRANSLATOR_SPECS, "fake", registry.ProviderSpec("fake", "Fake translator", ("FAKE_KEY",)))
    monkeypatch.setenv("TRANSLATION_PROVIDER", "fake")
    monkeypatch.setattr(registry, "build_translator", lambda pid=None: translator)


def test_text_translator_gets_detected_language_and_flushes_on_language_change(client, monkeypatch):
    translator = FakeTranslator()
    _use_text_translator(client, monkeypatch, translator)
    client.fakes.script = [
        ("transcript", "Namaste", True, "1", "hi"),
        ("transcript", "kem cho", True, "1", "gu"),  # same speaker, new language → separate request
        ("transcript", "See you", True, "1"),  # unknown language
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        ws.send_text(json.dumps({"type": "stop"}))
        _recv_until(ws, is_type("stopped"))
    assert [(text, src) for text, src, _ in translator.calls][:2] == [("Namaste", "hi"), ("kem cho", "gu")]


def test_text_translator_reads_my_language_back_after_pending_translations(client, monkeypatch):
    translator = FakeTranslator()
    _use_text_translator(client, monkeypatch, translator)
    client.fakes.script = [
        ("transcript", "Namaste ji", True, "1", "hi"),  # no sentence end → still buffered
        ("transcript", "Good morning.", True, "2", "en"),  # my language: flushes the buffer, then as-is
    ]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
        if len(audio(seen)) < 2:
            seen += _recv_until(ws, lambda m: isinstance(m, bytes))
    assert translator.calls == [("Namaste ji", "hi", "en")]
    assert [t["text"] for t in translations(seen)] == ["[en] Namaste ji"]
    assert client.fakes.tts_calls == [("[en] Namaste ji", "en"), ("Good morning.", "en")]


def test_text_translator_unknown_language_uses_auto_and_reads_unchanged_output_back(client, monkeypatch):
    class EchoTranslator(FakeTranslator):
        async def translate(self, text, source, target):
            self.calls.append((text, source, target))
            return text  # "already in the target language"

    translator = EchoTranslator()
    _use_text_translator(client, monkeypatch, translator)
    client.fakes.script = [("transcript", "Thanks a lot.", True, "1")]
    with client.websocket_connect("/ws/translate") as ws:
        config(ws, source_lang="auto", target_lang="en")
        ws.send_bytes(b"\x00\x00" * 800)
        seen = spoken(ws)
    assert translator.calls == [("Thanks a lot.", "auto", "en")]
    assert translations(seen) == [] and len(audio(seen)) == 1
    assert client.fakes.tts_calls == [("Thanks a lot.", "en")]


def test_reconfig_on_same_socket_switches_target_and_keeps_meeting(client):
    """Live 'Others hear me in' change: the extension re-sends config on the open socket."""
    with client.websocket_connect("/ws/translate") as ws:
        first = config(ws, source_lang="en", target_lang="hi", source="mic")
        ws.send_bytes(b"\x00\x00" * 800)
        _recv_until(ws, lambda m: isinstance(m, bytes))
        second = config(ws, source_lang="en", target_lang="gu", source="mic", meeting_id=first["meeting_id"])
        assert second["meeting_id"] == first["meeting_id"] and second["target_lang"] == "gu"
        ws.send_bytes(b"\x00\x00" * 800)
        _recv_until(ws, lambda m: isinstance(m, bytes))
        # Back to "my own voice": target = my language → transcribe only, no TTS.
        third = config(ws, source_lang="en", target_lang="en", source="mic", meeting_id=first["meeting_id"])
        assert third["tts_provider"] is None and third["translator"] is None
        ws.send_bytes(b"\x00\x00" * 800)
        seen = drain_until_pong(ws)
    assert [lang for _, lang in client.fakes.tts_calls] == ["hi", "gu"]
    assert not any(isinstance(m, bytes) for m in seen)
    assert finals(seen) and finals(seen)[0]["speaker"] == "me"


def test_own_voice_without_notes_opens_no_provider_until_reconfigured(client):
    """'Others hear my own voice' with notes off: nothing to do, so no STT connection."""
    with client.websocket_connect("/ws/translate") as ws:
        idle = config(ws, source_lang="en", target_lang="en", source="mic", mode={"translate": True, "transcribe": False})
        assert idle["idle"] is True and idle["stt_provider"] is None and idle["meeting_id"] is None
        assert client.fakes.stts == []
        ws.send_bytes(b"\x00\x00" * 800)  # dropped quietly
        assert not [m for m in drain_until_pong(ws) if isinstance(m, dict) and m.get("type") == "error"]
        # The room language becomes known: the same socket wakes up and translates.
        live = config(ws, source_lang="en", target_lang="hi", source="mic", mode={"translate": True, "transcribe": False})
        assert "idle" not in live and live["stt_provider"] and len(client.fakes.stts) == 1
        ws.send_bytes(b"\x00\x00" * 800)
        _recv_until(ws, lambda m: isinstance(m, bytes))
    assert [lang for _, lang in client.fakes.tts_calls] == ["hi"]


def test_auto_with_provider_that_cannot_detect_is_a_config_error(client, monkeypatch):
    from services.providers import registry

    monkeypatch.setitem(
        registry.STT_SPECS, "fake",
        registry.ProviderSpec("fake", "Fake STT", ("FAKE_KEY",), native_translation=True),
    )
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "auto", "target_lang": "en", "stt_provider": "fake"}))
        err = _recv_until(ws, is_type("error"))[-1]
    assert err["code"] == "provider_config" and "auto-detect" in err["message"]


# ── Registry ──────────────────────────────────────────────────────────


@pytest.fixture
def clean_env(monkeypatch):
    for var in ALL_KEY_VARS:
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


def test_require_auto_rejects_explicit_and_skips_default_non_auto_provider(clean_env):
    from services.providers import registry

    clean_env.setenv("SPEECHMATICS_API_KEY", "x")
    clean_env.setenv("DEEPGRAM_API_KEY", "x")
    clean_env.setenv("STT_PROVIDER", "speechmatics")
    with pytest.raises(registry.ProviderConfigError, match="auto-detect"):
        registry.resolve("stt", "speechmatics", require_auto=True)
    assert registry.resolve("stt", None, language="auto", require_auto=True) == "deepgram"
    assert registry.resolve("stt", None, language="en") == "speechmatics"
    clean_env.delenv("DEEPGRAM_API_KEY")
    with pytest.raises(registry.ProviderConfigError, match="Soniox or Deepgram"):
        registry.resolve("stt", None, require_auto=True)


def test_language_sets_route_stt_and_tts(clean_env):
    from services.providers import registry

    for key in ("SPEECHMATICS_API_KEY", "SONIOX_API_KEY", "DEEPGRAM_API_KEY", "MINIMAX_API_KEY", "AZURE_SPEECH_KEY"):
        clean_env.setenv(key, "x")
    clean_env.setenv("STT_PROVIDER", "speechmatics")
    assert "gu" in registry.APP_LANGUAGES
    assert registry.resolve("stt", None, language="gu") == "soniox"  # Speechmatics keeps the original 16
    chain = registry.tts_chain(None, "ml")
    assert "deepgram" not in chain and "minimax" not in chain and chain[0] == "soniox"
    assert "deepgram" in registry.tts_chain(None, "gu")
    status = registry.status()
    stt = {p["id"]: p for p in status["stt"]["providers"]}
    assert stt["soniox"]["auto_language"] is True and stt["azure"]["auto_language"] is False


# ── Text translators ─────────────────────────────────────────────────


def test_llm_translator_auto_prompt_allows_unchanged_output():
    from services.text_translator import LLMTranslator
    from tests.conftest import FakeLLM

    translator = LLMTranslator.__new__(LLMTranslator)
    translator._llm = FakeLLM(responses=["Hello", "Hola"])
    assert asyncio.run(translator.translate("Namaste", "auto", "en")) == "Hello"
    system = translator._llm.calls[0][0]["content"]
    assert "any language" in system and "already in English" in system
    asyncio.run(translator.translate("Hello", "en", "es"))
    assert "English speech into natural, spoken Spanish" in translator._llm.calls[1][0]["content"]


def test_azure_text_translator_detects_source_and_keeps_target_language_text():
    from services.text_translator import AzureTextTranslator

    seen_params = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_params.append(dict(request.url.params))
        text = json.loads(request.content)[0]["text"]
        detected = "en" if text.startswith("Hello") else "hi"
        return httpx.Response(200, json=[{"detectedLanguage": {"language": detected, "score": 1.0},
                                          "translations": [{"text": "TRANSLATED", "to": "en"}]}])

    translator = AzureTextTranslator.__new__(AzureTextTranslator)
    translator.key, translator.region = "k", ""
    translator._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert asyncio.run(translator.translate("नमस्ते", "auto", "en")) == "TRANSLATED"
    assert asyncio.run(translator.translate("Hello there", "auto", "en")) == "Hello there"
    assert "from" not in seen_params[0] and seen_params[0]["to"] == "en"


# ── Store migration ──────────────────────────────────────────────────


def test_old_database_gains_language_column(tmp_path, monkeypatch):
    from services import meeting_store

    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'other',
            tab_url TEXT, tab_title TEXT, source_lang TEXT, target_lang TEXT, stt_provider TEXT, tts_provider TEXT,
            status TEXT NOT NULL DEFAULT 'live', started_at REAL NOT NULL, ended_at REAL, last_activity_at REAL NOT NULL,
            summary_json TEXT, summary_status TEXT NOT NULL DEFAULT 'none', summary_error TEXT, summary_updated_at REAL,
            summary_language TEXT NOT NULL DEFAULT 'en', user_notes TEXT NOT NULL DEFAULT '',
            speaker_names TEXT NOT NULL DEFAULT '{}', memory_status TEXT NOT NULL DEFAULT 'none', memory_error TEXT,
            memory_synced_at REAL, memory_doc_id TEXT);
        CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, source TEXT NOT NULL DEFAULT 'tab',
            speaker TEXT, text TEXT NOT NULL, translated_text TEXT, start_ms INTEGER NOT NULL DEFAULT 0,
            end_ms INTEGER, created_at REAL NOT NULL);
        INSERT INTO meetings (id, title, started_at, last_activity_at) VALUES ('m1', 'Old', 1, 1);
        INSERT INTO segments (meeting_id, text, created_at) VALUES ('m1', 'old line', 1);
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(meeting_store, "DB_PATH", db)
    meeting_store.reset_connections()
    try:
        old = meeting_store.list_segments("m1")
        assert old[0]["text"] == "old line" and old[0]["language"] is None
        new = meeting_store.add_segment("m1", text="नमस्ते", language="hi")
        assert new["language"] == "hi"
    finally:
        meeting_store.reset_connections()
