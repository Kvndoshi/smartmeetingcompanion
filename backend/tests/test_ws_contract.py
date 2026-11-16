"""Contract tests for the /ws/translate WebSocket protocol.

These pin the behaviour the Chrome extension depends on, using fake STT/TTS
providers so they run with zero API keys.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FAKE_WAV, install_fakes


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    fakes = install_fakes(monkeypatch, tmp_path)
    import main

    with TestClient(main.app) as c:
        c.fakes = fakes  # type: ignore[attr-defined]
        yield c


def _recv_until(ws, predicate, limit: int = 50):
    """Receive messages until predicate(msg) is true. Returns all received."""
    seen = []
    for _ in range(limit):
        msg = ws.receive()
        if msg.get("type") == "websocket.close":
            raise AssertionError(f"socket closed early; seen={seen}")
        if msg.get("text") is not None:
            parsed = json.loads(msg["text"])
            seen.append(parsed)
            if predicate(parsed):
                return seen
        elif msg.get("bytes") is not None:
            seen.append(msg["bytes"])
            if predicate(msg["bytes"]):
                return seen
    raise AssertionError(f"predicate never satisfied; seen={seen}")


def test_config_then_audio_yields_transcript_translation_and_audio(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "session")
        ws.send_bytes(b"\x00\x01" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
        types = [m.get("type") for m in seen if isinstance(m, dict)]
        assert "transcript" in types
        assert "translated_text" in types
        transcript = next(m for m in seen if isinstance(m, dict) and m.get("type") == "transcript" and m.get("is_final"))
        assert transcript["text"] == "hello world"
        translated = next(m for m in seen if isinstance(m, dict) and m.get("type") == "translated_text")
        assert translated["text"] == "hola mundo"
        assert seen[-1][:4] == b"RIFF"


def test_stop_returns_stopped(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "session")
        ws.send_text(json.dumps({"type": "stop"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "stopped")


def test_provider_connect_failure_sends_error_and_keeps_socket(client, monkeypatch):
    client.fakes.fail_connect = True
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        seen = _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "error")
        err = seen[-1]
        assert err.get("code") == "provider_config"
        assert "FAKE_KEY" in err["message"]
        # Socket must still be usable afterwards.
        ws.send_text(json.dumps({"type": "ping"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "pong")


def test_disconnect_closes_stt_client(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "session")
    stt = client.fakes.last_stt
    assert stt is not None
    # The handler closes the STT client in its finally block.
    for _ in range(100):
        if stt.closed:
            break
        import time

        time.sleep(0.01)
    assert stt.closed


def test_translate_audio_is_valid_wav(client):
    with client.websocket_connect("/ws/translate") as ws:
        ws.send_text(json.dumps({"type": "config", "source_lang": "en", "target_lang": "es"}))
        _recv_until(ws, lambda m: isinstance(m, dict) and m.get("type") == "session")
        ws.send_bytes(b"\x00\x01" * 800)
        seen = _recv_until(ws, lambda m: isinstance(m, bytes))
        audio = seen[-1]
        assert audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"
        # Silence padding grows the payload beyond the fake TTS output.
        assert len(audio) >= len(FAKE_WAV)
