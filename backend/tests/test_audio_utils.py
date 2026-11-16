"""WAV/PCM normalisation shared by all TTS providers."""

from __future__ import annotations

import struct

from services.audio_utils import is_wav, normalize_tts_audio, parse_wav, pcm_to_wav


def test_pcm_to_wav_header_and_roundtrip():
    pcm = b"\x01\x02" * 100
    wav = pcm_to_wav(pcm, sample_rate=24000)
    assert is_wav(wav) and len(wav) == 44 + len(pcm)
    assert struct.unpack_from("<I", wav, 24)[0] == 24000
    assert parse_wav(wav) == (24000, 1, 16, pcm)


def test_odd_length_pcm_is_trimmed():
    assert len(pcm_to_wav(b"\x00\x00\x00")) == 44 + 2


def test_parse_wav_with_extra_chunks_and_streaming_size():
    pcm = b"\x05\x00" * 50
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16)
    lst = b"LIST" + struct.pack("<I", 4) + b"INFO"
    data = b"data" + struct.pack("<I", 0xFFFFFFFF) + pcm
    wav = b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE" + fmt + lst + data
    assert parse_wav(wav) == (16000, 1, 16, pcm)


def test_normalize_adds_silence_and_wraps_raw_pcm():
    pcm = b"\x10\x00" * 160
    out = normalize_tts_audio(pcm, assume_pcm_rate=16000, silence_ms=100)
    rate, ch, bits, body = parse_wav(out)
    assert (rate, ch, bits) == (16000, 1, 16)
    assert body == pcm + b"\x00" * 3200

    rewrapped = normalize_tts_audio(pcm_to_wav(pcm, 22050), silence_ms=0)
    assert parse_wav(rewrapped) == (22050, 1, 16, pcm)


def test_normalize_passes_through_mp3_and_empty():
    mp3 = b"ID3\x03\x00\x00\x00" + b"\xff" * 20
    assert normalize_tts_audio(mp3) == mp3
    assert normalize_tts_audio(b"") is None and normalize_tts_audio(None) is None
