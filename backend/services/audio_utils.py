"""Small WAV/PCM helpers shared by TTS providers and the live session.

The extension plays WAV (offscreen) and injects 16 kHz Int16 mono PCM into the
outgoing WebRTC track (Meet interceptor), so every TTS provider is normalised
to a canonical 44-byte-header WAV here.
"""

from __future__ import annotations

import struct

PCM_SAMPLE_RATE = 16000


def is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def pcm_to_wav(pcm: bytes, sample_rate: int = PCM_SAMPLE_RATE, channels: int = 1, bits: int = 16) -> bytes:
    """Wrap raw little-endian PCM in a canonical WAV header."""
    if len(pcm) % 2:
        pcm = pcm[:-1]
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits,
        b"data",
        len(pcm),
    )
    return header + pcm


def parse_wav(data: bytes) -> tuple[int, int, int, bytes] | None:
    """Return (sample_rate, channels, bits, pcm) for a PCM WAV, else None.

    Walks the chunk list instead of assuming a 44-byte header, so WAVs with
    LIST/fact chunks (common from cloud TTS) are handled.
    """
    if not is_wav(data):
        return None
    offset = 12
    sample_rate, channels, bits, fmt_tag = PCM_SAMPLE_RATE, 1, 16, 1
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", data, offset + 4)
        body = offset + 8
        if chunk_id == b"fmt " and chunk_size >= 16 and body + 16 <= len(data):
            fmt_tag, channels, sample_rate = struct.unpack_from("<HHI", data, body)
            (bits,) = struct.unpack_from("<H", data, body + 14)
        elif chunk_id == b"data":
            # Streaming TTS often writes 0 / 0xFFFFFFFF as the data size.
            end = len(data) if chunk_size in (0, 0xFFFFFFFF) else min(len(data), body + chunk_size)
            if fmt_tag not in (1, 0xFFFE):
                return None
            return sample_rate, channels, bits, data[body:end]
        offset = body + chunk_size + (chunk_size & 1)
    return None


def normalize_tts_audio(data: bytes | None, *, silence_ms: int = 150, assume_pcm_rate: int | None = None) -> bytes | None:
    """Return a canonical WAV (with trailing silence) for any PCM/WAV input.

    - WAV in → re-wrapped canonical WAV, same sample rate.
    - Raw PCM in (``assume_pcm_rate`` given) → WAV at that rate.
    - Anything else (e.g. MP3) is returned unchanged; the offscreen player
      handles it, but it cannot be injected into the Meet mic track.
    """
    if not data:
        return None
    parsed = parse_wav(data)
    if parsed:
        rate, channels, bits, pcm = parsed
        if bits != 16:
            return data
    elif assume_pcm_rate:
        rate, channels, pcm = assume_pcm_rate, 1, data
    else:
        return data
    if silence_ms > 0:
        pcm = pcm + b"\x00" * (int(rate * channels * 2 * silence_ms / 1000) & ~1)
    return pcm_to_wav(pcm, sample_rate=rate, channels=channels)
