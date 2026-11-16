"""REST API for meetings, transcripts, summaries and chat."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from services import background, chat, meeting_store, summarizer
from services.llm.openai_compat import LLMError
from services.providers.registry import ProviderConfigError

router = APIRouter(prefix="/api", tags=["meetings"])


def _require(meeting_id: str) -> dict[str, Any]:
    meeting = meeting_store.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting


@router.get("/meetings")
async def list_meetings(limit: int = 50, q: str | None = None) -> dict[str, Any]:
    meeting_store.finalize_stale()
    return {"meetings": meeting_store.list_meetings(limit=limit, query=q)}


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, after_id: int = 0) -> dict[str, Any]:
    meeting = _require(meeting_id)
    meeting["segments"] = meeting_store.list_segments(meeting_id, after_id=after_id)
    return meeting


class MeetingPatch(BaseModel):
    title: str | None = None
    user_notes: str | None = Field(default=None, max_length=50000)
    speaker_names: dict[str, str] | None = None
    summary_language: str | None = None


@router.patch("/meetings/{meeting_id}")
async def patch_meeting(meeting_id: str, payload: MeetingPatch) -> dict[str, Any]:
    _require(meeting_id)
    updated = meeting_store.update_meeting(meeting_id, **payload.model_dump(exclude_none=True))
    if updated and updated.get("memory_status") == "synced":
        meeting_store.set_memory_status(meeting_id, status="pending")
    return updated or {}


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str) -> dict[str, Any]:
    meeting = _require(meeting_id)
    from supermemory import sync

    background.spawn(sync.delete_meeting_document(meeting), name=f"memory-delete-{meeting_id}")
    meeting_store.delete_meeting(meeting_id)
    return {"deleted": meeting_id}


@router.post("/meetings/{meeting_id}/end")
async def end_meeting(meeting_id: str) -> dict[str, Any]:
    _require(meeting_id)
    from services import postprocess

    meeting = meeting_store.end_meeting(meeting_id)
    background.spawn(postprocess.finalize_meeting(meeting_id), name=f"finalize-{meeting_id}")
    return meeting or {}


class SummarizePayload(BaseModel):
    language: str | None = None
    provider: str | None = None


@router.post("/meetings/{meeting_id}/summarize")
async def summarize(meeting_id: str, payload: SummarizePayload | None = None) -> dict[str, Any]:
    _require(meeting_id)
    payload = payload or SummarizePayload()
    if payload.language:
        meeting_store.update_meeting(meeting_id, summary_language=payload.language)
    try:
        summary = await summarizer.summarize_meeting(meeting_id, language=payload.language, provider=payload.provider)
    except ProviderConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    meeting = meeting_store.get_meeting(meeting_id) or {}
    if meeting.get("memory_status") in {"synced", "error"}:
        from supermemory import sync

        background.spawn(sync.sync_meeting(meeting_id), name=f"memory-after-summary-{meeting_id}")
    return {"summary": summary, "meeting": meeting}


@router.get("/meetings/{meeting_id}/export.md", response_class=PlainTextResponse)
async def export_markdown(meeting_id: str, transcript: bool = True) -> PlainTextResponse:
    meeting = _require(meeting_id)
    segments = meeting_store.list_segments(meeting_id) if transcript else None
    return PlainTextResponse(
        summarizer.summary_to_markdown(meeting, meeting.get("summary"), segments),
        media_type="text/markdown; charset=utf-8",
    )


@router.post("/meetings/{meeting_id}/sync-memory")
async def sync_memory(meeting_id: str) -> dict[str, Any]:
    _require(meeting_id)
    from supermemory import sync

    status = await sync.sync_meeting(meeting_id)
    return {"status": status, "meeting": meeting_store.get_meeting(meeting_id)}


# ── Chat ──────────────────────────────────────────────────────────────


class ChatPayload(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    meeting_id: str | None = None
    scope: str = "meeting"  # "meeting" | "all"
    tab_url: str | None = None
    provider: str | None = None
    stream: bool = True


@router.post("/chat")
async def chat_endpoint(payload: ChatPayload):
    scope = "all" if payload.scope == "all" or not payload.meeting_id else "meeting"
    kwargs = dict(scope=scope, meeting_id=payload.meeting_id, tab_url=payload.tab_url, provider=payload.provider)
    if not payload.stream:
        result = await chat.answer(payload.question, **kwargs)
        if result.get("error") and not result.get("answer"):
            raise HTTPException(status_code=400, detail=result["error"])
        return result

    async def events():
        async for event in chat.answer_stream(payload.question, **kwargs):
            yield chat.sse(event)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/chat/history")
async def chat_history(meeting_id: str | None = None) -> dict[str, Any]:
    if meeting_id:
        _require(meeting_id)
    return {"messages": meeting_store.list_chat_messages(meeting_id)}


@router.delete("/chat/history")
async def clear_chat_history(meeting_id: str | None = None) -> dict[str, Any]:
    meeting_store.clear_chat(meeting_id)
    return {"cleared": True}
