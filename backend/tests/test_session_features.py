"""Live-session features on /ws/translate: modes, meetings, resume, fallbacks."""

from __future__ import annotations

import json

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.fakes import FAKE_WAV
from tests.test_ws_contract import _recv_until


def is_type(kind):
    return lambda m: isinstance(m, dict) and m.get("type") == kind


def config(ws, **extra):
    msg = {"type": "config", "source_lang": "en", "target_lang": "es", **extra}
    ws.send_text(json.dumps(msg))
    return _recv_until(ws, is_type("session"))[-1]


def drain_until_pong(ws):
    """Everything the server sent before answering our ping (ordering barrier)."""
    ws.send_text(json.dumps({"type": "ping"}))
    return _recv_until(ws, is_type("pong"))[:-1]


def test_transcribe_only_stores_segments_and_sends_no_audio(client):
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, mode={"translate": False, "transcribe": True}, tab_url="https://meet.google.com/x", tab_title="Standup")
        assert session["meeting_id"] and session["translate"] is False
        ws.send_bytes(b"\x00\x00" * 800)
        seen = drain_until_pong(ws)
    assert not any(isinstance(m, bytes) for m in seen)
    assert not any(isinstance(m, dict) and m["type"].startswith("translated") for m in seen)
    final = next(m for m in seen if isinstance(m, dict) and m.get("type") == "transcript" and m["is_final"])
    assert final["segment_id"] and final["speaker"] == "S1" and final["source"] == "tab"

    meeting = client.get(f"/api/meetings/{session['meeting_id']}").json()
    assert meeting["platform"] == "google_meet" and meeting["title"].startswith("Standup")
    assert [s["text"] for s in meeting["segments"]] == ["hello world"]
    assert client.fakes.tts_calls == []


def test_translate_only_creates_no_meeting(client):
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, mode={"translate": True, "transcribe": False})
        assert session["meeting_id"] is None
        ws.send_bytes(b"\x00\x00" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    final = next(m for m in seen if isinstance(m, dict) and m.get("type") == "transcript" and m["is_final"])
    assert "segment_id" not in final
    assert seen[-1] == FAKE_WAV
    assert client.get("/api/meetings").json()["meetings"] == []


def test_translation_is_saved_on_its_segment(client):
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws)
        ws.send_bytes(b"\x00\x00" * 800)
        _recv_until(ws, lambda m: isinstance(m, bytes))
    seg = client.get(f"/api/meetings/{session['meeting_id']}").json()["segments"][0]
    assert seg["translated_text"] == "hola mundo"


def test_tab_and_mic_share_one_meeting(client):
    with client.websocket_connect("/ws/translate") as tab:
        tab_session = config(tab, mode={"translate": False, "transcribe": True})
        tab.send_bytes(b"\x00\x00" * 800)
        drain_until_pong(tab)
        with client.websocket_connect("/ws/translate") as mic:
            mic_session = config(mic, source="mic", meeting_id=tab_session["meeting_id"], mode={"translate": False, "transcribe": True})
            assert mic_session["meeting_id"] == tab_session["meeting_id"] and mic_session["source"] == "mic"
            mic.send_bytes(b"\x00\x00" * 800)
            seen = drain_until_pong(mic)
    final = next(m for m in seen if isinstance(m, dict) and m.get("type") == "transcript" and m["is_final"])
    assert final["speaker"] == "me" and final["source"] == "mic"
    segments = client.get(f"/api/meetings/{tab_session['meeting_id']}").json()["segments"]
    assert [(s["source"], s["speaker"]) for s in segments] == [("tab", "S1"), ("mic", "me")]
    assert len(client.get("/api/meetings").json()["meetings"]) == 1


def test_end_meeting_then_resume_by_id(client):
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, mode={"translate": False, "transcribe": True})
        ws.send_bytes(b"\x00\x00" * 800)
        ws.send_text(json.dumps({"type": "stop", "end_meeting": True}))
        seen = _recv_until(ws, is_type("meeting_ended"))
        assert any(isinstance(m, dict) and m.get("type") == "stopped" for m in seen)
    mid = session["meeting_id"]
    assert client.get(f"/api/meetings/{mid}").json()["status"] == "ended"

    # e.g. the service worker restarted and reconnects with the same meeting id
    with client.websocket_connect("/ws/translate") as ws:
        resumed = config(ws, meeting_id=mid, mode={"translate": False, "transcribe": True})
        assert resumed["meeting_id"] == mid
        assert client.get(f"/api/meetings/{mid}").json()["status"] == "live"
        ws.send_bytes(b"\x00\x00" * 800)
        drain_until_pong(ws)
    assert len(client.get(f"/api/meetings/{mid}").json()["segments"]) == 2


def test_unknown_meeting_id_starts_a_new_meeting(client):
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, meeting_id="does-not-exist")
    assert session["meeting_id"] and session["meeting_id"] != "does-not-exist"


class FakeTranslator:
    def __init__(self):
        self.calls = []

    async def translate(self, text, source, target):
        self.calls.append((text, source, target))
        return f"[{target}] {text}"

    async def close(self):
        pass


def test_text_translator_path_for_stt_without_native_translation(client, monkeypatch):
    from services.providers import registry

    translator = FakeTranslator()
    monkeypatch.setitem(
        registry.STT_SPECS, "fake", registry.ProviderSpec("fake", "Fake STT", ("FAKE_KEY",), diarization=True, native_translation=False)
    )
    monkeypatch.setitem(registry.TRANSLATOR_SPECS, "fake", registry.ProviderSpec("fake", "Fake translator", ("FAKE_KEY",)))
    monkeypatch.setenv("TRANSLATION_PROVIDER", "fake")
    monkeypatch.setattr(registry, "build_translator", lambda pid=None: translator)
    client.fakes.script = [
        ("transcript", "Good morning everyone.", True, "2"),
        ("translation", "should be ignored", True, "2"),
    ]
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws)
        assert session["translator"] == "fake"
        assert client.fakes.last_stt.target is None  # STT was not asked to translate
        ws.send_bytes(b"\x00\x00" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    translated = [m for m in seen if isinstance(m, dict) and m.get("type") == "translated_text"]
    assert [t["text"] for t in translated] == ["[es] Good morning everyone."]
    assert translated[0]["segment_id"] and translated[0]["speaker"] == "S2"
    assert translator.calls == [("Good morning everyone.", "en", "es")]
    assert client.fakes.tts_calls == [("[es] Good morning everyone.", "es")]


def test_tts_falls_back_to_next_provider(client, monkeypatch):
    from services.providers import registry, tts

    class Broken:
        async def synthesize(self, *a, **k):
            raise RuntimeError("quota exceeded")

        async def close(self):
            pass

    monkeypatch.setitem(registry.TTS_SPECS, "broken", registry.ProviderSpec("broken", "Broken TTS", ("FAKE_KEY",)))
    monkeypatch.setitem(tts.TTS_BUILDERS, "broken", lambda: Broken())
    monkeypatch.setitem(registry.DEFAULT_ORDER, "tts", ["broken", "fake"])
    monkeypatch.setenv("TTS_PROVIDER", "broken")
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws)
        assert session["tts_provider"] == "broken"
        ws.send_bytes(b"\x00\x00" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
    assert seen[-1] == FAKE_WAV
    assert client.fakes.tts_calls == [("hola mundo", "es")]


def test_no_tts_provider_warns_but_still_translates_text(client, monkeypatch):
    from services.providers import registry

    monkeypatch.delitem(registry.TTS_SPECS, "fake")
    monkeypatch.delenv("TTS_PROVIDER")
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        seen = _recv_until(ws, is_type("warning"))
        assert any(isinstance(m, dict) and m.get("type") == "session" and m["tts_provider"] is None for m in seen)
        ws.send_bytes(b"\x00\x00" * 800)
        seen = drain_until_pong(ws)
    assert any(isinstance(m, dict) and m.get("type") == "translated_text" for m in seen)
    assert not any(isinstance(m, bytes) for m in seen)


def test_same_language_skips_translation(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "en-US"}))
        _recv_until(ws, is_type("session"))
        assert client.fakes.last_stt.target is None
        ws.send_bytes(b"\x00\x00" * 800)
        seen = drain_until_pong(ws)
    assert not any(isinstance(m, bytes) for m in seen)
    assert not any(isinstance(m, dict) and m.get("type") == "translated_text" for m in seen)


def test_bad_messages_and_audio_before_config(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_bytes(b"\x00\x00" * 10)  # dropped silently, no crash
        ws.send_text("{not json")
        assert _recv_until(ws, is_type("error"))[-1]["code"] == "bad_message"
        ws.send_text(json.dumps({"type": "dance"}))
        assert _recv_until(ws, is_type("error"))[-1]["code"] == "bad_message"
        assert drain_until_pong(ws) == []


def test_unknown_stt_provider_is_a_config_error(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "stt_provider": "soniox"}))
        err = _recv_until(ws, is_type("error"))[-1]
        assert err["code"] == "provider_config" and "SONIOX_API_KEY" in err["message"]


def test_foreign_origin_is_rejected(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/translate", headers={"origin": "https://evil.example.com"}) as ws:
            ws.receive_text()
    assert exc.value.code == 1008
    with client.websocket_connect("/ws/translate", headers={"origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}) as ws:
        assert drain_until_pong(ws) == []


def test_final_flushed_on_bare_disconnect_is_stored(client):
    """Tab closed / service worker died: no `stop`, but the provider's last words must be kept."""
    import time

    client.fakes.close_script = [("transcript", "and that's a wrap", True, "1")]
    with client.websocket_connect("/ws/translate") as ws:
        session = config(ws, mode={"translate": False, "transcribe": True})
        ws.send_bytes(b"\x00\x00" * 800)
        drain_until_pong(ws)
    mid = session["meeting_id"]
    deadline = time.time() + 5
    texts: list[str] = []
    while time.time() < deadline:
        texts = [s["text"] for s in client.get(f"/api/meetings/{mid}").json()["segments"]]
        if "and that's a wrap" in texts:
            break
        time.sleep(0.05)
    assert texts == ["hello world", "and that's a wrap"]
