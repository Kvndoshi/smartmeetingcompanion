"""Quick live check of every provider that has a key in backend/.env.

Runs in-process (no server needed) and prints a PASS / SKIP / FAIL table:
  STT        stream ~12 s of fixtures/s2s_en.wav and expect a final transcript
  TTS        synthesise a short sentence in English and Spanish
  LLM        one tiny completion + check the configured model is listed
  Translator translate one sentence en -> es
  Memory     one Supermemory search

Usage (from backend/):  uv run python scripts/smoke_providers.py [--only stt,llm]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND / ".env")

from scripts.evaluation import chunks, resample_pcm16  # noqa: E402
from services.audio_utils import parse_wav  # noqa: E402
from services.providers import registry  # noqa: E402

CLIP = BACKEND / "fixtures" / "s2s_en.wav"
rows: list[tuple[str, str, str, str]] = []


def record(kind: str, provider: str, status: str, detail: str) -> None:
    rows.append((kind, provider, status, detail))
    print(f"  {status:<4} {kind:<10} {provider:<14} {detail}")


async def check_stt(pid: str) -> None:
    finals: list[str] = []
    errors: list[str] = []

    async def on_transcript(text, is_final, **_):
        if is_final and text.strip():
            finals.append(text.strip())

    async def on_error(message, **_):
        errors.append(str(message))

    cb = registry.SttCallbacks(on_transcript=on_transcript, on_error=on_error)
    client = registry.build_stt(pid, language="en", target_language=None, callbacks=cb)
    started = time.monotonic()
    await client.connect()
    if CLIP.exists():
        parsed = parse_wav(CLIP.read_bytes())
        assert parsed, "fixtures/s2s_en.wav is not a WAV"
        pcm = resample_pcm16(parsed[3], parsed[0], 16000, parsed[1]) + b"\x00" * 64000
        for frame in chunks(pcm, 3200):
            await client.send_audio(frame)
            await asyncio.sleep(0.05)  # 2x real time
        await asyncio.sleep(2.5)
    await client.close()
    if errors:
        raise RuntimeError("; ".join(errors)[:200])
    if CLIP.exists() and not finals:
        raise RuntimeError("connected but no final transcript")
    text = " ".join(finals)
    record("stt", pid, "PASS", f"{time.monotonic() - started:.1f}s · {text[:70] or 'connected (no fixture clip)'}")


async def check_tts(pid: str) -> None:
    client = registry.build_tts(pid)
    try:
        details = []
        for lang, text in (("en", "Hello, this is a quick test."), ("es", "Hola, esto es una prueba rápida.")):
            if not registry.TTS_SPECS[pid].supports(lang):
                details.append(f"{lang}: unsupported")
                continue
            started = time.monotonic()
            audio = await client.synthesize(text, lang)
            if not audio or len(audio) < 1000:
                raise RuntimeError(f"{lang}: no audio returned")
            parsed = parse_wav(audio)
            secs = f"{len(parsed[3]) / (parsed[0] * 2 * parsed[1]):.1f}s" if parsed else f"{len(audio)} bytes (non-WAV)"
            details.append(f"{lang}: {secs} in {time.monotonic() - started:.1f}s")
        record("tts", pid, "PASS", " · ".join(details))
    finally:
        await client.close()


async def check_llm(pid: str) -> None:
    for fast in (False, True):
        llm = registry.build_llm(pid, fast=fast)
        try:
            started = time.monotonic()
            out = await llm.complete([{"role": "user", "content": "Reply with exactly: OK"}], max_tokens=200, temperature=0)
            if not out.strip():
                raise RuntimeError(f"{llm.model}: empty completion")
            note = ""
            try:
                models = await llm.list_models()
                if models and llm.model not in models:
                    note = " (model not in /models list)"
            except Exception:  # noqa: BLE001
                pass
            record("llm", pid + (" fast" if fast else ""), "PASS", f"{llm.model}: {out.strip()[:30]!r} in {time.monotonic() - started:.1f}s{note}")
        finally:
            await llm.aclose()


async def check_translator(pid: str) -> None:
    from services import text_translator

    client = text_translator.build(pid)
    try:
        started = time.monotonic()
        out = await client.translate("Good morning, the launch moves to October 14th.", "en", "es")
        if not out.strip():
            raise RuntimeError("empty translation")
        record("translator", pid, "PASS", f"{out.strip()[:60]} ({time.monotonic() - started:.1f}s)")
    finally:
        await client.close()


async def check_memory() -> None:
    from supermemory.query import query_memories

    started = time.monotonic()
    result = await query_memories("launch date", limit=2, scope="all")
    record("memory", "supermemory", "PASS", f"{len(result.get('memories', []))} results in {time.monotonic() - started:.1f}s")


async def main(only: set[str]) -> int:
    print(f"Provider smoke test (keys from {BACKEND / '.env'})")
    if not CLIP.exists():
        print("  note: fixtures/s2s_en.wav missing — STT checks only connect. Run scripts/make_test_meeting.ps1 first.")
    jobs = []
    for kind, specs, fn in (("stt", registry.STT_SPECS, check_stt), ("tts", registry.TTS_SPECS, check_tts), ("llm", registry.LLM_SPECS, check_llm)):
        if only and kind not in only:
            continue
        for pid in specs:
            if pid == "azure_diarize":  # same key and client as azure
                continue
            if not registry.is_configured(kind, pid):
                record(kind, pid, "SKIP", "no key")
                continue
            jobs.append((kind, pid, fn(pid)))
    if not only or "translator" in only:
        for pid in registry.TRANSLATOR_SPECS:
            if registry.is_configured("translator", pid):
                jobs.append(("translator", pid, check_translator(pid)))
            else:
                record("translator", pid, "SKIP", "no key")
    if not only or "memory" in only:
        if os.getenv("SUPERMEMORY_API_KEY", "").strip():
            jobs.append(("memory", "supermemory", check_memory()))
        else:
            record("memory", "supermemory", "SKIP", "no key")

    for kind, pid, coro in jobs:
        try:
            await asyncio.wait_for(coro, timeout=90)
        except Exception as exc:  # noqa: BLE001
            record(kind, pid, "FAIL", f"{type(exc).__name__}: {exc}"[:160])

    failed = [r for r in rows if r[2] == "FAIL"]
    passed = [r for r in rows if r[2] == "PASS"]
    print(f"\n{len(passed)} passed, {len(failed)} failed, {len(rows) - len(passed) - len(failed)} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="", help="comma-separated: stt,tts,llm,translator,memory")
    ns = parser.parse_args()
    sys.exit(asyncio.run(main({x.strip() for x in ns.only.split(",") if x.strip()})))
