import logging
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from supermemory.client import SUPERMEMORY_CONTAINER_TAG, build_headers

logger = logging.getLogger("interpreter.supermemory.query")
SUPERMEMORY_MEMORY_SEARCH_URL = "https://api.supermemory.ai/v4/search"


@dataclass
class MemorySearchResult:
    title: str
    excerpt: str
    score: float | None = None
    kind: str = "chunk"
    source_url: str | None = None
    metadata: dict[str, Any] | None = None


def _trim_text(value: str | None, limit: int = 240) -> str:
    if not value:
        return ""
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _coerce_score(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _pick_chunk(item: dict[str, Any]) -> tuple[str, float | None]:
    chunks = item.get("chunks")
    if not isinstance(chunks, list):
        return "", None

    best_text = ""
    best_score: float | None = None
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        text = chunk.get("content") or chunk.get("chunk") or ""
        if not isinstance(text, str) or not text.strip():
            continue

        score = _coerce_score(chunk.get("score") or chunk.get("similarity"))
        if best_score is None or (score is not None and score > best_score):
            best_text = text
            best_score = score

    return best_text, best_score


def _normalize_result(item: dict[str, Any], excerpt_limit: int = 240) -> MemorySearchResult | None:
    memory_text = item.get("memory")
    chunk_text = item.get("chunk")
    excerpt = ""
    score = _coerce_score(item.get("similarity") or item.get("score"))
    kind = "chunk"

    if isinstance(memory_text, str) and memory_text.strip():
        excerpt = memory_text
        kind = "memory"
    elif isinstance(chunk_text, str) and chunk_text.strip():
        excerpt = chunk_text
        kind = "chunk"
    else:
        excerpt, chunk_score = _pick_chunk(item)
        if chunk_score is not None:
            score = chunk_score

    excerpt = _trim_text(excerpt, limit=excerpt_limit)
    if not excerpt:
        return None

    metadata = item.get("metadata")
    title = (
        item.get("title")
        or (metadata.get("tabTitle") if isinstance(metadata, dict) else None)
        or "Memory"
    )
    source_url = (
        item.get("sourceUrl")
        or (metadata.get("tabUrl") if isinstance(metadata, dict) else None)
    )

    return MemorySearchResult(
        title=_trim_text(title, limit=90) or "Memory",
        excerpt=excerpt,
        score=score,
        kind=kind,
        source_url=source_url if isinstance(source_url, str) else None,
        metadata=metadata if isinstance(metadata, dict) else None,
    )


def _build_answer(query: str, memories: list[MemorySearchResult]) -> str:
    if not memories:
        return "I could not find any saved memories related to that yet."

    preferred_memories = [memory for memory in memories if memory.kind == "memory"] or memories

    if len(preferred_memories) == 1:
        return preferred_memories[0].excerpt

    lead = f'I found {len(memories)} related memories for "{query.strip()}".'
    highlights = " ".join(memory.excerpt for memory in preferred_memories[:3])
    return _trim_text(f"{lead} {highlights}", limit=420)


def _extract_youtube_video_id(tab_url: str | None) -> str | None:
    if not tab_url:
        return None

    try:
        parsed = urlparse(tab_url)
    except ValueError:
        return None

    if not parsed.netloc.lower().endswith("youtube.com") or parsed.path != "/watch":
        return None

    video_id = parse_qs(parsed.query).get("v", [""])[0].strip()
    return video_id or None


def resolve_container_tag(tab_url: str | None, explicit_container_tag: str | None = None) -> str:
    if explicit_container_tag and explicit_container_tag.strip():
        return explicit_container_tag.strip()

    video_id = _extract_youtube_video_id(tab_url)
    if video_id:
        return video_id

    return SUPERMEMORY_CONTAINER_TAG


async def query_memories(
    query: str,
    *,
    limit: int = 5,
    tab_url: str | None = None,
    container_tag: str | None = None,
    scope: str | None = None,
    excerpt_limit: int = 240,
) -> dict[str, Any]:
    headers = build_headers()
    payload = {
        "q": query,
        "searchMode": "hybrid",
        "threshold": 0.2,
        "limit": limit,
        "rerank": True,
    }

    resolved_container_tag: str | None = None
    if (scope or "").strip().lower() != "all":
        resolved_container_tag = resolve_container_tag(tab_url, container_tag)
        payload["containerTag"] = resolved_container_tag

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            SUPERMEMORY_MEMORY_SEARCH_URL,
            headers=headers,
            json=payload,
        )
        response.raise_for_status()

    data = response.json()
    raw_results = data.get("results", [])
    memories = [
        normalized
        for item in raw_results
        if isinstance(item, dict)
        for normalized in [_normalize_result(item, excerpt_limit=excerpt_limit)]
        if normalized is not None
    ][:limit]

    logger.info(
        "Supermemory query returned %s normalized results (raw total=%s, timing=%sms, container=%s) for query=%r",
        len(memories),
        data.get("total"),
        data.get("timing"),
        resolved_container_tag or "ALL",
        query,
    )

    return {
        "answer": _build_answer(query, memories),
        "memories": [asdict(memory) for memory in memories],
        "containerTag": resolved_container_tag,
        "total": data.get("total", len(memories)),
    }
