"""
Supermemory shared constants and auth helpers.

  - SUPERMEMORY_API_URL       → v3 base URL (documents API)
  - SUPERMEMORY_CONTAINER_TAG → default container for meetings/sessions
  - build_headers()           → auth headers from env

Meeting ingestion lives in supermemory/sync.py, retrieval in supermemory/query.py.
"""

import logging
import os
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger("interpreter.supermemory")

SUPERMEMORY_API_URL = "https://api.supermemory.ai/v3"
SUPERMEMORY_CONTAINER_TAG = "interpreter-sessions"


def has_api_key() -> bool:
    return bool(os.getenv("SUPERMEMORY_API_KEY", "").strip())


def build_headers() -> dict[str, str]:
    api_key = os.getenv("SUPERMEMORY_API_KEY", "").strip()
    if not api_key:
        raise ValueError("SUPERMEMORY_API_KEY is not set")
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def extract_youtube_video_id(tab_url: str | None) -> str | None:
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
