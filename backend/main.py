"""
Distill backend — FastAPI server for the Smart Meeting Companion.

- /ws/translate      live audio → STT → (translation → TTS) + meeting transcript
- /api/meetings/*    stored meetings, summaries, Markdown export
- /api/chat          chat with a meeting or across meetings (RAG, SSE stream)
- /api/providers     which STT / TTS / LLM / memory providers are configured
- /api/settings      read/write backend/.env from the local dashboard
- /api/memories/*    Supermemory search (Memories tab)
"""

import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from routers.meetings import router as meetings_router
from services import background, meeting_store
from services.profile_store import (
    get_profile,
    init_db,
    list_profiles,
    set_voice_status,
    update_voice_profile,
    upsert_profile,
)
from services.providers import registry
from services.session import LiveSession
from supermemory.query import query_memories

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interpreter")

# Browser pages may only talk to the backend from the extension or localhost.
# Non-browser clients (tests, scripts) send no Origin header and are allowed.
ALLOWED_ORIGIN_REGEX = os.getenv(
    "ALLOWED_ORIGIN_REGEX",
    r"^(chrome-extension|moz-extension|edge-extension)://[a-z0-9]+$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
)


def origin_allowed(origin: str | None) -> bool:
    return not origin or bool(re.match(ALLOWED_ORIGIN_REGEX, origin))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("Distill backend starting...")
    init_db()
    meeting_store.init_db()
    stale = meeting_store.finalize_stale()
    if stale:
        logger.info("Finalized %d stale live meetings", len(stale))
    from supermemory import sync

    background.spawn(sync.sync_pending(), name="memory-sync-pending")
    yield
    await background.drain(timeout=10.0)
    logger.info("Distill backend shutting down.")


app = FastAPI(title="Distill Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(meetings_router)


# ── Settings (.env) ───────────────────────────────────────────────────

MANAGED_ENV_KEYS = [
    # API keys
    "SONIOX_API_KEY",
    "DEEPGRAM_API_KEY",
    "SPEECHMATICS_API_KEY",
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "AZURE_TRANSLATOR_KEY",
    "AZURE_TRANSLATOR_REGION",
    "MINIMAX_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "SUPERMEMORY_API_KEY",
    # Provider defaults
    "STT_PROVIDER",
    "TTS_PROVIDER",
    "LLM_PROVIDER",
    "TRANSLATION_PROVIDER",
    "LLM_TRANSLATION_PROVIDER",
    # Models
    "GEMINI_MODEL",
    "GEMINI_FAST_MODEL",
    "GROQ_MODEL",
    "GROQ_FAST_MODEL",
    "SONIOX_STT_MODEL",
    "SONIOX_TTS_MODEL",
    "SONIOX_TTS_VOICE",
    "DEEPGRAM_STT_MODEL",
    # Behaviour / tuning
    "AUTO_SUMMARY",
    "SUMMARY_LANGUAGE",
    "TRANSLATION_TRIGGER_CHAR_THRESHOLD",
    "AZURE_SEGMENTATION_SILENCE_MS",
    "SPEECHMATICS_MAX_DELAY",
    "SPEECHMATICS_RT_WS_URL",
    "USE_SPEECHMATICS_TRANSLATION",
]

_SECRET_RE = re.compile(r"(_KEY|_TOKEN|_SECRET)$")


def _read_env() -> dict[str, str]:
    vals: dict[str, str] = {}
    if not ENV_PATH.exists():
        return vals
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


def _write_env(updates: dict[str, str]) -> None:
    lines: list[str] = []
    seen: set[str] = set()
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                k = stripped.split("=", 1)[0].strip()
                if k in updates:
                    lines.append(f"{k}={updates[k]}")
                    seen.add(k)
                    continue
            lines.append(line)
    for k, v in updates.items():
        if k not in seen:
            lines.append(f"{k}={v}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _mask(value: str) -> str:
    if not value:
        return ""
    return value[:4] + "****" + value[-4:] if len(value) > 8 else "****"


@app.get("/health")
async def health():
    return {"status": "ok", "service": "distill-backend"}


@app.get("/api/providers")
async def api_providers():
    return registry.status()


@app.get("/api/settings")
async def get_settings():
    env = _read_env()
    result: dict[str, object] = {}
    for k in MANAGED_ENV_KEYS:
        val = env.get(k, "")
        result[k] = _mask(val) if _SECRET_RE.search(k) else val
    status = registry.status()
    result["_providers"] = {
        kind: {p["id"]: p["configured"] for p in status[kind]["providers"]} for kind in ("stt", "tts", "llm")
    }
    result["_defaults"] = {kind: status[kind]["default"] for kind in ("stt", "tts", "llm", "translator")}
    result["_memory"] = status["memory"]
    result["_keys_configured"] = bool(status["stt"]["default"])
    return result


class SettingsPayload(BaseModel):
    settings: dict[str, str]


@app.post("/api/settings")
async def update_settings(payload: SettingsPayload):
    allowed: dict[str, str] = {}
    for k, v in payload.settings.items():
        if k not in MANAGED_ENV_KEYS:
            continue
        v = (v or "").strip()
        if _SECRET_RE.search(k) and "****" in v:
            continue  # never write a masked value back over the real key
        if "\n" in v or "\r" in v:
            return JSONResponse({"error": f"Invalid value for {k}"}, status_code=400)
        allowed[k] = v
    if not allowed:
        return JSONResponse({"error": "No valid settings provided"}, status_code=400)
    _write_env(allowed)
    load_dotenv(ENV_PATH, override=True)
    for k, v in allowed.items():
        if v == "":
            os.environ.pop(k, None)
    if allowed.get("SUPERMEMORY_API_KEY"):
        from supermemory import sync

        background.spawn(sync.sync_pending(), name="memory-sync-after-settings")
    return {"updated": list(allowed.keys()), "message": "Settings saved. New sessions use them immediately."}


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    html_path = Path(__file__).resolve().parent / "dashboard.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ── Voice Profile REST API ────────────────────────────────────────────


class ProfilePayload(BaseModel):
    user_id: str
    display_name: str
    language: str
    email: str | None = None


class VoiceProfilePayload(BaseModel):
    user_id: str
    voice_profile_id: str
    voice_profile_status: str = "ready"
    voice_audio_path: str | None = None


class VoiceStatusPayload(BaseModel):
    user_id: str
    status: str


class MemoryQueryPayload(BaseModel):
    query: str
    limit: int = 5
    tab_url: str | None = None
    container_tag: str | None = None
    scope: str | None = None
    llm_answer: bool = True


@app.get("/api/voice-profile")
async def get_voice_profile(userId: str):
    profile = get_profile(userId)
    if not profile:
        return JSONResponse({"error": "Profile not found"}, status_code=404)
    return {
        "voiceProfileId": profile.get("voice_profile_id"),
        "voiceAudioUrl": profile.get("voice_audio_path"),
        "voiceProfileStatus": profile.get("voice_profile_status", "none"),
        "language": profile.get("language"),
        "displayName": profile.get("display_name"),
    }


@app.get("/api/profiles")
async def api_list_profiles():
    return list_profiles()


@app.post("/api/profiles")
async def api_upsert_profile(payload: ProfilePayload):
    return upsert_profile(
        user_id=payload.user_id,
        display_name=payload.display_name,
        language=payload.language,
        email=payload.email,
    )


@app.post("/api/voice-profile")
async def api_update_voice_profile(payload: VoiceProfilePayload):
    result = update_voice_profile(
        user_id=payload.user_id,
        voice_profile_id=payload.voice_profile_id,
        voice_profile_status=payload.voice_profile_status,
        voice_audio_path=payload.voice_audio_path,
    )
    if not result:
        return JSONResponse({"error": "Profile not found. Create a profile first."}, status_code=404)
    return result


@app.patch("/api/voice-status")
async def api_set_voice_status(payload: VoiceStatusPayload):
    result = set_voice_status(user_id=payload.user_id, status=payload.status)
    if not result:
        return JSONResponse({"error": "Profile not found"}, status_code=404)
    return result


@app.post("/api/memories/query")
async def api_query_memories(payload: MemoryQueryPayload):
    query = payload.query.strip()
    if not query:
        return JSONResponse({"error": "Query is required"}, status_code=400)

    try:
        result = await query_memories(
            query,
            limit=max(1, min(payload.limit, 8)),
            tab_url=payload.tab_url,
            container_tag=payload.container_tag,
            scope=payload.scope,
            excerpt_limit=1200,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except httpx.HTTPStatusError as exc:
        logger.exception("Supermemory query failed with status %s", exc.response.status_code)
        return JSONResponse(
            {"error": "Supermemory query failed", "details": exc.response.text},
            status_code=502,
        )
    except httpx.HTTPError as exc:
        logger.exception("Supermemory query transport error")
        return JSONResponse(
            {"error": "Could not reach Supermemory", "details": str(exc)},
            status_code=502,
        )

    if payload.llm_answer:
        from services.chat import compose_memory_answer

        composed = await compose_memory_answer(query, result.get("memories", []))
        if composed:
            result["answer"] = composed
            result["answer_source"] = "llm"
    for memory in result.get("memories", []):
        excerpt = memory.get("excerpt") or ""
        if len(excerpt) > 320:
            memory["excerpt"] = excerpt[:319].rstrip() + "…"
    return result


# ── Live audio WebSocket ──────────────────────────────────────────────


@app.websocket("/ws/translate")
async def websocket_translate(ws: WebSocket):
    """See services/session.py for the protocol."""
    origin = ws.headers.get("origin")
    if not origin_allowed(origin):
        logger.warning("Rejected WebSocket from origin %s", origin)
        await ws.close(code=1008)
        return
    await LiveSession(ws).run()
