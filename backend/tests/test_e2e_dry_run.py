"""Runs scripts/e2e_meeting.py against a real uvicorn server with fake providers.

Proves the E2E plumbing (WebSocket streaming, meeting storage, auto-summary,
chat, speech-to-speech, report writing) works before any API key is added.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from services.audio_utils import pcm_to_wav

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "meeting_script.json"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live_server(fakes, fake_llm):
    import main

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


def test_e2e_script_runs_end_to_end_with_fakes(live_server, fakes, fake_llm, tmp_path):
    from scripts import e2e_meeting

    script = json.loads(SCRIPT_PATH.read_text(encoding="utf-8"))
    # The fake STT "hears" the script perfectly, alternating speakers.
    fakes.script = [("transcript", line["text"], True, "1" if line["speaker"] == "Maya" else "2") for line in script["lines"]]
    fakes.script.append(("translation", "Buenos días a todos.", True, "1"))
    # The fake LLM's summary contains every expected decision and action item.
    summary = {
        "title": "Launch sync",
        "overview": "Launch moved.",
        "decisions": [
            "Launch moves to October 14th",
            "Use Stripe for payments",
            "Hire a contract QA tester for six weeks",
            "Status meeting moves to Thursdays at 10 AM",
        ],
        "action_items": [
            {"task": "Finish the Stripe integration", "owner": "Daniel", "due": "October 3rd"},
            {"task": "Send the launch plan to marketing", "owner": "Maya", "due": "Friday"},
            {"task": "Post the QA job listing", "owner": "Daniel", "due": "Wednesday"},
            {"task": "Fix the Android login crash", "owner": "Daniel", "due": "Monday"},
            {"task": "Schedule a design review with Priya", "owner": "Maya", "due": "Tuesday"},
        ],
    }
    fake_llm.responses = [json.dumps(summary)] * 3
    fake_llm.chunks = ["The launch moves to October 14th."]

    silence = pcm_to_wav(b"\x00\x00" * 8000)  # 0.5 s
    (tmp_path / "meeting.wav").write_bytes(silence)
    (tmp_path / "clip.wav").write_bytes(silence)
    args = e2e_meeting.parse_args(
        [
            "--base", live_server,
            "--speed", "50",
            "--quiet", "0.6",
            "--targets", "es",
            "--meeting-wav", str(tmp_path / "meeting.wav"),
            "--clip-wav", str(tmp_path / "clip.wav"),
            "--report-dir", str(tmp_path / "reports"),
        ]
    )
    report = asyncio.run(e2e_meeting.run(args))

    stt = report["transcription"][0]
    assert stt["provider"] == "fake" and "error" not in stt, stt
    assert stt["accuracy"] == 1.0 and stt["speakers"] == ["S1", "S2"]
    assert report["summary"]["passed"], report["summary"]
    chat = report["chat"]
    assert chat["total"] == len(script["qa"])
    assert any(i["correct"] for i in chat["items"]) and not chat["passed"]  # the fake LLM always says the same thing
    s2s = report["s2s"][0]
    assert s2s["translated_text"] == "Buenos días a todos." and s2s["audio_seconds"] > 0
    assert Path(report["report_path"]).exists()
    md = Path(report["report_path"]).read_text(encoding="utf-8")
    assert "STT accuracy (fake)" in md and "100.0%" in md
