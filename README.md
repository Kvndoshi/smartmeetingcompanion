# Distill — Live Translation & Meeting Notes

Distill is a local-first meeting companion: a Chrome/Edge extension plus a FastAPI backend. It works with any meeting or video that plays in a browser tab: Google Meet, Microsoft Teams (web), Zoom (web client), Webex or YouTube. It can:

- **Translate live.** You hear other participants in your language. On Google Meet, other participants can also hear *you* translated.
- **Transcribe.** You get a live, speaker-labelled transcript, and you can add your own microphone.
- **Summarize.** You get an overview, decisions, action items (with owner and due date), open questions, topics and next steps. This is written automatically when the meeting ends, or on demand.
- **Chat with your meetings.** Ask questions about one meeting, or search across all of them using Supermemory.

Desktop apps (Zoom/Teams desktop) can't be captured by a browser extension. Use their web clients.

## How it works

```
meeting tab ──tabCapture──▶ offscreen doc ──16 kHz PCM──▶ service worker ──WebSocket──▶ backend
                                                                                   │
        side panel / popup / Meet widget ◀── transcript, translation, state ◀──────┤ STT → translate → TTS
        translated audio ◀── offscreen playback ◀──────────── WAV ◀─────────────────┤
                                                                                   ▼
                                    SQLite (meetings, segments, chat) → summarizer (Gemini/Groq) → Supermemory
```

- Incoming translation and transcription use `chrome.tabCapture`, not WebRTC, so they work on any tab.
- Outgoing translation ("Translate my voice") is Meet-only. It intercepts Meet's `RTCPeerConnection` mic track and replaces it with the translated audio.
- The local SQLite store is the live record of each transcript. Supermemory is the long-term memory used for "all meetings" chat.

See [architecture.md](architecture.md) for the full design and protocol.

## Providers

Add a key for any provider and it becomes available. If you don't choose one, Distill picks the first configured provider in the order shown.

| Capability | Providers (default order) |
|---|---|
| Speech-to-text | **Soniox** (diarization + native translation) → **Deepgram** (diarization) → Speechmatics (native translation) → Azure Speech (translation, or `azure_diarize` for speakers) |
| Text-to-speech | Soniox → Azure Neural TTS → Deepgram → MiniMax → Speechmatics (preview, English only) |
| LLM (summaries, chat, text translation) | **Gemini** → **Groq** (both through their OpenAI-compatible APIs) |
| Text translation (for STT providers without native translation) | LLM → Azure Translator → MiniMax |
| Memory | **Supermemory** (one document per meeting, upserted) |

You can override the defaults with `STT_PROVIDER`, `TTS_PROVIDER`, `LLM_PROVIDER` and `TRANSLATION_PROVIDER` in `backend/.env`, or per session in the popup.

## Quick start

### 1. Backend

```bash
cd backend
cp .env.example .env      # then add your keys (or use the dashboard)
uv sync
uv run uvicorn main:app --reload --port 8000
```

- Dashboard: `http://localhost:8000/`. It shows key status, lets you set and mask API keys, choose default providers and tune settings.
- Health check: `http://localhost:8000/health`. Configured providers: `http://localhost:8000/api/providers`.

**Minimum keys for everything:**
- Translation and transcription: `SONIOX_API_KEY`, or `DEEPGRAM_API_KEY` plus a TTS key.
- Summaries and chat: `GEMINI_API_KEY` or `GROQ_API_KEY`.
- Cross-meeting memory: `SUPERMEMORY_API_KEY`.

### 2. Extension

```bash
cd extension
npm ci
npm run build             # tsc + vite → extension/dist
```

Then open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and select `extension/dist`.

### 3. Use it

1. Open your meeting tab and click the Distill toolbar icon.
2. Pick the modes you want:
   - **Translate audio**: hear the meeting translated.
   - **Take notes**: get the transcript, summary and chat. Notes contain everything said in the meeting:
     - The other participants come from the tab audio.
     - You come from your microphone. **Include my microphone** is on by default, because the meeting tab never plays your own voice back.
     - The first time you press Start, a one-time "Allow microphone" page opens next to the meeting. Your voice joins the notes as soon as you allow it.
     - On Google Meet, the notes follow Meet's mute: nothing you say while muted, or before joining the call, is transcribed.
3. Choose languages and, optionally, providers. Then press **Start**. The notes side panel opens with the live transcript.
4. The side panel has four tabs:
   - **Live**: the transcript. You can rename speakers and type your own notes.
   - **Summary**: generate or regenerate the summary, pick its language, copy or download it as Markdown, and sync it to Supermemory.
   - **Ask**: chat about this meeting or all meetings.
   - **Meetings**: history, full-text search and delete.
5. **Stop & summarize** ends the meeting. The summary appears automatically if an LLM key is set.

On Google Meet, a floating widget also offers Start/Stop, **Translate my voice** and **Open notes panel**. Chrome only allows tab capture after you've clicked the toolbar icon on that tab, so if Start fails from the widget, start from the popup once.

**Audio routing.** In translate mode the tab is muted and only the translation plays, through the output device selected in the popup. To feed translated audio into another app, use a virtual device such as BlackHole or VB-Cable. In notes-only mode, or when no TTS voice is available, the original audio stays audible.

## Testing

```bash
cd backend
uv run pytest -q                              # 125 tests, zero API keys needed (fakes + E2E dry run)
uv run python scripts/smoke_providers.py      # live check of every provider that has a key
uv run python scripts/e2e_meeting.py          # charter criteria against a 5-min generated meeting
```

- The live E2E run talks to a running backend (`--base`, default `http://localhost:8000`), so start uvicorn first. It also needs the generated audio. Create it first with `powershell -File scripts/make_test_meeting.ps1`, which uses the Windows built-in voices.
- The E2E run grades:
  - STT word accuracy (≥ 85%),
  - summary decisions and action items,
  - chatbot answers (≥ 80%),
  - English → Spanish/French speech-to-speech.
- It writes a report to `backend/reports/`.

See [TESTING.md](TESTING.md) for the manual Chrome/Edge checklist.

## Project layout

- `backend/`: FastAPI app.
  - `main.py`: app, settings, profiles and the WebSocket entry point.
  - `services/session.py`: the live session pipeline.
  - `services/providers/`: STT, TTS and translator providers plus the registry.
  - `services/llm/`: the Gemini/Groq client.
  - `services/summarizer.py` and `services/chat.py`.
  - `services/meeting_store.py`: SQLite store with FTS5 search.
  - `supermemory/`: Supermemory client and sync.
  - `routers/meetings.py`: the meetings, summary and chat REST API.
- `extension/`: Chrome MV3 extension (React + TypeScript + Vite/CRXJS).
  - `src/background.ts`: the service worker.
  - `src/offscreen/`: audio capture and playback.
  - `src/sidepanel/`: the notes panel.
  - `src/popup/`.
  - `src/content/meet-*`: the Meet widget and outgoing translation.
  - `src/shared/`: protocol, API client and hooks.
- `web/`: legacy prototype, not part of the current setup.
