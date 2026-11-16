"""Work that runs after a meeting ends: auto-summary, then Supermemory sync."""

from __future__ import annotations

import logging
import os

from services import meeting_store
from services.providers import registry

logger = logging.getLogger("interpreter.postprocess")


def auto_summary_enabled() -> bool:
    return os.getenv("AUTO_SUMMARY", "1").strip().lower() not in {"0", "false", "no", "off"}


async def finalize_meeting(meeting_id: str) -> None:
    from services import summarizer
    from supermemory import sync

    if meeting_store.count_segments(meeting_id) == 0:
        logger.info("Meeting %s ended with no transcript; nothing to post-process", meeting_id)
        return
    if auto_summary_enabled():
        try:
            registry.resolve("llm")
        except registry.ProviderConfigError as exc:
            meeting_store.set_summary(meeting_id, status="error", error=str(exc))
            logger.info("Auto-summary skipped for %s: %s", meeting_id, exc)
        else:
            try:
                await summarizer.summarize_meeting(meeting_id)
            except Exception as exc:  # noqa: BLE001 — status already recorded
                logger.warning("Auto-summary failed for %s: %s", meeting_id, exc)
    await sync.sync_meeting(meeting_id)
