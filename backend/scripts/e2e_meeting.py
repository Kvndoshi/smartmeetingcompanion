"""End-to-end check of the IFT 593 charter success criteria against a running backend.

Streams fixtures/meeting.wav to ws://.../ws/translate exactly like the extension
(16 kHz mono Int16 PCM, 100 ms chunks, real time), then checks:

  1. STT accuracy >= 85%      (WER <= 15% vs the script, per STT provider)
  2. Summary captures every decision and action item
  3. Chatbot >= 80% correct   (keyword grading, optional LLM judge)
  4. Speech-to-speech en -> es and en -> fr: translated text + audio, audio
     transcribed back and compared with the translated text

Writes a Markdown + JSON report to backend/reports/.

Usage (from backend/, server running: uv run uvicorn main:app --port 8000):
  powershell -ExecutionPolicy Bypass -File scripts/make_test_meeting.ps1   # once
  uv run python scripts/e2e_meeting.py                    # default STT provider
  uv run python scripts/e2e_meeting.py --stt all --judge  # every configured STT, LLM judge
  uv run python scripts/e2e_meeting.py --speed 2          # stream 2x faster than real time
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import websockets

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from scripts.evaluation import (  # noqa: E402
    chunks,
    grade_summary,
    match_groups,
    resample_pcm16,
    token_f1,
    word_error_rate,
)
from services.audio_utils import parse_wav  # noqa: E402

CHUNK = 3200  # 100 ms of 16 kHz Int16 mono
TARGETS = {"stt_accuracy": 0.85, "chat_accuracy": 0.80, "s2s_similarity": 0.5}


class LiveSocket:
    """Minimal client for /ws/translate that records every server message."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.messages: list[dict[str, Any]] = []
        self.audio: list[bytes] = []
        self.last_activity = time.monotonic()
        self._changed = asyncio.Event()
        self._task = asyncio.create_task(self._recv())

    async def _recv(self) -> None:
        try:
            async for msg in self.ws:
                if isinstance(msg, bytes):
                    self.audio.append(msg)
                else:
                    self.messages.append(json.loads(msg))
                self.last_activity = time.monotonic()
                self._changed.set()
        except websockets.ConnectionClosed:
            pass
        finally:
            self._changed.set()

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [m for m in self.messages if m.get("type") == kind]

    async def wait_for(self, kind: str, timeout: float, *, start: int = 0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            for m in self.messages[start:]:
                if m.get("type") == kind:
                    return m
                if m.get("type") == "error" and kind != "error":
                    raise RuntimeError(f"{m.get('code')}: {m.get('message')}")
            if self._task.done():
                raise RuntimeError(f"socket closed while waiting for '{kind}'")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no '{kind}' within {timeout:.0f}s")
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), timeout=min(remaining, 1.0))
            except asyncio.TimeoutError:
                pass

    async def wait_quiet(self, quiet_s: float, max_s: float) -> None:
        deadline = time.monotonic() + max_s
        while time.monotonic() < deadline and time.monotonic() - self.last_activity < quiet_s:
            await asyncio.sleep(0.2)

    async def stream(self, pcm: bytes, speed: float, tail_silence_s: float = 2.0) -> None:
        start = time.monotonic()
        frames = chunks(pcm, CHUNK) + [b"\x00" * CHUNK] * int(tail_silence_s * 10)
        for i, frame in enumerate(frames):
            await self.ws.send(frame)
            delay = start + (i + 1) * 0.1 / speed - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)

    async def close(self) -> None:
        await self.ws.close()
        self._task.cancel()


async def open_session(ws_base: str, config: dict[str, Any]) -> tuple[LiveSocket, dict[str, Any]]:
    ws = await websockets.connect(f"{ws_base}/ws/translate", max_size=None, open_timeout=15)
    sock = LiveSocket(ws)
    await ws.send(json.dumps({"type": "config", **config}))
    try:
        session = await sock.wait_for("session", timeout=45)
    except Exception:
        await sock.close()
        raise
    return sock, session


def load_pcm(path: Path) -> bytes:
    parsed = parse_wav(path.read_bytes())
    if not parsed:
        raise SystemExit(f"{path} is not a PCM WAV file")
    rate, channels, bits, pcm = parsed
    if bits != 16:
        raise SystemExit(f"{path} must be 16-bit PCM")
    return resample_pcm16(pcm, rate, 16000, channels)


# ── 1. Live transcription ─────────────────────────────────────────────


async def run_transcription(args: argparse.Namespace, provider: str, pcm: bytes, reference: str) -> dict[str, Any]:
    result: dict[str, Any] = {"provider": provider}
    started = time.monotonic()
    sock, session = await open_session(
        args.ws,
        {
            "source_lang": "en",
            "target_lang": "en",
            "mode": {"translate": False, "transcribe": True},
            "stt_provider": provider,
            "tab_url": "https://meet.google.com/e2e-test-run",
            "tab_title": f"E2E test meeting ({provider})",
        },
    )
    meeting_id = session["meeting_id"]
    result.update(meeting_id=meeting_id, diarization=session.get("diarization"))
    try:
        first_final_at: float | None = None
        stream_task = asyncio.create_task(sock.stream(pcm, args.speed))
        while not stream_task.done():
            if first_final_at is None and any(m.get("is_final") for m in sock.of("transcript")):
                first_final_at = time.monotonic() - started
            await asyncio.sleep(0.2)
        await stream_task
        await sock.wait_quiet(args.quiet, 20.0)
        mark = len(sock.messages)
        await sock.ws.send(json.dumps({"type": "stop", "end_meeting": True}))
        await sock.wait_for("meeting_ended", timeout=60, start=mark)
        result["first_final_s"] = round(first_final_at, 2) if first_final_at else None
        result["errors"] = [m["message"] for m in sock.of("error")]
        result["warnings"] = [m["message"] for m in sock.of("warning")]
    finally:
        await sock.close()

    async with httpx.AsyncClient(base_url=args.base, timeout=60) as http:
        meeting = (await http.get(f"/api/meetings/{meeting_id}")).json()
    segments = meeting.get("segments", [])
    hypothesis = " ".join(s["text"] for s in segments)
    wer = word_error_rate(reference, hypothesis)
    speakers = sorted({s.get("speaker") for s in segments if s.get("speaker")})
    result.update(
        wer=round(wer["wer"], 4),
        accuracy=round(1 - wer["wer"], 4),
        wer_detail=wer,
        segments=len(segments),
        speakers=speakers,
        passed=(1 - wer["wer"]) >= TARGETS["stt_accuracy"],
        hypothesis_preview=hypothesis[:600],
        duration_s=round(time.monotonic() - started, 1),
    )
    return result


# ── 2. Summary ────────────────────────────────────────────────────────


async def run_summary(args: argparse.Namespace, meeting_id: str, script: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=args.base, timeout=180) as http:
        meeting: dict[str, Any] = {}
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:  # auto-summary runs when the meeting ends
            meeting = (await http.get(f"/api/meetings/{meeting_id}", params={"after_id": 10**9})).json()
            if meeting.get("summary_status") in ("ready", "error"):
                break
            await asyncio.sleep(2)
        if meeting.get("summary_status") != "ready":
            res = await http.post(f"/api/meetings/{meeting_id}/summarize", json={})
            if res.status_code != 200:
                return {"passed": False, "error": res.text[:500]}
            meeting = res.json()["meeting"]
    summary = meeting.get("summary") or {}
    graded = grade_summary(summary, script["expected_decisions"], script["expected_action_items"])
    return {
        "passed": graded["all_captured"],
        "found": graded["found"],
        "total": graded["total"],
        "decisions": graded["decisions"],
        "action_items": [{k: v for k, v in a.items() if k != "matched"} for a in graded["action_items"]],
        "title": summary.get("title"),
        "meta": summary.get("_meta"),
        "summary": summary,
    }


# ── 3. Chat ───────────────────────────────────────────────────────────


async def judge_answer(question: str, expected: str, answer: str) -> bool | None:
    from dotenv import load_dotenv

    load_dotenv(BACKEND / ".env")
    from services.llm.openai_compat import extract_json
    from services.providers import registry

    try:
        llm = registry.build_llm()
    except Exception:  # noqa: BLE001
        return None
    try:
        raw = await llm.complete(
            [
                {"role": "system", "content": "You grade answers from a meeting assistant. Reply with JSON {\"correct\": true|false}. "
                 "An answer is correct when it states the expected facts (extra correct detail is fine)."},
                {"role": "user", "content": f"Question: {question}\nExpected: {expected}\nAnswer: {answer}"},
            ],
            json_mode=True,
            temperature=0.0,
        )
        return bool(extract_json(raw).get("correct"))
    except Exception:  # noqa: BLE001
        return None
    finally:
        await llm.aclose()


async def run_chat(args: argparse.Namespace, meeting_id: str, script: dict[str, Any]) -> dict[str, Any]:
    items = []
    async with httpx.AsyncClient(base_url=args.base, timeout=180) as http:
        await http.delete("/api/chat/history", params={"meeting_id": meeting_id})
        for qa in script["qa"]:
            started = time.monotonic()
            res = await http.post("/api/chat", json={"question": qa["q"], "meeting_id": meeting_id, "stream": False})
            body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
            answer = body.get("answer") or body.get("detail") or res.text[:300]
            keyword_ok = res.status_code == 200 and match_groups(answer, qa["keywords"])
            judged = None
            if args.judge and not keyword_ok and res.status_code == 200:
                judged = await judge_answer(qa["q"], qa["a"], answer)
            items.append(
                {
                    "question": qa["q"],
                    "expected": qa["a"],
                    "answer": answer,
                    "keyword_correct": keyword_ok,
                    "judge_correct": judged,
                    "correct": keyword_ok or bool(judged),
                    "latency_s": round(time.monotonic() - started, 2),
                }
            )
    correct = sum(i["correct"] for i in items)
    accuracy = correct / len(items) if items else 0.0
    return {"passed": accuracy >= TARGETS["chat_accuracy"], "accuracy": round(accuracy, 3), "correct": correct, "total": len(items), "items": items}


# ── 4. Speech-to-speech ───────────────────────────────────────────────


async def run_s2s(args: argparse.Namespace, target: str, pcm: bytes, reference: str) -> dict[str, Any]:
    result: dict[str, Any] = {"target": target}
    config = {
        "source_lang": "en",
        "target_lang": target,
        "mode": {"translate": True, "transcribe": False},
        "tab_url": "https://meet.google.com/e2e-test-run",
    }
    if args.s2s_stt:
        config["stt_provider"] = args.s2s_stt
    if args.tts:
        config["tts_provider"] = args.tts
    started = time.monotonic()
    sock, session = await open_session(args.ws, config)
    result.update(stt=session.get("stt_provider"), tts=session.get("tts_provider"), translator=session.get("translator"))
    try:
        await sock.stream(pcm, args.speed, tail_silence_s=3.0)
        await sock.wait_quiet(args.quiet + 1.0, 30.0)
        translated = " ".join(m["text"] for m in sock.of("translated_text")).strip()
        first_audio = None
        result.update(
            translated_text=translated,
            source_transcript=" ".join(m["text"] for m in sock.of("transcript") if m.get("is_final")),
            audio_chunks=len(sock.audio),
            errors=[m["message"] for m in sock.of("error")],
            warnings=[m["message"] for m in sock.of("warning")],
        )
        if sock.audio:
            first_audio = sock.audio[0]
    finally:
        await sock.close()

    pcm_out = b""
    seconds = 0.0
    for clip in sock.audio:
        parsed = parse_wav(clip)
        if parsed and parsed[2] == 16:
            rate, channels, _bits, body = parsed
            pcm_out += resample_pcm16(body, rate, 16000, channels)
    seconds = len(pcm_out) / 32000
    result["audio_seconds"] = round(seconds, 2)
    result["audio_format"] = "wav" if first_audio and first_audio[:4] == b"RIFF" else ("mp3/other" if first_audio else None)

    back = ""
    if pcm_out and not args.no_backcheck:
        try:
            back_sock, _ = await open_session(
                args.ws,
                {"source_lang": target, "target_lang": target, "mode": {"translate": False, "transcribe": False}},
            )
            try:
                await back_sock.stream(pcm_out, max(2.0, args.speed), tail_silence_s=2.0)
                await back_sock.wait_quiet(args.quiet, 20.0)
                back = " ".join(m["text"] for m in back_sock.of("transcript") if m.get("is_final"))
            finally:
                await back_sock.close()
        except Exception as exc:  # noqa: BLE001
            result["backcheck_error"] = str(exc)
    similarity = token_f1(translated, back) if back else None
    result.update(
        back_transcript=back,
        similarity=round(similarity, 3) if similarity is not None else None,
        duration_s=round(time.monotonic() - started, 1),
    )
    has_audio = seconds > 0.5 or result["audio_format"] == "mp3/other"
    result["passed"] = bool(translated) and has_audio and (similarity is None or similarity >= TARGETS["s2s_similarity"])
    return result


# ── report ────────────────────────────────────────────────────────────


def mark(ok: bool | None) -> str:
    return "PASS" if ok else ("—" if ok is None else "FAIL")


def write_report(report: dict[str, Any], report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (report_dir / f"e2e-{stamp}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    lines = [f"# Distill end-to-end report — {time.strftime('%Y-%m-%d %H:%M')}", "", "| Criterion | Target | Result | Status |", "|---|---|---|---|"]
    for stt in report["transcription"]:
        if "error" in stt:
            lines.append(f"| STT accuracy ({stt['provider']}) | ≥ 85% | error: {stt['error'][:80]} | FAIL |")
        else:
            lines.append(f"| STT accuracy ({stt['provider']}) | ≥ 85% | {stt['accuracy']:.1%} (WER {stt['wer']:.1%}, {len(stt['speakers'])} speakers) | {mark(stt['passed'])} |")
    s = report.get("summary")
    if s:
        lines.append(f"| Summary captures decisions + action items | all | {s.get('found', 0)}/{s.get('total', 0)} | {mark(s['passed'])} |")
    c = report.get("chat")
    if c:
        lines.append(f"| Chatbot accuracy | ≥ 80% | {c['accuracy']:.0%} ({c['correct']}/{c['total']}) | {mark(c['passed'])} |")
    for x in report.get("s2s", []):
        if "error" in x:
            lines.append(f"| Speech-to-speech en→{x['target']} | text + audio | error: {x['error'][:80]} | FAIL |")
        else:
            sim = f", back-check F1 {x['similarity']:.2f}" if x.get("similarity") is not None else ""
            lines.append(f"| Speech-to-speech en→{x['target']} | text + audio | {x['audio_seconds']}s audio{sim} | {mark(x['passed'])} |")
    lines += ["", "Synthetic voices (Windows Zira/David) are cleaner than real meeting audio; treat STT numbers as an upper bound.", ""]
    if s and s.get("summary"):
        lines += ["## Summary", "", f"**{s['summary'].get('title', '')}** — {s['summary'].get('overview', '')}", ""]
        lines += [f"- {'✅' if d['found'] else '❌'} Decision: {d['label']}" for d in s["decisions"]]
        lines += [f"- {'✅' if a['found'] else '❌'} Action: {a['label']}" + ("" if a["owner_correct"] else " (owner not attributed)") for a in s["action_items"]]
        lines.append("")
    if c:
        lines += ["## Chat", "", "| # | Question | Answer | OK |", "|---|---|---|---|"]
        for i, item in enumerate(c["items"], 1):
            ans = item["answer"].replace("\n", " ").replace("|", "/")[:160]
            lines.append(f"| {i} | {item['question']} | {ans} | {'✅' if item['correct'] else '❌'} |")
        lines.append("")
    for x in report.get("s2s", []):
        if "error" in x:
            continue
        lines += [f"## Speech-to-speech en→{x['target']} ({x.get('stt')} → {x.get('translator')} → {x.get('tts')})", "",
                  f"- Translated: {x['translated_text'][:400]}", f"- Audio transcribed back: {x.get('back_transcript', '')[:400]}", ""]
    path = report_dir / f"e2e-{stamp}.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


async def run(args: argparse.Namespace) -> dict[str, Any]:
    script = json.loads(Path(args.script).read_text(encoding="utf-8"))
    reference = " ".join(line["text"] for line in script["lines"])
    meeting_pcm = load_pcm(Path(args.meeting_wav))
    clip_pcm = load_pcm(Path(args.clip_wav))

    async with httpx.AsyncClient(base_url=args.base, timeout=15) as http:
        providers = (await http.get("/api/providers")).json()
    configured = [p["id"] for p in providers["stt"]["providers"] if p["configured"]]
    if args.stt == "auto":
        stt_list = [providers["stt"]["default"]] if providers["stt"]["default"] else []
    elif args.stt == "all":
        stt_list = configured
    else:
        stt_list = [s.strip() for s in args.stt.split(",") if s.strip()]
    if not stt_list:
        raise SystemExit("No speech-to-text provider is configured. Add a key in backend/.env or the dashboard.")

    report: dict[str, Any] = {"base": args.base, "speed": args.speed, "providers": providers, "transcription": [], "s2s": []}
    print(f"Streaming {len(meeting_pcm) / 32000:.0f}s meeting at {args.speed}x to: {', '.join(stt_list)}")
    for provider in stt_list:
        try:
            res = await run_transcription(args, provider, meeting_pcm, reference)
            print(f"  {provider}: accuracy {res['accuracy']:.1%}, {res['segments']} segments, speakers {res['speakers']}")
        except Exception as exc:  # noqa: BLE001
            res = {"provider": provider, "error": str(exc), "passed": False}
            print(f"  {provider}: ERROR {exc}")
        report["transcription"].append(res)

    best = max((r for r in report["transcription"] if "error" not in r), key=lambda r: r["accuracy"], default=None)
    if best and not args.skip_llm:
        print(f"Summary + chat on the {best['provider']} transcript…")
        report["summary"] = await run_summary(args, best["meeting_id"], script)
        print(f"  summary: {report['summary'].get('found')}/{report['summary'].get('total')} expected items")
        report["chat"] = await run_chat(args, best["meeting_id"], script)
        print(f"  chat: {report['chat']['accuracy']:.0%}")
    for target in [t.strip() for t in args.targets.split(",") if t.strip()]:
        try:
            res = await run_s2s(args, target, clip_pcm, script["s2s_clip"]["text"])
            print(f"  s2s en→{target}: {'PASS' if res['passed'] else 'FAIL'} ({res['audio_seconds']}s audio, similarity {res['similarity']})")
        except Exception as exc:  # noqa: BLE001
            res = {"target": target, "error": str(exc), "passed": False}
            print(f"  s2s en→{target}: ERROR {exc}")
        report["s2s"].append(res)

    checks = [r["passed"] for r in report["transcription"]] + [x["passed"] for x in report["s2s"]]
    if "summary" in report:
        checks += [report["summary"]["passed"], report["chat"]["passed"]]
    report["passed"] = all(checks) and bool(checks)
    if args.cleanup:
        async with httpx.AsyncClient(base_url=args.base, timeout=30) as http:
            for r in report["transcription"]:
                if r.get("meeting_id"):
                    await http.delete(f"/api/meetings/{r['meeting_id']}")
    report["report_path"] = str(write_report(report, Path(args.report_dir)))
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    fixtures = BACKEND / "fixtures"
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="http://localhost:8000")
    p.add_argument("--stt", default="auto", help="auto | all | comma-separated provider ids")
    p.add_argument("--s2s-stt", default=None, help="STT provider for the speech-to-speech check (default: auto)")
    p.add_argument("--tts", default=None, help="TTS provider for the speech-to-speech check (default: auto)")
    p.add_argument("--targets", default="es,fr")
    p.add_argument("--speed", type=float, default=1.0, help="streaming speed multiplier (1 = real time)")
    p.add_argument("--quiet", type=float, default=3.0, help="seconds without server messages before a phase is done")
    p.add_argument("--judge", action="store_true", help="use the LLM to grade chat answers that miss the keywords")
    p.add_argument("--skip-llm", action="store_true", help="skip summary and chat checks")
    p.add_argument("--no-backcheck", action="store_true", help="don't transcribe translated audio back")
    p.add_argument("--cleanup", action="store_true", help="delete the test meetings afterwards")
    p.add_argument("--script", default=str(fixtures / "meeting_script.json"))
    p.add_argument("--meeting-wav", default=str(fixtures / "meeting.wav"))
    p.add_argument("--clip-wav", default=str(fixtures / "s2s_en.wav"))
    p.add_argument("--report-dir", default=str(BACKEND / "reports"))
    args = p.parse_args(argv)
    args.base = args.base.rstrip("/")
    args.ws = args.base.replace("https://", "wss://").replace("http://", "ws://")
    for path in (args.meeting_wav, args.clip_wav):
        if not Path(path).exists():
            p.error(f"{path} not found — run: powershell -ExecutionPolicy Bypass -File scripts/make_test_meeting.ps1")
    return args


def main() -> None:
    args = parse_args()
    report = asyncio.run(run(args))
    print(f"\nReport: {report['report_path']}")
    print("ALL CRITERIA PASSED" if report["passed"] else "SOME CRITERIA FAILED — see the report")
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
