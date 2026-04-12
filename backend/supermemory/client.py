"""
Supermemory client for the Interpreter backend.

  - SUPERMEMORY_API_URL  → base URL constant
  - build_headers()      → auth headers from env
  - SupermemorySession   → buffers transcript/translation pairs for one
                           WebSocket session and flushes as a single document
                           into the user's persistent container.
"""

import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import httpx

logger = logging.getLogger("interpreter.supermemory")

SUPERMEMORY_API_URL = "https://api.supermemory.ai/v3"
SUPERMEMORY_CONTAINER_TAG = "interpreter-sessions"


def build_headers() -> dict[str, str]:
    api_key = os.getenv("SUPERMEMORY_API_KEY", "")
    if not api_key:
        raise ValueError("SUPERMEMORY_API_KEY is not set")
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


@dataclass
class _Entry:
    original: str
    translated: str | None
    ts: float = field(default_factory=time.time)


def _is_youtube_watch_url(url: str | None) -> bool:
    if not url:
        return False

    try:
        parsed = urlparse(url)
    except ValueError:
        return False

    host = parsed.netloc.lower()
    return host.endswith("youtube.com") and parsed.path == "/watch"


def _extract_youtube_video_id(tab_url: str | None) -> str | None:
    if not _is_youtube_watch_url(tab_url):
        return None

    try:
        parsed = urlparse(tab_url or "")
        video_id = parse_qs(parsed.query).get("v", [""])[0].strip()
    except ValueError:
        return None

    if video_id:
        return video_id

    return None


def _build_custom_id(tab_url: str | None, session_id: str) -> str:
    return session_id


class SupermemorySession:
    """
    Accumulates transcript/translation pairs for one WebSocket session
    and posts them as a single document when flush() is called.

    Usage:
        session = SupermemorySession(source_lang="en", target_lang="es")
        session.add_transcript("Hello world")
        session.add_translation("Hola mundo")
        await session.flush()
    """

    def __init__(
        self,
        source_lang: str,
        target_lang: str,
        tab_url: str | None = None,
        tab_title: str | None = None,
    ) -> None:
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.tab_url = tab_url
        self.tab_title = tab_title
        self.session_id = f"session-{int(time.time() * 1000)}"

        self._entries: list[_Entry] = []
        self._pending_original: str | None = None
        self._flushed = False

    def add_transcript(self, text: str) -> None:
        """Call on every final STT transcript."""
        if self._flushed or not text.strip():
            return
        self._pending_original = text.strip()

    def add_translation(self, text: str) -> None:
        """Call on every final translated text — pairs with last transcript."""
        if self._flushed or not text.strip():
            return
        self._entries.append(_Entry(
            original=self._pending_original or "",
            translated=text.strip(),
        ))
        self._pending_original = None

    async def flush(self) -> dict | None:
        """
        Build a markdown document and POST it to Supermemory.
        Uses the shared containerTag so all sessions feed one growing
        knowledge graph. Safe to call multiple times — only runs once.
        """
        if self._flushed:
            return None
        self._flushed = True

        if self._pending_original:
            self._entries.append(_Entry(original=self._pending_original, translated=None))
            self._pending_original = None

        if not self._entries:
            logger.info("[Supermemory] No entries for session %s — skipping", self.session_id)
            return None

        try:
            headers = build_headers()
        except ValueError as e:
            logger.warning("[Supermemory] %s", e)
            return None

        video_id = _extract_youtube_video_id(self.tab_url)
        container_tag = video_id or SUPERMEMORY_CONTAINER_TAG
        custom_id = _build_custom_id(self.tab_url, self.session_id)

        payload = {
            "content": self._build_document(),
            "containerTag": container_tag,
            "customId": custom_id,
            "entityContext": (
                "Live translation sessions captured by the Interpreter Chrome extension. "
                "Extract speakers, topics, decisions, action items, and named entities. "
                "Link recurring entities across sessions to build a persistent knowledge graph."
            ),
            "metadata": {
                "sourceLang": self.source_lang,
                "targetLang": self.target_lang,
                "sessionId": self.session_id,
                "sessionStart": self._entries[0].ts,
                "entryCount": len(self._entries),
                **({"videoId": video_id} if video_id else {}),
                **({"tabUrl": self.tab_url} if self.tab_url else {}),
                **({"tabTitle": self.tab_title} if self.tab_title else {}),
            },
            **({"sourceUrl": self.tab_url} if self.tab_url else {}),
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    f"{SUPERMEMORY_API_URL}/documents",
                    headers=headers,
                    json=payload,
                )

            if response.status_code == 200:
                result = response.json()
                logger.info(
                    "[Supermemory] Session saved → container=%s  customId=%s  id=%s  status=%s",
                    container_tag, custom_id, result.get("id"), result.get("status"),
                )
                return result
            else:
                logger.error(
                    "[Supermemory] POST failed (%s): %s", response.status_code, response.text
                )
                return None

        except Exception as e:
            logger.error("[Supermemory] Network error during flush: %s", e)
            return None

    def _build_document(self) -> str:
        date = datetime.fromtimestamp(self._entries[0].ts, tz=timezone.utc).isoformat()

        header_lines = [f"# Translation Session — {date}"]
        if self.tab_title:
            header_lines.append(f"**Tab:** {self.tab_title}")
        if self.tab_url:
            header_lines.append(f"**URL:** {self.tab_url}")
        header_lines.append(f"**Languages:** {self.source_lang} → {self.target_lang}")
        header_lines.append("")

        entry_lines = []
        for e in self._entries:
            if e.translated:
                entry_lines.append(
                    f"[{self.source_lang}] {e.original}\n[{self.target_lang}] {e.translated}"
                )
            else:
                entry_lines.append(f"[{self.source_lang}] {e.original}")

        return "\n".join(header_lines) + "\n" + "\n\n".join(entry_lines)
