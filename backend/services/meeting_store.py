"""SQLite store for meetings, transcript segments and chat history.

This is the live transcript of record: every final STT segment lands here as
it arrives, so nothing is lost if the extension popup closes, the MV3 service
worker restarts, or Supermemory is unavailable. Supermemory is the long-term
memory/retrieval layer and is synced from this store (see supermemory/sync.py).
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DB_PATH = Path(__file__).resolve().parent.parent / "profiles.db"

_local = threading.local()
_init_lock = threading.Lock()
_initialized_paths: set[str] = set()

PLATFORMS = {
    "meet.google.com": "google_meet",
    "teams.microsoft.com": "microsoft_teams",
    "teams.live.com": "microsoft_teams",
    "teams.cloud.microsoft": "microsoft_teams",
    "zoom.us": "zoom",
    "zoom.com": "zoom",
    "webex.com": "webex",
    "whereby.com": "whereby",
    "discord.com": "discord",
    "slack.com": "slack",
    "youtube.com": "youtube",
}

PLATFORM_LABELS = {
    "google_meet": "Google Meet",
    "microsoft_teams": "Microsoft Teams",
    "zoom": "Zoom",
    "webex": "Webex",
    "whereby": "Whereby",
    "discord": "Discord",
    "slack": "Slack",
    "youtube": "YouTube",
    "other": "Browser tab",
}


def detect_platform(url: str | None) -> str:
    if not url:
        return "other"
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return "other"
    for domain, platform in PLATFORMS.items():
        if host == domain or host.endswith("." + domain):
            return platform
    return "other"


def _conn() -> sqlite3.Connection:
    path = str(DB_PATH)
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != path:
        conn = sqlite3.connect(path, check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
        _local.path = path
    if path not in _initialized_paths:
        with _init_lock:
            if path not in _initialized_paths:
                _create_schema(conn)
                _initialized_paths.add(path)
    return conn


def reset_connections() -> None:
    """Drop the cached connection for this thread (tests switch DB_PATH)."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _local.path = None


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meetings (
            id                 TEXT PRIMARY KEY,
            title              TEXT NOT NULL,
            platform           TEXT NOT NULL DEFAULT 'other',
            tab_url            TEXT,
            tab_title          TEXT,
            source_lang        TEXT,
            target_lang        TEXT,
            stt_provider       TEXT,
            tts_provider       TEXT,
            status             TEXT NOT NULL DEFAULT 'live',
            started_at         REAL NOT NULL,
            ended_at           REAL,
            last_activity_at   REAL NOT NULL,
            summary_json       TEXT,
            summary_status     TEXT NOT NULL DEFAULT 'none',
            summary_error      TEXT,
            summary_updated_at REAL,
            summary_language   TEXT NOT NULL DEFAULT 'en',
            user_notes         TEXT NOT NULL DEFAULT '',
            speaker_names      TEXT NOT NULL DEFAULT '{}',
            memory_status      TEXT NOT NULL DEFAULT 'none',
            memory_error       TEXT,
            memory_synced_at   REAL,
            memory_doc_id      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);

        CREATE TABLE IF NOT EXISTS segments (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            source          TEXT NOT NULL DEFAULT 'tab',
            speaker         TEXT,
            text            TEXT NOT NULL,
            translated_text TEXT,
            start_ms        INTEGER NOT NULL DEFAULT 0,
            end_ms          INTEGER,
            created_at      REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id, start_ms, id);

        CREATE TABLE IF NOT EXISTS chat_messages (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id   TEXT REFERENCES meetings(id) ON DELETE CASCADE,
            role         TEXT NOT NULL,
            content      TEXT NOT NULL,
            sources_json TEXT,
            created_at   REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id, id);

        CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
            text, translated_text, content='segments', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
            INSERT INTO segments_fts(rowid, text, translated_text)
            VALUES (new.id, new.text, coalesce(new.translated_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
            INSERT INTO segments_fts(segments_fts, rowid, text, translated_text)
            VALUES ('delete', old.id, old.text, coalesce(old.translated_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
            INSERT INTO segments_fts(segments_fts, rowid, text, translated_text)
            VALUES ('delete', old.id, old.text, coalesce(old.translated_text, ''));
            INSERT INTO segments_fts(rowid, text, translated_text)
            VALUES (new.id, new.text, coalesce(new.translated_text, ''));
        END;
        """
    )
    conn.commit()


def init_db() -> None:
    _conn()


# ── Meetings ──────────────────────────────────────────────────────────


def _meeting_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    data["summary"] = json.loads(data.pop("summary_json")) if data.get("summary_json") else None
    try:
        data["speaker_names"] = json.loads(data.get("speaker_names") or "{}")
    except ValueError:
        data["speaker_names"] = {}
    data["platform_label"] = PLATFORM_LABELS.get(data.get("platform") or "other", "Browser tab")
    return data


def _default_title(platform: str, tab_title: str | None, started_at: float) -> str:
    stamp = time.strftime("%b %d, %H:%M", time.localtime(started_at))
    cleaned = (tab_title or "").strip()
    # Meet/Teams tab titles are often just "Meet - abc-defg-hij"; keep them short.
    cleaned = re.sub(r"\s+", " ", cleaned)[:80]
    if cleaned:
        return f"{cleaned} · {stamp}"
    return f"{PLATFORM_LABELS.get(platform, 'Meeting')} · {stamp}"


def create_meeting(
    *,
    tab_url: str | None = None,
    tab_title: str | None = None,
    source_lang: str | None = None,
    target_lang: str | None = None,
    stt_provider: str | None = None,
    tts_provider: str | None = None,
    title: str | None = None,
    meeting_id: str | None = None,
) -> dict[str, Any]:
    now = time.time()
    platform = detect_platform(tab_url)
    mid = meeting_id or uuid.uuid4().hex
    conn = _conn()
    conn.execute(
        """
        INSERT INTO meetings (id, title, platform, tab_url, tab_title, source_lang, target_lang,
                              stt_provider, tts_provider, status, started_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
        """,
        (
            mid,
            title or _default_title(platform, tab_title, now),
            platform,
            tab_url,
            tab_title,
            source_lang,
            target_lang,
            stt_provider,
            tts_provider,
            now,
            now,
        ),
    )
    conn.commit()
    return get_meeting(mid)  # type: ignore[return-value]


def get_meeting(meeting_id: str) -> dict[str, Any] | None:
    row = _conn().execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    return _meeting_row(row)


def resume_meeting(meeting_id: str) -> dict[str, Any] | None:
    """Mark an existing meeting live again (e.g. after a service-worker restart)."""
    conn = _conn()
    cur = conn.execute(
        "UPDATE meetings SET status='live', ended_at=NULL, last_activity_at=? WHERE id=?",
        (time.time(), meeting_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        return None
    return get_meeting(meeting_id)


def list_meetings(limit: int = 50, query: str | None = None) -> list[dict[str, Any]]:
    conn = _conn()
    limit = max(1, min(int(limit), 200))
    if query and query.strip():
        like = f"%{query.strip()}%"
        rows = conn.execute(
            """
            SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS segment_count
            FROM meetings m
            WHERE m.title LIKE ? OR m.summary_json LIKE ? OR m.id IN (
                SELECT meeting_id FROM segments WHERE text LIKE ?
            )
            ORDER BY m.started_at DESC LIMIT ?
            """,
            (like, like, like, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS segment_count
            FROM meetings m ORDER BY m.started_at DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [m for m in (_meeting_row(r) for r in rows) if m]


_UPDATABLE = {"title", "user_notes", "speaker_names", "summary_language", "tts_provider", "stt_provider"}


def update_meeting(meeting_id: str, **fields: Any) -> dict[str, Any] | None:
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE and v is not None}
    if not updates:
        return get_meeting(meeting_id)
    if "speaker_names" in updates and not isinstance(updates["speaker_names"], str):
        cleaned = {
            str(k)[:40]: str(v).strip()[:60]
            for k, v in dict(updates["speaker_names"]).items()
            if str(v).strip()
        }
        updates["speaker_names"] = json.dumps(cleaned)
    if "title" in updates:
        updates["title"] = str(updates["title"]).strip()[:200] or "Untitled meeting"
    cols = ", ".join(f"{k} = ?" for k in updates)
    conn = _conn()
    cur = conn.execute(f"UPDATE meetings SET {cols} WHERE id = ?", (*updates.values(), meeting_id))
    conn.commit()
    if cur.rowcount == 0:
        return None
    return get_meeting(meeting_id)


def touch_meeting(meeting_id: str) -> None:
    conn = _conn()
    conn.execute("UPDATE meetings SET last_activity_at = ? WHERE id = ?", (time.time(), meeting_id))
    conn.commit()


def end_meeting(meeting_id: str) -> dict[str, Any] | None:
    conn = _conn()
    now = time.time()
    cur = conn.execute(
        "UPDATE meetings SET status='ended', ended_at=coalesce(ended_at, ?), last_activity_at=? WHERE id=?",
        (now, now, meeting_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        return None
    return get_meeting(meeting_id)


def finalize_stale(max_idle_seconds: float = 900) -> list[str]:
    """End meetings left 'live' with no activity (e.g. browser crashed)."""
    conn = _conn()
    cutoff = time.time() - max_idle_seconds
    rows = conn.execute(
        "SELECT id FROM meetings WHERE status='live' AND last_activity_at < ?", (cutoff,)
    ).fetchall()
    ids = [r["id"] for r in rows]
    for mid in ids:
        conn.execute(
            "UPDATE meetings SET status='ended', ended_at=last_activity_at WHERE id=?", (mid,)
        )
    conn.commit()
    return ids


def delete_meeting(meeting_id: str) -> bool:
    conn = _conn()
    cur = conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    conn.commit()
    return cur.rowcount > 0


def set_summary(
    meeting_id: str,
    *,
    status: str,
    summary: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    conn = _conn()
    if summary is not None:
        conn.execute(
            """UPDATE meetings SET summary_json=?, summary_status=?, summary_error=NULL,
                   summary_updated_at=? WHERE id=?""",
            (json.dumps(summary), status, time.time(), meeting_id),
        )
    else:
        conn.execute(
            "UPDATE meetings SET summary_status=?, summary_error=? WHERE id=?",
            (status, error, meeting_id),
        )
    conn.commit()


def set_memory_status(
    meeting_id: str,
    *,
    status: str,
    error: str | None = None,
    doc_id: str | None = None,
) -> None:
    conn = _conn()
    if status == "synced":
        conn.execute(
            """UPDATE meetings SET memory_status='synced', memory_error=NULL, memory_synced_at=?,
                   memory_doc_id=coalesce(?, memory_doc_id) WHERE id=?""",
            (time.time(), doc_id, meeting_id),
        )
    else:
        conn.execute(
            "UPDATE meetings SET memory_status=?, memory_error=? WHERE id=?",
            (status, error, meeting_id),
        )
    conn.commit()


def meetings_needing_memory_sync() -> list[str]:
    rows = _conn().execute(
        """SELECT m.id FROM meetings m
           WHERE m.memory_status IN ('pending', 'no_key', 'error')
             AND EXISTS (SELECT 1 FROM segments s WHERE s.meeting_id = m.id)
           ORDER BY m.started_at"""
    ).fetchall()
    return [r["id"] for r in rows]


# ── Segments ──────────────────────────────────────────────────────────


def add_segment(
    meeting_id: str,
    *,
    text: str,
    source: str = "tab",
    speaker: str | None = None,
    translated_text: str | None = None,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> dict[str, Any]:
    conn = _conn()
    now = time.time()
    if start_ms is None:
        row = conn.execute("SELECT started_at FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        start_ms = int((now - row["started_at"]) * 1000) if row else 0
    cur = conn.execute(
        """INSERT INTO segments (meeting_id, source, speaker, text, translated_text, start_ms, end_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (meeting_id, source, speaker, text.strip(), translated_text, int(start_ms), end_ms, now),
    )
    conn.execute("UPDATE meetings SET last_activity_at = ? WHERE id = ?", (now, meeting_id))
    conn.commit()
    return get_segment(int(cur.lastrowid))  # type: ignore[arg-type,return-value]


def get_segment(segment_id: int) -> dict[str, Any] | None:
    row = _conn().execute("SELECT * FROM segments WHERE id = ?", (segment_id,)).fetchone()
    return dict(row) if row else None


def set_segment_translation(segment_id: int, translated_text: str) -> None:
    conn = _conn()
    conn.execute(
        "UPDATE segments SET translated_text = ? WHERE id = ?",
        (translated_text.strip(), segment_id),
    )
    conn.commit()


def list_segments(meeting_id: str, after_id: int = 0) -> list[dict[str, Any]]:
    rows = _conn().execute(
        "SELECT * FROM segments WHERE meeting_id = ? AND id > ? ORDER BY start_ms, id",
        (meeting_id, after_id),
    ).fetchall()
    return [dict(r) for r in rows]


def count_segments(meeting_id: str) -> int:
    row = _conn().execute("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?", (meeting_id,)).fetchone()
    return int(row["n"]) if row else 0


_STOPWORDS = frozenset(
    """a about above after again all also am an and any are as at be because been before being below
    between both but by can could did do does doing done down during each few for from further had has
    have having he her here hers him his how i if in into is it its just let lets let's me more most my
    no nor not now of off on once only or other our ours out over own said same say says she should so
    some such than that that's the their theirs them then there these they this those through to too
    under until up us very was we were what what's when where which while who whom why will with would
    you your yours tell anything something everything thing things get got meeting meetings""".split()
)


def _fts_query(text: str) -> str:
    tokens = [t.strip("'") for t in re.findall(r"[\w']+", text.lower())]
    tokens = [t for t in tokens if len(t) > 1]
    keywords = [t for t in tokens if t not in _STOPWORDS]
    chosen = list(dict.fromkeys(keywords or tokens))[:24]
    if not chosen:
        return ""
    return " OR ".join(f'"{t}"' for t in chosen)


def search_segments(query: str, *, meeting_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """BM25 keyword search over transcript segments (local RAG fallback)."""
    fts = _fts_query(query)
    if not fts:
        return []
    sql = """
        SELECT s.*, m.title AS meeting_title, m.started_at AS meeting_started_at, bm25(segments_fts) AS rank
        FROM segments_fts
        JOIN segments s ON s.id = segments_fts.rowid
        JOIN meetings m ON m.id = s.meeting_id
        WHERE segments_fts MATCH ?
    """
    params: list[Any] = [fts]
    if meeting_id:
        sql += " AND s.meeting_id = ?"
        params.append(meeting_id)
    sql += " ORDER BY rank LIMIT ?"
    params.append(max(1, min(limit, 100)))
    try:
        rows = _conn().execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []
    return [dict(r) for r in rows]


# ── Chat ──────────────────────────────────────────────────────────────


def add_chat_message(
    meeting_id: str | None,
    role: str,
    content: str,
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO chat_messages (meeting_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?)",
        (meeting_id, role, content, json.dumps(sources) if sources else None, time.time()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM chat_messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _chat_row(row)


def _chat_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["sources"] = json.loads(data.pop("sources_json")) if data.get("sources_json") else []
    return data


def list_chat_messages(meeting_id: str | None, limit: int = 100) -> list[dict[str, Any]]:
    conn = _conn()
    if meeting_id is None:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE meeting_id IS NULL ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY id DESC LIMIT ?", (meeting_id, limit)
        ).fetchall()
    return [_chat_row(r) for r in reversed(rows)]


def clear_chat(meeting_id: str | None) -> None:
    conn = _conn()
    if meeting_id is None:
        conn.execute("DELETE FROM chat_messages WHERE meeting_id IS NULL")
    else:
        conn.execute("DELETE FROM chat_messages WHERE meeting_id = ?", (meeting_id,))
    conn.commit()
