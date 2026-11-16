"""Sync meetings (transcript + summary) into Supermemory.

One Supermemory document per meeting. The first sync POSTs /v3/documents and
stores the returned id; later syncs PATCH /v3/documents/{id}, which replaces
and reprocesses the content (re-POSTing the same customId would append).
Without SUPERMEMORY_API_KEY nothing is lost: the meeting stays in SQLite with
memory_status='no_key' and sync_pending() retries once a key is configured.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from services import background, meeting_store
from supermemory.client import SUPERMEMORY_API_URL, build_headers, has_api_key
from supermemory.query import resolve_container_tag

logger = logging.getLogger("interpreter.supermemory.sync")

ENTITY_CONTEXT = (
    "Meeting notes captured by the Distill Smart Meeting Companion browser extension: a "
    "speaker-labelled transcript plus an AI summary. Extract participants, topics, decisions, "
    "action items with owners and due dates, and named entities. Link recurring people, projects "
    "and decisions across meetings."
)


def build_document(meeting: dict[str, Any], segments: list[dict[str, Any]]) -> str:
    from services.summarizer import summary_to_markdown

    return summary_to_markdown(meeting, meeting.get("summary"), segments)


def build_payload(meeting: dict[str, Any], segments: list[dict[str, Any]], *, include_custom_id: bool) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "kind": "meeting",
        "meetingId": meeting["id"],
        "platform": meeting.get("platform") or "other",
        "title": (meeting.get("title") or "")[:200],
        "startedAt": float(meeting.get("started_at") or 0),
        "segmentCount": len(segments),
        "hasSummary": bool(meeting.get("summary")),
    }
    for key, field in (("tabUrl", "tab_url"), ("tabTitle", "tab_title"), ("sourceLang", "source_lang"), ("targetLang", "target_lang")):
        if meeting.get(field):
            metadata[key] = str(meeting[field])[:500]
    payload: dict[str, Any] = {
        "content": build_document(meeting, segments),
        "containerTag": resolve_container_tag(meeting.get("tab_url")),
        "entityContext": ENTITY_CONTEXT[:1500],
        "metadata": metadata,
    }
    if include_custom_id:
        payload["customId"] = f"meeting-{meeting['id']}"[:100]
    return payload


async def _sync(meeting_id: str, transport: httpx.AsyncBaseTransport | None = None) -> str:
    meeting = meeting_store.get_meeting(meeting_id)
    if not meeting:
        return "missing"
    segments = meeting_store.list_segments(meeting_id)
    if not segments:
        return "empty"
    if not has_api_key():
        meeting_store.set_memory_status(meeting_id, status="no_key", error="SUPERMEMORY_API_KEY is not set")
        return "no_key"
    headers = build_headers()
    doc_id = meeting.get("memory_doc_id")
    try:
        async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
            response = None
            if doc_id:
                response = await client.patch(
                    f"{SUPERMEMORY_API_URL}/documents/{doc_id}",
                    headers=headers,
                    json=build_payload(meeting, segments, include_custom_id=False),
                )
                if response.status_code == 404:
                    doc_id = None
            if not doc_id:
                response = await client.post(
                    f"{SUPERMEMORY_API_URL}/documents",
                    headers=headers,
                    json=build_payload(meeting, segments, include_custom_id=True),
                )
    except httpx.HTTPError as exc:
        meeting_store.set_memory_status(meeting_id, status="error", error=f"network: {exc}"[:500])
        logger.warning("Supermemory sync failed for %s: %s", meeting_id, exc)
        return "error"

    assert response is not None
    if response.status_code in (200, 201, 202):
        try:
            body = response.json()
        except ValueError:
            body = {}
        new_id = body.get("id") if isinstance(body, dict) else None
        meeting_store.set_memory_status(meeting_id, status="synced", doc_id=new_id or doc_id)
        logger.info("Supermemory synced meeting %s (doc=%s, segments=%d)", meeting_id, new_id or doc_id, len(segments))
        return "synced"
    meeting_store.set_memory_status(
        meeting_id, status="error", error=f"HTTP {response.status_code}: {response.text[:300]}"
    )
    logger.warning("Supermemory sync HTTP %s for %s: %s", response.status_code, meeting_id, response.text[:300])
    return "error"


async def sync_meeting(meeting_id: str, transport: httpx.AsyncBaseTransport | None = None) -> str:
    return await background.run_locked(f"memory:{meeting_id}", lambda: _sync(meeting_id, transport))


async def delete_meeting_document(meeting: dict[str, Any]) -> None:
    if not has_api_key():
        return
    target = meeting.get("memory_doc_id") or f"meeting-{meeting['id']}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.delete(f"{SUPERMEMORY_API_URL}/documents/{target}", headers=build_headers())
    except httpx.HTTPError as exc:
        logger.warning("Supermemory delete failed for %s: %s", meeting["id"], exc)


async def sync_pending() -> dict[str, str]:
    """Retry meetings that could not be synced (no key yet, or an error)."""
    if not has_api_key() or os.getenv("SUPERMEMORY_AUTO_SYNC", "1").strip() in {"0", "false", "no"}:
        return {}
    results = {}
    for meeting_id in meeting_store.meetings_needing_memory_sync():
        results[meeting_id] = await sync_meeting(meeting_id)
    return results
