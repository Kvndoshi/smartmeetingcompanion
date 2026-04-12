"""
Local SQLite-based user profile store — replaces Convex for zero-setup dev.
"""

import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).resolve().parent.parent / "profiles.db"

_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    if not hasattr(_local, "conn"):
        _local.conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
    return _local.conn


def init_db() -> None:
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_profiles (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         TEXT UNIQUE NOT NULL,
            display_name    TEXT NOT NULL,
            email           TEXT,
            language        TEXT NOT NULL DEFAULT 'en',
            voice_profile_id        TEXT,
            voice_audio_path        TEXT,
            voice_profile_status    TEXT NOT NULL DEFAULT 'none',
            voice_profile_created_at REAL,
            created_at      REAL NOT NULL,
            updated_at      REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id
        ON user_profiles(user_id)
    """)
    conn.commit()


def upsert_profile(
    user_id: str,
    display_name: str,
    language: str,
    email: Optional[str] = None,
) -> dict:
    conn = _get_conn()
    now = time.time()
    existing = conn.execute(
        "SELECT id FROM user_profiles WHERE user_id = ?", (user_id,)
    ).fetchone()

    if existing:
        conn.execute(
            """UPDATE user_profiles
               SET display_name = ?, language = ?, email = COALESCE(?, email), updated_at = ?
               WHERE user_id = ?""",
            (display_name, language, email, now, user_id),
        )
    else:
        conn.execute(
            """INSERT INTO user_profiles
               (user_id, display_name, language, email, voice_profile_status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'none', ?, ?)""",
            (user_id, display_name, language, email, now, now),
        )
    conn.commit()
    return get_profile(user_id)  # type: ignore[return-value]


def get_profile(user_id: str) -> Optional[dict]:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)
    ).fetchone()
    if not row:
        return None
    return dict(row)


def update_voice_profile(
    user_id: str,
    voice_profile_id: str,
    voice_profile_status: str,
    voice_audio_path: Optional[str] = None,
) -> Optional[dict]:
    conn = _get_conn()
    now = time.time()
    conn.execute(
        """UPDATE user_profiles
           SET voice_profile_id = ?,
               voice_profile_status = ?,
               voice_audio_path = COALESCE(?, voice_audio_path),
               voice_profile_created_at = ?,
               updated_at = ?
           WHERE user_id = ?""",
        (voice_profile_id, voice_profile_status, voice_audio_path, now, now, user_id),
    )
    conn.commit()
    return get_profile(user_id)


def set_voice_status(user_id: str, status: str) -> Optional[dict]:
    conn = _get_conn()
    now = time.time()
    conn.execute(
        "UPDATE user_profiles SET voice_profile_status = ?, updated_at = ? WHERE user_id = ?",
        (status, now, user_id),
    )
    conn.commit()
    return get_profile(user_id)


def list_profiles() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM user_profiles ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]
