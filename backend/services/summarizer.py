"""LLM meeting summarizer (Gemini / Groq) with structured JSON output."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator

from services import background, meeting_store
from services.llm.openai_compat import LLMError, extract_json
from services.minimax_client import get_language_name

logger = logging.getLogger("interpreter.summarizer")

CHUNK_CHARS = int(os.getenv("SUMMARY_CHUNK_CHARS", "60000") or 60000)


class ActionItem(BaseModel):
    task: str
    owner: str | None = None
    due: str | None = None


class Topic(BaseModel):
    title: str
    timestamp: str | None = None
    summary: str | None = None


class MeetingSummary(BaseModel):
    title: str = "Meeting summary"
    overview: str = ""
    key_points: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    topics: list[Topic] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)

    @field_validator("key_points", "decisions", "open_questions", "next_steps", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value] if value.strip() else []
        out = []
        for item in value:
            if isinstance(item, dict):
                item = item.get("text") or item.get("decision") or item.get("point") or json.dumps(item)
            if str(item).strip():
                out.append(str(item).strip())
        return out

    @field_validator("action_items", mode="before")
    @classmethod
    def _actions(cls, value: Any) -> list[Any]:
        if value is None:
            return []
        out = []
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str):
                out.append({"task": item})
            elif isinstance(item, dict):
                task = item.get("task") or item.get("action") or item.get("item") or item.get("description")
                if task:
                    out.append({"task": str(task), "owner": item.get("owner") or item.get("assignee"), "due": item.get("due") or item.get("deadline")})
        return out

    @field_validator("topics", mode="before")
    @classmethod
    def _topics(cls, value: Any) -> list[Any]:
        if value is None:
            return []
        out = []
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str):
                out.append({"title": item})
            elif isinstance(item, dict) and (item.get("title") or item.get("topic")):
                out.append(
                    {
                        "title": str(item.get("title") or item.get("topic")),
                        "timestamp": item.get("timestamp") or item.get("time"),
                        "summary": item.get("summary"),
                    }
                )
        return out


SCHEMA_HINT = """Return ONLY a JSON object with exactly these keys:
{
  "title": "short descriptive meeting title (max 10 words)",
  "overview": "2-4 sentence summary of what the meeting was about and its outcome",
  "key_points": ["important discussion points"],
  "decisions": ["each decision that was made, stated concretely"],
  "action_items": [{"task": "what must be done", "owner": "person responsible or null", "due": "deadline or null"}],
  "open_questions": ["unresolved questions or risks"],
  "topics": [{"title": "topic name", "timestamp": "mm:ss when it started", "summary": "one sentence"}],
  "next_steps": ["follow-ups and next meeting plans"]
}
Use [] for empty lists. Never invent facts that are not in the transcript."""


def fmt_ts(ms: int | None) -> str:
    total = max(0, int((ms or 0) / 1000))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def speaker_label(speaker: str | None, names: dict[str, str]) -> str:
    if not speaker:
        return "Speaker"
    if speaker in names:
        return names[speaker]
    if speaker == "me":
        return "Me"
    if speaker.startswith("S") and speaker[1:].isdigit():
        return f"Speaker {speaker[1:]}"
    return speaker


def transcript_lines(segments: list[dict[str, Any]], names: dict[str, str]) -> list[str]:
    lines = []
    for seg in segments:
        lines.append(f"[{fmt_ts(seg.get('start_ms'))}] {speaker_label(seg.get('speaker'), names)}: {seg['text']}")
    return lines


def chunk_lines(lines: list[str], max_chars: int = CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if current and size + len(line) + 1 > max_chars:
            chunks.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def _system_prompt(language: str) -> str:
    lang = get_language_name(language)
    return (
        "You are an expert meeting note-taker like Granola or Fireflies. You turn raw, imperfect "
        "speech-to-text meeting transcripts into accurate, concise notes. Transcripts may contain "
        "recognition errors and diarization labels like 'Speaker 1'; use names when people are "
        "addressed by name. Capture EVERY decision and EVERY action item with its owner and due date "
        f"when stated. Write all text values in {lang}.\n\n{SCHEMA_HINT}"
    )


async def _complete_json(llm: Any, messages: list[dict[str, str]]) -> MeetingSummary:
    raw = await llm.complete(messages, json_mode=True, temperature=0.1)
    try:
        return MeetingSummary.model_validate(extract_json(raw))
    except (ValueError, ValidationError) as first_error:
        logger.warning("Summary JSON invalid (%s); asking model to repair", first_error)
        repair = messages + [
            {"role": "assistant", "content": raw[:20000]},
            {"role": "user", "content": f"That was not valid JSON for the schema ({first_error}). {SCHEMA_HINT}"},
        ]
        raw = await llm.complete(repair, json_mode=True, temperature=0.0)
        return MeetingSummary.model_validate(extract_json(raw))


async def summarize_segments(
    segments: list[dict[str, Any]],
    *,
    llm: Any,
    language: str = "en",
    speaker_names: dict[str, str] | None = None,
    user_notes: str = "",
    meeting_title: str = "",
) -> MeetingSummary:
    names = speaker_names or {}
    lines = transcript_lines(segments, names)
    if not lines:
        raise ValueError("The meeting has no transcript yet")
    notes_block = f"\n\nThe user's own notes taken during the meeting (prioritise these):\n{user_notes.strip()}" if user_notes.strip() else ""
    header = f"Meeting: {meeting_title}\n" if meeting_title else ""
    chunks = chunk_lines(lines)
    system = {"role": "system", "content": _system_prompt(language)}
    if len(chunks) == 1:
        return await _complete_json(
            llm,
            [system, {"role": "user", "content": f"{header}Transcript:\n{chunks[0]}{notes_block}"}],
        )

    # Map-reduce for very long meetings.
    partials: list[MeetingSummary] = []
    for i, chunk in enumerate(chunks, 1):
        partials.append(
            await _complete_json(
                llm,
                [
                    system,
                    {
                        "role": "user",
                        "content": f"{header}This is part {i} of {len(chunks)} of a long transcript. "
                        f"Summarise only this part.\nTranscript part {i}:\n{chunk}",
                    },
                ],
            )
        )
    merged = json.dumps([p.model_dump() for p in partials], ensure_ascii=False)
    return await _complete_json(
        llm,
        [
            system,
            {
                "role": "user",
                "content": f"{header}Below are JSON notes for consecutive parts of one meeting. Merge them into "
                f"one set of notes for the whole meeting, removing duplicates and keeping every decision and "
                f"action item.\n{merged}{notes_block}",
            },
        ],
    )


async def summarize_meeting(meeting_id: str, *, language: str | None = None, provider: str | None = None) -> dict[str, Any]:
    """Summarise a stored meeting and persist the result. Serialised per meeting."""
    from services.providers import registry

    async def run() -> dict[str, Any]:
        meeting = meeting_store.get_meeting(meeting_id)
        if not meeting:
            raise KeyError(meeting_id)
        segments = meeting_store.list_segments(meeting_id)
        lang = language or meeting.get("summary_language") or os.getenv("SUMMARY_LANGUAGE", "en") or "en"
        meeting_store.set_summary(meeting_id, status="pending")
        started = time.time()
        try:
            llm = registry.build_llm(provider)
        except Exception as exc:
            meeting_store.set_summary(meeting_id, status="error", error=str(exc))
            raise
        try:
            summary = await summarize_segments(
                segments,
                llm=llm,
                language=lang,
                speaker_names=meeting.get("speaker_names") or {},
                user_notes=meeting.get("user_notes") or "",
                meeting_title=meeting.get("title") or "",
            )
        except (LLMError, ValueError, ValidationError) as exc:
            meeting_store.set_summary(meeting_id, status="error", error=str(exc)[:500])
            raise
        finally:
            await llm.aclose()
        data = summary.model_dump()
        data["_meta"] = {
            "provider": llm.provider,
            "model": llm.model,
            "language": lang,
            "segment_count": len(segments),
            "generated_at": time.time(),
            "duration_s": round(time.time() - started, 2),
        }
        meeting_store.set_summary(meeting_id, status="ready", summary=data)
        if meeting.get("title", "").endswith(tuple("0123456789")) and summary.title and " · " in meeting.get("title", ""):
            # Replace auto-generated "<tab> · Mon 01, 10:00" titles with the LLM title.
            meeting_store.update_meeting(meeting_id, title=summary.title)
        return data

    return await background.run_locked(f"summary:{meeting_id}", run)


def summary_to_markdown(meeting: dict[str, Any], summary: dict[str, Any] | None, segments: list[dict[str, Any]] | None = None) -> str:
    started = time.strftime("%Y-%m-%d %H:%M", time.localtime(meeting.get("started_at") or time.time()))
    out = [f"# {meeting.get('title') or 'Meeting'}", "", f"*{meeting.get('platform_label', 'Meeting')} · {started}*", ""]
    if summary:
        if summary.get("overview"):
            out += ["## Overview", summary["overview"], ""]
        for key, heading in (("key_points", "Key points"), ("decisions", "Decisions")):
            if summary.get(key):
                out += [f"## {heading}"] + [f"- {x}" for x in summary[key]] + [""]
        if summary.get("action_items"):
            out.append("## Action items")
            for item in summary["action_items"]:
                extra = ", ".join(x for x in (item.get("owner"), f"due {item['due']}" if item.get("due") else None) if x)
                out.append(f"- [ ] {item['task']}" + (f" ({extra})" if extra else ""))
            out.append("")
        for key, heading in (("open_questions", "Open questions"), ("next_steps", "Next steps")):
            if summary.get(key):
                out += [f"## {heading}"] + [f"- {x}" for x in summary[key]] + [""]
        if summary.get("topics"):
            out.append("## Topics")
            for t in summary["topics"]:
                ts = f"[{t['timestamp']}] " if t.get("timestamp") else ""
                out.append(f"- {ts}**{t['title']}**" + (f" — {t['summary']}" if t.get("summary") else ""))
            out.append("")
    if meeting.get("user_notes"):
        out += ["## My notes", meeting["user_notes"], ""]
    if segments:
        out += ["## Transcript"] + transcript_lines(segments, meeting.get("speaker_names") or {}) + [""]
    return "\n".join(out)
