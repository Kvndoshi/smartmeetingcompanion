"""Chat with your meetings (RAG, grounded answers with citations).

Scopes:
- "meeting": the selected meeting's own transcript, summary and notes go
  into context (works live, while the meeting is still running).
- "all": Supermemory search across past meetings (long-term memory), plus a
  local BM25 search over stored transcripts as fallback / supplement.
Gemini or Groq writes the answer; the prompt forbids answering beyond context.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator

from services import meeting_store
from services.providers import registry
from services.summarizer import fmt_ts, speaker_label, transcript_lines

logger = logging.getLogger("interpreter.chat")

CONTEXT_CHARS = int(os.getenv("CHAT_CONTEXT_CHARS", "120000") or 120000)
HISTORY_TURNS = 8

SYSTEM_PROMPT = (
    "You are Distill, an AI meeting assistant (like Granola or Fireflies). Answer the user's "
    "question using ONLY the meeting context provided. Be concise and specific: quote who said "
    "what, and include timestamps like [12:34] or source numbers like [2] when you rely on them. "
    "If the context does not contain the answer, say you couldn't find it in the meeting notes "
    "instead of guessing. Transcripts come from speech recognition and may contain errors. "
    "Use Markdown bullet lists for lists of action items or decisions."
)


def _summary_block(summary: dict[str, Any] | None) -> str:
    if not summary:
        return ""
    parts = []
    if summary.get("overview"):
        parts.append(f"Overview: {summary['overview']}")
    for key, label in (("decisions", "Decisions"), ("key_points", "Key points"), ("open_questions", "Open questions"), ("next_steps", "Next steps")):
        if summary.get(key):
            parts.append(f"{label}:\n" + "\n".join(f"- {x}" for x in summary[key]))
    if summary.get("action_items"):
        lines = []
        for item in summary["action_items"]:
            extra = ", ".join(x for x in (item.get("owner"), f"due {item['due']}" if item.get("due") else None) if x)
            lines.append(f"- {item['task']}" + (f" ({extra})" if extra else ""))
        parts.append("Action items:\n" + "\n".join(lines))
    return "\n\n".join(parts)


def meeting_context(meeting: dict[str, Any], question: str) -> tuple[str, list[dict[str, Any]]]:
    segments = meeting_store.list_segments(meeting["id"])
    names = meeting.get("speaker_names") or {}
    lines = transcript_lines(segments, names)
    transcript = "\n".join(lines)
    note = ""
    if len(transcript) > CONTEXT_CHARS:
        # Too long for one prompt: keep the most relevant passages + the latest part.
        hits = meeting_store.search_segments(question, meeting_id=meeting["id"], limit=60)
        hit_lines = transcript_lines(sorted(hits, key=lambda s: (s["start_ms"], s["id"])), names)
        tail = transcript[-CONTEXT_CHARS // 3 :]
        transcript = "Relevant passages:\n" + "\n".join(hit_lines) + "\n\nMost recent part:\n…" + tail
        note = " (long meeting: showing relevant passages)"
    blocks = [f"Meeting: {meeting.get('title')} ({meeting.get('platform_label')}, status: {meeting.get('status')})"]
    summary = _summary_block(meeting.get("summary"))
    if summary:
        blocks.append("AI summary:\n" + summary)
    if (meeting.get("user_notes") or "").strip():
        blocks.append("User's own notes:\n" + meeting["user_notes"].strip())
    blocks.append(f"Transcript{note}:\n" + (transcript or "(no transcript yet)"))
    sources = [{"id": 1, "kind": "meeting", "meeting_id": meeting["id"], "title": meeting.get("title"), "segments": len(segments)}]
    return "\n\n".join(blocks), sources


async def global_context(question: str, *, tab_url: str | None = None) -> tuple[str, list[dict[str, Any]]]:
    sources: list[dict[str, Any]] = []
    from supermemory.client import has_api_key

    if has_api_key():
        try:
            from supermemory.query import query_memories

            result = await query_memories(question, limit=8, scope="all", tab_url=tab_url, excerpt_limit=1500)
            for mem in result.get("memories", []):
                meta = mem.get("metadata") or {}
                sources.append(
                    {
                        "kind": "memory",
                        "title": mem.get("title") or meta.get("title") or "Memory",
                        "excerpt": mem.get("excerpt", ""),
                        "meeting_id": meta.get("meetingId"),
                        "source_url": mem.get("source_url"),
                    }
                )
        except Exception as exc:  # noqa: BLE001 — fall back to local search
            logger.warning("Supermemory search failed, using local search only: %s", exc)

    hits = meeting_store.search_segments(question, limit=24)
    by_meeting: dict[str, list[dict[str, Any]]] = {}
    for hit in hits:
        by_meeting.setdefault(hit["meeting_id"], []).append(hit)
    for meeting_id, segs in list(by_meeting.items())[:6]:
        meeting = meeting_store.get_meeting(meeting_id)
        if not meeting:
            continue
        names = meeting.get("speaker_names") or {}
        segs.sort(key=lambda s: (s["start_ms"], s["id"]))
        excerpt = "\n".join(f"[{fmt_ts(s['start_ms'])}] {speaker_label(s.get('speaker'), names)}: {s['text']}" for s in segs)
        summary = _summary_block(meeting.get("summary"))
        if summary:
            excerpt = f"Summary:\n{summary}\n\nMatching transcript lines:\n{excerpt}"
        sources.append({"kind": "transcript", "title": meeting.get("title"), "excerpt": excerpt[:4000], "meeting_id": meeting_id})

    for i, src in enumerate(sources, 1):
        src["id"] = i
    if not sources:
        return "(no matching meeting notes were found)", []
    context = "\n\n".join(f"[{s['id']}] {s['title']}\n{s['excerpt']}" for s in sources)
    return context, sources


def _history(meeting_id: str | None) -> list[dict[str, str]]:
    msgs = meeting_store.list_chat_messages(meeting_id, limit=HISTORY_TURNS * 2)
    return [{"role": m["role"], "content": m["content"]} for m in msgs if m["role"] in {"user", "assistant"}]


async def answer_stream(
    question: str,
    *,
    scope: str = "meeting",
    meeting_id: str | None = None,
    tab_url: str | None = None,
    provider: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Yield {"type":"sources"|"delta"|"done"|"error", ...} events and persist the turn."""
    question = question.strip()
    if not question:
        yield {"type": "error", "message": "Question is empty"}
        return
    if scope == "meeting":
        meeting = meeting_store.get_meeting(meeting_id or "") if meeting_id else None
        if not meeting:
            yield {"type": "error", "message": "Meeting not found"}
            return
        context, sources = meeting_context(meeting, question)
        history_key: str | None = meeting["id"]
    else:
        context, sources = await global_context(question, tab_url=tab_url)
        history_key = None

    try:
        llm = registry.build_llm(provider)
    except registry.ProviderConfigError as exc:
        yield {"type": "error", "message": str(exc), "code": "provider_config"}
        return

    yield {"type": "sources", "sources": sources}
    messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n\n--- CONTEXT ---\n" + context + "\n--- END CONTEXT ---"}]
    messages += _history(history_key)
    messages.append({"role": "user", "content": question})

    meeting_store.add_chat_message(history_key, "user", question)
    chunks: list[str] = []
    try:
        async for delta in llm.stream(messages, temperature=0.2):
            chunks.append(delta)
            yield {"type": "delta", "text": delta}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Chat generation failed: %s", exc)
        yield {"type": "error", "message": str(exc)}
        return
    finally:
        await llm.aclose()
    answer = "".join(chunks).strip() or "I couldn't generate an answer."
    saved = meeting_store.add_chat_message(history_key, "assistant", answer, sources=sources)
    yield {"type": "done", "message_id": saved["id"], "provider": llm.provider, "model": llm.model}


async def answer(question: str, **kwargs: Any) -> dict[str, Any]:
    """Non-streaming convenience wrapper (used by tests and the Memories tab)."""
    text: list[str] = []
    result: dict[str, Any] = {"answer": "", "sources": []}
    async for event in answer_stream(question, **kwargs):
        if event["type"] == "sources":
            result["sources"] = event["sources"]
        elif event["type"] == "delta":
            text.append(event["text"])
        elif event["type"] == "error":
            result["error"] = event["message"]
        elif event["type"] == "done":
            result.update({k: v for k, v in event.items() if k != "type"})
    result["answer"] = "".join(text).strip()
    return result


async def compose_memory_answer(question: str, memories: list[dict[str, Any]], provider: str | None = None) -> str | None:
    """LLM-written answer for the Memories tab from Supermemory excerpts."""
    if not memories:
        return None
    try:
        llm = registry.build_llm(provider, fast=True)
    except registry.ProviderConfigError:
        return None
    context = "\n\n".join(f"[{i}] {m.get('title')}\n{m.get('excerpt')}" for i, m in enumerate(memories, 1))
    try:
        return (
            await llm.complete(
                [
                    {"role": "system", "content": SYSTEM_PROMPT + "\n\n--- CONTEXT ---\n" + context + "\n--- END CONTEXT ---"},
                    {"role": "user", "content": question},
                ],
                temperature=0.2,
                max_tokens=600,
            )
        ).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Memory answer generation failed: %s", exc)
        return None
    finally:
        await llm.aclose()


def sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
