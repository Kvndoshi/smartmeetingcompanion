"""
Interpreter Backend — FastAPI WebSocket Server
Handles: Audio → STT/Translation → TTS → Audio
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from pathlib import Path

from pydantic import BaseModel
from fastapi.responses import HTMLResponse, JSONResponse

from services.speechmatics_client import SpeechmaticsClient
from services.minimax_client import MinimaxClient, get_language_name
from services.speechmatics_tts_client import SpeechmaticsTTSClient
from services.azure_translation_client import AzureTranslationClient
from services.azure_tts_client import AzureTtsClient
from services.profile_store import init_db, get_profile, upsert_profile, update_voice_profile, set_voice_status, list_profiles

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interpreter")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Application lifespan context manager."""
    logger.info("Interpreter backend starting...")
    init_db()
    logger.info("SQLite profile store initialized")
    yield
    logger.info("Interpreter backend shutting down.")


app = FastAPI(title="Interpreter Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


ENV_PATH = Path(__file__).resolve().parent / ".env"

MANAGED_ENV_KEYS = [
    "SPEECHMATICS_API_KEY",
    "MINIMAX_API_KEY",
    "USE_SPEECHMATICS_TRANSLATION",
    "TTS_PROVIDER",
    "STT_PROVIDER",
    "TRANSLATION_TRIGGER_CHAR_THRESHOLD",
    "SPEECHMATICS_MAX_DELAY",
    "SPEECHMATICS_RT_WS_URL",
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "AZURE_SEGMENTATION_SILENCE_MS",
]


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
            vals[k.strip()] = v.strip()
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


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "interpreter-backend"}


@app.get("/api/settings")
async def get_settings():
    env = _read_env()
    result = {}
    for k in MANAGED_ENV_KEYS:
        val = env.get(k, "")
        if "KEY" in k and val:
            result[k] = val[:4] + "****" + val[-4:] if len(val) > 8 else "****"
        else:
            result[k] = val
    result["_keys_configured"] = bool(env.get("SPEECHMATICS_API_KEY"))
    return result


class SettingsPayload(BaseModel):
    settings: dict[str, str]


@app.post("/api/settings")
async def update_settings(payload: SettingsPayload):
    allowed = {k: v for k, v in payload.settings.items() if k in MANAGED_ENV_KEYS}
    if not allowed:
        return JSONResponse({"error": "No valid settings provided"}, status_code=400)
    _write_env(allowed)
    load_dotenv(override=True)
    return {"updated": list(allowed.keys()), "message": "Settings saved. Restart translation session to apply."}


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    html_path = Path(__file__).resolve().parent / "dashboard.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ── Voice Profile REST API (replaces Convex) ──────────────────────────


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


@app.get("/api/voice-profile")
async def get_voice_profile(userId: str):
    """Lookup a user's voice profile by userId — mirrors the old Convex HTTP endpoint."""
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


@app.websocket("/ws/translate")
async def websocket_translate(ws: WebSocket):
    """
    Main translation WebSocket endpoint.

    Protocol:
    - Client sends JSON config first: { type: "config", source_lang, target_lang }
    - Client sends binary PCM audio chunks (16kHz, mono, int16)
    - Server sends back:
      - JSON: { type: "transcript", text: "...", is_final: bool }
      - JSON: { type: "translated_text", text: "..." }
      - Binary: translated audio (audio bytes from selected TTS provider)
    """
    await ws.accept()
    logger.info("Client connected")

    source_lang = "en"
    target_lang = "es"

    speechmatics_key = os.getenv("SPEECHMATICS_API_KEY", "")
    minimax_key = os.getenv("MINIMAX_API_KEY", "")
    minimax_group_id = os.getenv("MINIMAX_GROUP_ID", "")
    use_speechmatics_translation = os.getenv(
        "USE_SPEECHMATICS_TRANSLATION", "1"
    ).strip().lower() not in {"0", "false", "no"}
    tts_provider = os.getenv("TTS_PROVIDER", "azure").strip().lower() or "azure"
    translation_trigger_chars = int(
        os.getenv("TRANSLATION_TRIGGER_CHAR_THRESHOLD", "24")
    )
    translation_partial_min_delta_chars = int(
        os.getenv("TRANSLATION_PARTIAL_MIN_DELTA_CHARS", "12")
    )
    translation_partial_min_interval = (
        int(os.getenv("TRANSLATION_PARTIAL_MIN_INTERVAL_MS", "300")) / 1000.0
    )

    stt_provider = os.getenv("STT_PROVIDER", "azure").strip().lower() or "azure"
    if stt_provider not in {"azure", "speechmatics"}:
        stt_provider = "azure"

    azure_key = os.getenv("AZURE_SPEECH_KEY", "")
    azure_region = os.getenv("AZURE_SPEECH_REGION", "eastus")

    stt_client: SpeechmaticsClient | AzureTranslationClient | None = None
    minimax = MinimaxClient(api_key=minimax_key, group_id=minimax_group_id)
    speechmatics_tts = SpeechmaticsTTSClient(api_key=speechmatics_key)
    azure_tts = AzureTtsClient(api_key=azure_key, region=azure_region)
    connection_open = True

    # Buffer for accumulating transcript before translation
    transcript_buffer = ""
    translation_lock = asyncio.Lock()
    translation_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1)
    translation_worker_task: asyncio.Task | None = None

    async def safe_send_json(payload: dict) -> bool:
        nonlocal connection_open
        if not connection_open:
            return False
        try:
            await ws.send_json(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            connection_open = False
            return False

    async def safe_send_bytes(payload: bytes) -> bool:
        nonlocal connection_open
        if not connection_open:
            return False
        try:
            await ws.send_bytes(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            connection_open = False
            return False

    async def enqueue_translation(text: str) -> None:
        if not text.strip() or not connection_open:
            return
        # Keep queue low-latency by dropping stale pending items.
        while not translation_queue.empty():
            try:
                translation_queue.get_nowait()
                translation_queue.task_done()
            except asyncio.QueueEmpty:
                break
        await translation_queue.put(text.strip())

    async def translation_worker() -> None:
        while True:
            item = await translation_queue.get()
            try:
                if item is None:
                    return
                if stt_provider == "azure" or use_speechmatics_translation:
                    await speak_translated_text(item)
                else:
                    await translate_and_speak(item)
            finally:
                translation_queue.task_done()

    async def on_transcript(text: str, is_final: bool):
        """Called when STT produces a transcript segment."""
        nonlocal transcript_buffer

        if not connection_open:
            return

        try:
            sent = await safe_send_json({
                "type": "transcript",
                "text": text,
                "is_final": is_final,
            })
            if not sent:
                return

            if is_final and text.strip():
                if stt_provider == "azure" or use_speechmatics_translation:
                    return

                transcript_buffer += " " + text.strip()

                if (
                    len(transcript_buffer) > translation_trigger_chars
                    or transcript_buffer.rstrip().endswith((".", "!", "?", "。", "！", "？"))
                ):
                    await enqueue_translation(transcript_buffer.strip())
                    transcript_buffer = ""
        except (ConnectionError, RuntimeError) as e:
            logger.error("Error in on_transcript: %s", e)

    async def on_translation(text: str, is_final: bool):
        """Called when Speechmatics produces translated text."""
        if not connection_open:
            return

        try:
            if is_final:
                sent = await safe_send_json({
                    "type": "translated_text",
                    "text": text,
                })
                if not sent:
                    return
                await enqueue_translation(text)
            else:
                await safe_send_json({
                    "type": "translated_text_partial",
                    "text": text,
                })
        except (ConnectionError, RuntimeError) as e:
            logger.error("Error in on_translation: %s", e)

    async def synthesize_tts(translated_text: str) -> bytes | None:
        gender_hint: str | None = None
        if isinstance(stt_client, AzureTranslationClient):
            gender_hint = stt_client.last_speaker_gender

        if tts_provider == "azure":
            audio_data = await azure_tts.text_to_speech(
                text=translated_text,
                language=target_lang,
                gender_hint=gender_hint,
            )
            if audio_data:
                return audio_data
            logger.warning(
                "Azure TTS returned no audio for target language '%s'; "
                "falling back to MiniMax TTS.",
                target_lang,
            )

        if tts_provider == "speechmatics":
            audio_data = await speechmatics_tts.text_to_speech(
                text=translated_text,
                language=target_lang,
            )
            if audio_data:
                return audio_data
            logger.warning(
                "Speechmatics TTS returned no audio for target language '%s'; "
                "falling back to MiniMax TTS.",
                target_lang,
            )

        return await minimax.text_to_speech(
            text=translated_text,
            language=target_lang,
        )

    async def speak_translated_text(translated_text: str):
        """Generate and send TTS audio from already-translated text."""
        async with translation_lock:
            if not connection_open or not translated_text.strip():
                return

            try:
                logger.info("[Translate] (Speechmatics) → %s", translated_text)

                audio_data = await synthesize_tts(translated_text)
                if audio_data:
                    sent = await safe_send_bytes(audio_data)
                    if sent:
                        logger.info("[TTS] Sent %d bytes of audio", len(audio_data))
            except (httpx.HTTPStatusError, ConnectionError, ValueError) as e:
                logger.error("TTS error: %s", e)
                await safe_send_json({
                    "type": "error",
                    "message": str(e),
                })

    async def translate_and_speak(text: str):
        """Translate text and send back TTS audio."""
        async with translation_lock:
            if not connection_open or not text.strip():
                return
            try:
                # Step 1: Translate via MiniMax LLM
                src_name = get_language_name(source_lang)
                tgt_name = get_language_name(target_lang)

                translated_chunks: list[str] = []
                translated = ""
                last_partial_emit_at = 0.0
                last_partial_emit_len = 0
                async for chunk in minimax.translate_stream(
                    text=text,
                    source_language=src_name,
                    target_language=tgt_name,
                ):
                    if not connection_open:
                        return
                    translated_chunks.append(chunk)
                    translated = "".join(translated_chunks).strip()
                    if translated:
                        now = time.monotonic()
                        delta_len = len(translated) - last_partial_emit_len
                        should_emit_partial = (
                            delta_len >= translation_partial_min_delta_chars
                            or (now - last_partial_emit_at) >= translation_partial_min_interval
                            or translated.endswith((".", "!", "?", "。", "！", "？"))
                        )
                        if should_emit_partial:
                            sent = await safe_send_json({
                                "type": "translated_text_partial",
                                "text": translated,
                            })
                            if not sent:
                                return
                            last_partial_emit_at = now
                            last_partial_emit_len = len(translated)

                # Fallback if streaming returned no text.
                if not translated:
                    translated = await minimax.translate(
                        text=text,
                        source_language=src_name,
                        target_language=tgt_name,
                    ) or ""
                translated = translated.strip()

                if not translated:
                    return

                # Send translated text to client
                sent = await safe_send_json({
                    "type": "translated_text",
                    "text": translated,
                })
                if not sent:
                    return

                logger.info("[Translate] %s → %s", text, translated)

                # Step 2: TTS via MiniMax Speech
                audio_data = await synthesize_tts(translated)

                if audio_data:
                    # Send binary audio back
                    sent = await safe_send_bytes(audio_data)
                    if sent:
                        logger.info("[TTS] Sent %d bytes of audio", len(audio_data))

            except (httpx.HTTPStatusError, ConnectionError, ValueError) as e:
                logger.error("Translation/TTS error: %s", e)
                await safe_send_json({
                    "type": "error",
                    "message": str(e),
                })

    try:
        translation_worker_task = asyncio.create_task(translation_worker())

        while True:
            data = await ws.receive()
            if data.get("type") == "websocket.disconnect":
                connection_open = False
                break

            if "text" in data:
                # JSON message
                msg = json.loads(data["text"])

                if msg.get("type") == "config":
                    source_lang = msg.get("source_lang", "en")
                    target_lang = msg.get("target_lang", "es")
                    requested_tts_provider = str(msg.get("tts_provider", "")).strip().lower()
                    if requested_tts_provider in {"minimax", "speechmatics", "azure"}:
                        tts_provider = requested_tts_provider
                    logger.info("Config: %s → %s", source_lang, target_lang)
                    logger.info("STT provider: %s  TTS provider: %s", stt_provider, tts_provider)

                    if stt_client:
                        await stt_client.close()

                    if stt_provider == "azure":
                        stt_client = AzureTranslationClient(
                            api_key=azure_key,
                            region=azure_region,
                            language=source_lang,
                            target_language=target_lang,
                            on_transcript=on_transcript,
                            on_translation=on_translation,
                        )
                    else:
                        stt_client = SpeechmaticsClient(
                            api_key=speechmatics_key,
                            language=source_lang,
                            target_language=target_lang if use_speechmatics_translation else None,
                            on_transcript=on_transcript,
                            on_translation=on_translation if use_speechmatics_translation else None,
                        )
                    await stt_client.connect()
                    logger.info("STT client connected: provider=%s", stt_provider)

            elif "bytes" in data:
                if stt_client and stt_client.is_connected:
                    await stt_client.send_audio(data["bytes"])

    except WebSocketDisconnect:
        connection_open = False
        logger.info("Client disconnected")
    except RuntimeError as e:
        connection_open = False
        logger.error("WebSocket error: %s", e)
    finally:
        connection_open = False

        if translation_worker_task:
            while not translation_queue.empty():
                try:
                    translation_queue.get_nowait()
                    translation_queue.task_done()
                except asyncio.QueueEmpty:
                    break
            await translation_queue.put(None)
            try:
                await translation_worker_task
            except asyncio.CancelledError:
                pass

        if stt_client:
            await stt_client.close()
        await speechmatics_tts.close()
        await minimax.close()
        await azure_tts.close()
        logger.info("Session cleaned up")
