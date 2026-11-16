"""Token/word assembly for the Soniox and Deepgram realtime clients."""

from __future__ import annotations

import asyncio

import pytest

from services.providers.deepgram_client import DeepgramClient
from services.providers.soniox_client import SonioxClient


class Recorder:
    def __init__(self) -> None:
        self.transcripts: list[tuple[str, bool, str | None, int | None, int | None]] = []
        self.translations: list[tuple[str, bool]] = []
        self.errors: list[str] = []
        self.order: list[str] = []

    async def on_transcript(self, text, is_final, speaker=None, start_ms=None, end_ms=None, **_):
        self.transcripts.append((text, is_final, speaker, start_ms, end_ms))
        if is_final:
            self.order.append(f"T:{text}")

    async def on_translation(self, text, is_final, **_):
        self.translations.append((text, is_final))
        if is_final:
            self.order.append(f"X:{text}")

    async def on_error(self, message, **_):
        self.errors.append(message)

    def finals(self):
        return [t for t in self.transcripts if t[1]]


def tok(text, final=True, speaker="1", status="original", start=None, end=None):
    t = {"text": text, "is_final": final, "speaker": speaker, "translation_status": status}
    if start is not None:
        t["start_ms"] = start
        t["end_ms"] = end
    return t


def run(coro):
    return asyncio.run(coro)


# ── Soniox ────────────────────────────────────────────────────────────


def soniox(rec: Recorder, target: str | None = "es") -> SonioxClient:
    return SonioxClient(
        api_key="k",
        language="en",
        target_language=target,
        on_transcript=rec.on_transcript,
        on_translation=rec.on_translation,
        on_error=rec.on_error,
    )


def test_soniox_config_has_translation_and_diarization():
    cfg = soniox(Recorder()).build_config()
    assert cfg["audio_format"] == "pcm_s16le" and cfg["sample_rate"] == 16000
    assert cfg["enable_speaker_diarization"] is True
    assert cfg["enable_endpoint_detection"] is True
    assert cfg["language_hints"] == ["en"]
    assert cfg["translation"] == {"type": "one_way", "target_language": "es"}
    assert "api_key" not in cfg  # deprecated in the start message; sent as a header


def test_soniox_config_without_translation():
    assert "translation" not in soniox(Recorder(), target=None).build_config()


def test_soniox_endpoint_emits_final_with_bounds_and_filters_control_tokens():
    rec = Recorder()
    client = soniox(rec, target=None)

    async def go():
        await client.handle_message({"tokens": [tok("Hel", start=0, end=100), tok("lo", final=False)]})
        await client.handle_message({"tokens": [tok("lo", start=100, end=200), tok(" world", start=250, end=600), tok("<end>")]})

    run(go())
    finals = rec.finals()
    assert finals == [("Hello world", True, "1", 0, 600)]
    assert all("<end>" not in t[0] for t in rec.transcripts)
    assert rec.transcripts[0] == ("Hello", False, "1", None, None)


def test_soniox_speaker_change_splits_segments():
    rec = Recorder()
    client = soniox(rec, target=None)

    async def go():
        await client.handle_message({"tokens": [tok("Hi", speaker="1"), tok(" there.", speaker="1")]})
        await client.handle_message({"tokens": [tok("Hello", speaker="2"), tok("<end>")]})

    run(go())
    assert [(t[0], t[2]) for t in rec.finals()] == [("Hi there.", "1"), ("Hello", "2")]


def test_soniox_translation_follows_its_source_segment():
    rec = Recorder()
    client = soniox(rec)

    async def go():
        await client.handle_message({"tokens": [tok("Good"), tok(" morning.")]})
        await client.handle_message({"tokens": [tok("Buenos", status="translation"), tok(" días.", status="translation")]})

    run(go())
    assert rec.order == ["T:Good morning.", "X:Buenos días."]


def test_soniox_partial_translation_and_timer_flush():
    rec = Recorder()
    client = soniox(rec)

    async def go():
        await client.handle_message({"tokens": [tok("Thanks"), tok("<end>")]})
        await client.handle_message({"tokens": [tok("Gra", status="translation"), tok("cias", final=False, status="translation")]})
        assert rec.translations[-1] == ("Gracias", False)
        await asyncio.sleep(1.1)  # translation idle timer

    run(go())
    assert ("Gra", True) in rec.translations


def test_soniox_error_message_reports_and_disconnects():
    rec = Recorder()
    client = soniox(rec)
    client.is_connected = True
    run(client.handle_message({"tokens": [], "error_code": 401, "error_type": "unauthenticated", "error_message": "Invalid API key"}))
    assert client.is_connected is False
    assert rec.errors and "Invalid API key" in rec.errors[0]


def test_soniox_connect_requires_key():
    with pytest.raises(ValueError):
        run(SonioxClient(api_key="").connect())


class FakeWS:
    def __init__(self, incoming):
        self.sent = []
        self._incoming = list(incoming)
        self.closed = False

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        while True:
            await asyncio.sleep(0.01)
            if self._incoming:
                return self._incoming.pop(0)
            if "" in self.sent:  # server answers a finalize with `finished`
                self.sent.append("<finished-sent>")
                return '{"tokens":[],"finished":true}'
            if self.closed:
                raise StopAsyncIteration


def test_soniox_connect_sends_bearer_header_config_and_finalizes_on_close():
    import json

    rec = Recorder()
    captured = {}
    ws = FakeWS(['{"tokens":[{"text":"Hi","is_final":true,"speaker":"1"}]}'])

    async def fake_connect(url, **kwargs):
        captured.update(kwargs, url=url)
        return ws

    client = SonioxClient(api_key="secret", language="en", on_transcript=rec.on_transcript, connect_fn=fake_connect)

    async def go():
        await client.connect()
        await client.send_audio(b"\x00\x00" * 10)
        await asyncio.sleep(0.05)
        await client.close()

    run(go())
    assert captured["additional_headers"] == {"Authorization": "Bearer secret"}
    assert json.loads(ws.sent[0])["model"]
    assert ws.sent[1] == b"\x00\x00" * 10
    assert "" in ws.sent  # empty text frame = finalize
    assert rec.finals()[0][0] == "Hi"


# ── Deepgram ──────────────────────────────────────────────────────────


def dg_result(words, is_final, speech_final=False, transcript=None):
    return {
        "type": "Results",
        "is_final": is_final,
        "speech_final": speech_final,
        "channel": {
            "alternatives": [
                {
                    "transcript": transcript or " ".join(w[0] for w in words),
                    "words": [
                        {"word": w[0].lower().strip(".,"), "punctuated_word": w[0], "start": w[1], "end": w[2], "speaker": w[3]}
                        for w in words
                    ],
                }
            ]
        },
    }


def deepgram(rec: Recorder) -> DeepgramClient:
    return DeepgramClient(api_key="k", language="en", on_transcript=rec.on_transcript, on_error=rec.on_error)


def test_deepgram_params_use_diarize_model_and_linear16():
    params = deepgram(Recorder()).build_params()
    assert params["encoding"] == "linear16" and params["sample_rate"] == "16000"
    assert params["diarize_model"] == "latest"
    assert "diarize" not in params
    assert params["model"] == "nova-3"


def test_deepgram_accumulates_finals_until_speech_final():
    rec = Recorder()
    client = deepgram(rec)

    async def go():
        await client.handle_message(dg_result([("Hello", 0.0, 0.4, 0)], is_final=False))
        await client.handle_message(dg_result([("Hello", 0.0, 0.4, 0), ("everyone,", 0.5, 0.9, 0)], is_final=True))
        await client.handle_message(dg_result([("welcome.", 1.0, 1.4, 0)], is_final=True, speech_final=True))

    run(go())
    assert rec.finals() == [("Hello everyone, welcome.", True, "1", 0, 1400)]


def test_deepgram_splits_on_speaker_change_and_utterance_end():
    rec = Recorder()
    client = deepgram(rec)

    async def go():
        await client.handle_message(dg_result([("Yes.", 0.0, 0.3, 0), ("No.", 0.5, 0.8, 1)], is_final=True))
        await client.handle_message({"type": "UtteranceEnd", "last_word_end": 0.8})

    run(go())
    assert [(t[0], t[2]) for t in rec.finals()] == [("Yes.", "1"), ("No.", "2")]


def test_deepgram_error_message_is_non_fatal():
    rec = Recorder()
    client = deepgram(rec)
    client.is_connected = True
    run(client.handle_message({"type": "Error", "description": "bad schema"}))
    assert rec.errors == ["bad schema"]
    assert client.is_connected is True
