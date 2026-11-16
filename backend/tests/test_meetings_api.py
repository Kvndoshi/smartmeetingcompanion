"""Meetings store + REST API, summarizer, chat (RAG) and Supermemory sync."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from tests.conftest import SAMPLE_SUMMARY, FakeLLM, make_meeting, parse_sse

SEGMENTS = [
    ("S1", "Good morning, let's review the Q3 budget."),
    ("S2", "The budget is ten percent under plan."),
    ("S1", "We decided to move the launch to October third."),
    ("S2", "Alice will send the revised budget by Friday."),
]


# ── store ─────────────────────────────────────────────────────────────


def test_store_platform_detection_fts_and_cascade(fakes):
    from services import meeting_store

    assert meeting_store.detect_platform("https://teams.microsoft.com/l/meetup-join/x") == "microsoft_teams"
    assert meeting_store.detect_platform("https://app.zoom.us/wc/123/join") == "zoom"
    assert meeting_store.detect_platform("https://meet.google.com/abc") == "google_meet"
    assert meeting_store.detect_platform(None) == "other"

    meeting = make_meeting(SEGMENTS)
    assert meeting["platform"] == "google_meet" and meeting["status"] == "live"
    hits = meeting_store.search_segments("launch october", meeting_id=meeting["id"])
    assert hits and "October" in hits[0]["text"]
    # Punctuation / FTS syntax in user questions must not crash the search.
    assert isinstance(meeting_store.search_segments('what "about" (budget)? AND OR *'), list)
    assert [m["id"] for m in meeting_store.list_meetings(query="revised budget")] == [meeting["id"]]

    meeting_store.add_chat_message(meeting["id"], "user", "hi")
    assert meeting_store.delete_meeting(meeting["id"])
    assert meeting_store.list_segments(meeting["id"]) == []
    assert meeting_store.list_chat_messages(meeting["id"]) == []
    assert meeting_store.search_segments("budget") == []


def test_finalize_stale_ends_idle_live_meetings(fakes):
    from services import meeting_store

    meeting = make_meeting(SEGMENTS)
    conn = meeting_store._conn()
    conn.execute("UPDATE meetings SET last_activity_at = last_activity_at - 3600 WHERE id = ?", (meeting["id"],))
    conn.commit()
    assert meeting_store.finalize_stale(900) == [meeting["id"]]
    assert meeting_store.get_meeting(meeting["id"])["status"] == "ended"


# ── REST ──────────────────────────────────────────────────────────────


def test_rest_list_get_patch_delete(client):
    meeting = make_meeting(SEGMENTS)
    mid = meeting["id"]

    listed = client.get("/api/meetings").json()["meetings"]
    assert [m["id"] for m in listed] == [mid]

    full = client.get(f"/api/meetings/{mid}").json()
    assert len(full["segments"]) == 4 and full["platform_label"]
    after = client.get(f"/api/meetings/{mid}", params={"after_id": full["segments"][1]["id"]}).json()
    assert [s["text"] for s in after["segments"]] == [SEGMENTS[2][1], SEGMENTS[3][1]]

    patched = client.patch(
        f"/api/meetings/{mid}", json={"title": "Budget sync", "speaker_names": {"S1": "Bob"}, "user_notes": "remember vendors"}
    ).json()
    assert patched["title"] == "Budget sync"
    assert patched["speaker_names"] == {"S1": "Bob"}
    assert patched["user_notes"] == "remember vendors"

    assert client.get("/api/meetings/nope").status_code == 404
    assert client.delete(f"/api/meetings/{mid}").json() == {"deleted": mid}
    assert client.get(f"/api/meetings/{mid}").status_code == 404


def test_summarize_endpoint_persists_summary_and_replaces_auto_title(client, fake_llm):
    meeting = make_meeting(SEGMENTS)
    assert " · " in meeting["title"]
    res = client.post(f"/api/meetings/{meeting['id']}/summarize", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["summary"]["decisions"] == SAMPLE_SUMMARY["decisions"]
    assert body["summary"]["_meta"]["segment_count"] == 4
    assert body["meeting"]["summary_status"] == "ready"
    assert body["meeting"]["title"] == "Q3 budget review"
    # The transcript reached the model with speaker labels and timestamps.
    prompt = fake_llm.calls[0][-1]["content"]
    assert "[00:10] Speaker 1: We decided to move the launch" in prompt
    assert fake_llm.closed == 1


def test_summarize_keeps_user_title_and_uses_names_and_notes(client, fake_llm):
    meeting = make_meeting(SEGMENTS)
    client.patch(f"/api/meetings/{meeting['id']}", json={"title": "My title", "speaker_names": {"S2": "Alice"}, "user_notes": "vendor B?"})
    body = client.post(f"/api/meetings/{meeting['id']}/summarize").json()
    assert body["meeting"]["title"] == "My title"
    prompt = fake_llm.calls[0][-1]["content"]
    assert "Alice: The budget is ten percent under plan." in prompt
    assert "vendor B?" in prompt


def test_summarize_repairs_invalid_json(client, fake_llm):
    fake_llm.responses = ["Sorry, here are notes: decisions were made", json.dumps(SAMPLE_SUMMARY)]
    meeting = make_meeting(SEGMENTS)
    body = client.post(f"/api/meetings/{meeting['id']}/summarize").json()
    assert body["summary"]["action_items"][0]["owner"] == "Alice"
    assert len(fake_llm.calls) == 2
    assert "not valid JSON" in fake_llm.calls[1][-1]["content"]


def test_summarize_errors(client):
    empty = make_meeting([])
    # No LLM key configured at all.
    res = client.post(f"/api/meetings/{empty['id']}/summarize")
    assert res.status_code == 400 and "GEMINI_API_KEY or GROQ_API_KEY" in res.json()["detail"]
    assert client.get(f"/api/meetings/{empty['id']}").json()["summary_status"] == "error"


def test_summarize_empty_transcript(client, fake_llm):
    empty = make_meeting([])
    res = client.post(f"/api/meetings/{empty['id']}/summarize")
    assert res.status_code == 400 and "no transcript" in res.json()["detail"]


def test_lenient_summary_validation():
    from services.summarizer import MeetingSummary

    s = MeetingSummary.model_validate(
        {"decisions": "Ship it", "action_items": ["Write docs", {"action": "Fix bug", "assignee": "Sam", "deadline": "Mon"}], "topics": ["Intro"]}
    )
    assert s.decisions == ["Ship it"]
    assert [(a.task, a.owner, a.due) for a in s.action_items] == [("Write docs", None, None), ("Fix bug", "Sam", "Mon")]
    assert s.topics[0].title == "Intro"


def test_long_meeting_uses_map_reduce(fakes):
    from services import summarizer

    llm = FakeLLM()
    big = [{"speaker": "S1", "text": "x" * 25000, "start_ms": i * 1000} for i in range(3)]
    asyncio.run(summarizer.summarize_segments(big, llm=llm))
    assert len(llm.calls) == 3  # two map calls + one reduce
    assert "part 1 of 2" in llm.calls[0][-1]["content"]
    assert "Merge them" in llm.calls[2][-1]["content"]


def test_chunk_lines_and_timestamps():
    from services.summarizer import chunk_lines, fmt_ts

    assert chunk_lines(["aaaa", "bbbb", "cccc"], max_chars=10) == ["aaaa\nbbbb", "cccc"]
    assert fmt_ts(65_000) == "01:05" and fmt_ts(3_725_000) == "1:02:05" and fmt_ts(None) == "00:00"


def test_export_markdown(client):
    from services import meeting_store

    meeting = make_meeting(SEGMENTS)
    meeting_store.set_summary(meeting["id"], status="ready", summary=SAMPLE_SUMMARY)
    md = client.get(f"/api/meetings/{meeting['id']}/export.md").text
    assert "## Decisions\n- Launch moves to October 3" in md
    assert "- [ ] Send the revised budget (Alice, due Friday)" in md
    assert "## Transcript" in md and "Speaker 2: Alice will send" in md
    assert "## Transcript" not in client.get(f"/api/meetings/{meeting['id']}/export.md", params={"transcript": False}).text


# ── chat ──────────────────────────────────────────────────────────────


def test_chat_meeting_scope_streams_cites_and_persists(client, fake_llm):
    meeting = make_meeting(SEGMENTS)
    res = client.post("/api/chat", json={"question": "Who owns the budget?", "meeting_id": meeting["id"]})
    assert res.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(res.text)
    assert [e["type"] for e in events] == ["sources", "delta", "delta", "delta", "done"]
    assert events[0]["sources"][0]["meeting_id"] == meeting["id"]
    system = fake_llm.calls[0][0]["content"]
    assert "ONLY the meeting context" in system and "Alice will send the revised budget" in system

    history = client.get("/api/chat/history", params={"meeting_id": meeting["id"]}).json()["messages"]
    assert [(m["role"], m["content"]) for m in history] == [
        ("user", "Who owns the budget?"),
        ("assistant", "Alice owns the budget [00:05]."),
    ]
    # Follow-up questions include the earlier turns.
    client.post("/api/chat", json={"question": "And when?", "meeting_id": meeting["id"]})
    roles = [m["role"] for m in fake_llm.calls[1]]
    assert roles == ["system", "user", "assistant", "user"]

    client.delete("/api/chat/history", params={"meeting_id": meeting["id"]})
    assert client.get("/api/chat/history", params={"meeting_id": meeting["id"]}).json()["messages"] == []


def test_chat_all_scope_uses_local_search_without_supermemory(client, fake_llm):
    budget = make_meeting(SEGMENTS)
    make_meeting([("S1", "Let's plan the offsite hiking trip.")], tab_url="https://teams.microsoft.com/x")
    res = client.post("/api/chat", json={"question": "What was decided about the launch?", "scope": "all", "stream": False})
    body = res.json()
    assert body["answer"] == "Alice owns the budget [00:05]."
    assert [s["meeting_id"] for s in body["sources"]] == [budget["id"]]
    assert body["sources"][0]["kind"] == "transcript"
    assert "[1]" in fake_llm.calls[0][0]["content"]


def test_chat_without_llm_reports_provider_config(client):
    meeting = make_meeting(SEGMENTS)
    events = parse_sse(client.post("/api/chat", json={"question": "hi", "meeting_id": meeting["id"]}).text)
    assert events == [{"type": "error", "message": events[0]["message"], "code": "provider_config"}]
    res = client.post("/api/chat", json={"question": "hi", "meeting_id": meeting["id"], "stream": False})
    assert res.status_code == 400


def test_chat_unknown_meeting_and_empty_question(client, fake_llm):
    events = parse_sse(client.post("/api/chat", json={"question": "hi", "meeting_id": "missing"}).text)
    assert events[0]["type"] == "error" and "not found" in events[0]["message"]
    assert client.post("/api/chat", json={"question": ""}).status_code == 422


def test_long_meeting_chat_context_uses_search(fakes, monkeypatch):
    from services import chat

    monkeypatch.setattr(chat, "CONTEXT_CHARS", 200)
    meeting = make_meeting(SEGMENTS + [("S3", "filler " * 40)])
    context, _ = chat.meeting_context(meeting, "launch")
    assert "Relevant passages:" in context and "October third" in context


# ── end-of-meeting post-processing + Supermemory ─────────────────────


def test_finalize_summarizes_then_marks_memory_no_key(fake_llm):
    from services import meeting_store, postprocess

    meeting = make_meeting(SEGMENTS)
    meeting_store.end_meeting(meeting["id"])
    asyncio.run(postprocess.finalize_meeting(meeting["id"]))
    after = meeting_store.get_meeting(meeting["id"])
    assert after["summary_status"] == "ready"
    assert after["memory_status"] == "no_key"
    assert meeting_store.meetings_needing_memory_sync() == [meeting["id"]]


def test_finalize_without_llm_records_error_but_keeps_meeting(fakes):
    from services import meeting_store, postprocess

    meeting = make_meeting(SEGMENTS)
    asyncio.run(postprocess.finalize_meeting(meeting["id"]))
    after = meeting_store.get_meeting(meeting["id"])
    assert after["summary_status"] == "error" and "GROQ_API_KEY" in after["summary_error"]


def test_auto_summary_can_be_disabled(fake_llm, monkeypatch):
    from services import meeting_store, postprocess

    monkeypatch.setenv("AUTO_SUMMARY", "0")
    meeting = make_meeting(SEGMENTS)
    asyncio.run(postprocess.finalize_meeting(meeting["id"]))
    assert fake_llm.calls == []
    assert meeting_store.get_meeting(meeting["id"])["summary_status"] in (None, "", "none")


def _memory_transport(log: list[httpx.Request], statuses: list[int]):
    def handler(request: httpx.Request) -> httpx.Response:
        log.append(request)
        status = statuses.pop(0) if statuses else 200
        if status in (200, 201):
            return httpx.Response(status, json={"id": f"doc-{len(log)}", "status": "queued"})
        return httpx.Response(status, json={"error": "nope"})

    return httpx.MockTransport(handler)


def test_supermemory_post_then_patch(fakes, monkeypatch):
    from services import meeting_store
    from supermemory import sync

    monkeypatch.setenv("SUPERMEMORY_API_KEY", "sm-test")
    meeting = make_meeting(SEGMENTS)
    log: list[httpx.Request] = []
    transport = _memory_transport(log, [])

    assert asyncio.run(sync.sync_meeting(meeting["id"], transport)) == "synced"
    first = json.loads(log[0].content)
    assert log[0].method == "POST" and log[0].url.path == "/v3/documents"
    assert log[0].headers["authorization"] == "Bearer sm-test"
    assert first["customId"] == f"meeting-{meeting['id']}"
    assert first["containerTag"] == "interpreter-sessions"
    assert first["metadata"]["platform"] == "google_meet" and first["metadata"]["segmentCount"] == 4
    assert all(isinstance(v, (str, int, float, bool)) for v in first["metadata"].values())
    assert "Alice will send the revised budget" in first["content"]
    assert meeting_store.get_meeting(meeting["id"])["memory_doc_id"] == "doc-1"

    meeting_store.add_segment(meeting["id"], text="One more thing.", speaker="S1")
    assert asyncio.run(sync.sync_meeting(meeting["id"], transport)) == "synced"
    assert log[1].method == "PATCH" and log[1].url.path == "/v3/documents/doc-1"
    assert "customId" not in json.loads(log[1].content)
    assert "One more thing." in json.loads(log[1].content)["content"]


def test_supermemory_patch_404_falls_back_to_post_and_errors_are_recorded(fakes, monkeypatch):
    from services import meeting_store
    from supermemory import sync

    monkeypatch.setenv("SUPERMEMORY_API_KEY", "sm-test")
    meeting = make_meeting(SEGMENTS)
    meeting_store.set_memory_status(meeting["id"], status="synced", doc_id="gone")
    log: list[httpx.Request] = []
    assert asyncio.run(sync.sync_meeting(meeting["id"], _memory_transport(log, [404, 200]))) == "synced"
    assert [r.method for r in log] == ["PATCH", "POST"]

    assert asyncio.run(sync.sync_meeting(meeting["id"], _memory_transport([], [500]))) == "error"
    after = meeting_store.get_meeting(meeting["id"])
    assert after["memory_status"] == "error" and "HTTP 500" in after["memory_error"]
    assert meeting_store.meetings_needing_memory_sync() == [meeting["id"]]


def test_supermemory_skips_empty_meetings(fakes, monkeypatch):
    from supermemory import sync

    monkeypatch.setenv("SUPERMEMORY_API_KEY", "sm-test")
    meeting = make_meeting([])
    assert asyncio.run(sync.sync_meeting(meeting["id"], _memory_transport([], []))) == "empty"


def test_youtube_meetings_use_video_container(fakes):
    from supermemory import sync

    meeting = make_meeting(SEGMENTS, tab_url="https://www.youtube.com/watch?v=abc123")
    payload = sync.build_payload(meeting, [], include_custom_id=True)
    assert payload["containerTag"] == "abc123"
    assert payload["metadata"]["platform"] == "youtube"


# ── settings / providers ─────────────────────────────────────────────


@pytest.fixture
def scrub_env(monkeypatch):
    """Variables the settings endpoint writes into os.environ get restored afterwards."""
    for var in ("GROQ_API_KEY", "STT_PROVIDER", "SOME_UNMANAGED"):
        monkeypatch.setenv(var, "placeholder")
        monkeypatch.delenv(var)


def test_settings_mask_skip_masked_and_reject_newlines(client, scrub_env):
    import main
    import os

    res = client.post("/api/settings", json={"settings": {"GROQ_API_KEY": "gsk_abcdefghijkl", "SOME_UNMANAGED": "x"}})
    assert res.json()["updated"] == ["GROQ_API_KEY"]
    assert os.environ["GROQ_API_KEY"] == "gsk_abcdefghijkl"

    got = client.get("/api/settings").json()
    assert got["GROQ_API_KEY"] == "gsk_****ijkl"
    assert got["_providers"]["llm"]["groq"] is True
    assert got["_defaults"]["llm"] == "groq"

    # Saving the masked value back must not overwrite the real key.
    client.post("/api/settings", json={"settings": {"GROQ_API_KEY": got["GROQ_API_KEY"], "STT_PROVIDER": "fake"}})
    assert "GROQ_API_KEY=gsk_abcdefghijkl" in main.ENV_PATH.read_text()

    assert client.post("/api/settings", json={"settings": {"STT_PROVIDER": "a\nINJECTED=1"}}).status_code == 400

    # Clearing a key removes it from the running process too.
    client.post("/api/settings", json={"settings": {"GROQ_API_KEY": ""}})
    assert "GROQ_API_KEY" not in os.environ
    assert client.get("/api/settings").json()["_providers"]["llm"]["groq"] is False


def test_providers_endpoint_reports_configuration(client):
    status = client.get("/api/providers").json()
    stt = {p["id"]: p for p in status["stt"]["providers"]}
    assert stt["soniox"]["configured"] is False and stt["soniox"]["native_translation"] is True
    assert stt["deepgram"]["diarization"] is True and stt["deepgram"]["native_translation"] is False
    assert status["stt"]["default"] == "fake"
    assert status["llm"]["default"] is None
    assert status["memory"] == {"supermemory": False}
    assert "es" in status["languages"]


def test_cors_and_origin_rules():
    import main

    assert main.origin_allowed(None)
    assert main.origin_allowed("chrome-extension://abcdefghijklmnop")
    assert main.origin_allowed("http://localhost:5173")
    assert not main.origin_allowed("https://evil.example.com")
    assert not main.origin_allowed("http://localhost.evil.com")
