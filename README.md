# Distill — Live Speaker Translation

Distill is a local-first live translation setup made of a Chrome extension and a FastAPI backend. The extension captures tab audio, streams it to the backend over WebSocket, and plays translated audio back through your selected output device.

## Current Project Shape

- `backend/` is the active server. It handles translation sessions, settings, and profile storage.
- `extension/` is the active Chrome extension you load into Chrome.
- User profiles are stored locally in SQLite at `backend/profiles.db`.
- `web/` still contains older prototype assets and Convex-related code, but it is not part of the current local setup documented here.

## Architecture

1. The extension captures tab audio in Chrome.
2. Audio is streamed to `ws://localhost:8000/ws/translate`.
3. The backend uses either `AzureTranslationClient` or `AzureConversationClient` for the STT path, depending on `STT_PROVIDER`.
4. The backend produces translated text from the incoming speech.
5. In the live extension flow, translated speech is synthesized with `AzureTtsClient`.
6. Translated audio is streamed back to the extension for playback.
7. The extension plays the translated audio through the selected output device.

## Quick Start

### 1. Start the backend

```bash
cd backend
cp .env.example .env
uv sync
uv run uvicorn main:app --reload --port 8000
```

Once the backend is running:

- Health check: `http://localhost:8000/health`
- Local dashboard: `http://localhost:8000/`

### 2. Add your API keys

Edit `backend/.env` and set the keys required for the path you are running.

For the current live Azure path:

- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION`

Other keys used elsewhere in the backend:

- `SPEECHMATICS_API_KEY`
- `MINIMAX_API_KEY`
- `SUPERMEMORY_API_KEY`

The backend also reads provider and tuning settings such as:

- `STT_PROVIDER`
- `TTS_PROVIDER`
- `TRANSLATION_TRIGGER_CHAR_THRESHOLD`
- `AZURE_SEGMENTATION_SILENCE_MS`
- `SPEECHMATICS_MAX_DELAY`

### 3. Build the Chrome extension

```bash
cd extension
npm install
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `extension/dist`

### 4. Use it

1. Open a tab with audio, such as Google Meet or YouTube
2. Click the Distill extension icon
3. Choose source and target language
4. Choose an output device
5. Start translation

## Audio Routing

Translated audio plays through the output device selected in the extension.

## Profiles And Storage

Profiles are managed by the backend and stored locally in SQLite. The relevant API routes are:

- `GET /api/profiles`
- `POST /api/profiles`
- `GET /api/voice-profile`
- `POST /api/voice-profile`
- `PATCH /api/voice-status`

The storage layer lives in `backend/services/profile_store.py`.

## Notes

- The extension expects the backend on `localhost:8000`.
- The backend serves a small local dashboard at `/` for health and some settings.
- The current live extension flow uses Azure for the active STT and TTS path.
- Some legacy Convex files still exist under `web/`, but the current README no longer treats them as part of the supported setup.

## Tech Stack

- Extension: React, TypeScript, Vite, Chrome MV3
- Backend: Python, FastAPI, WebSocket, SQLite, uv
- Live speech path: Azure Speech Translation or Azure Conversation Transcriber, plus Azure Speech Synthesis
- Other integrated services in the backend: Speechmatics, MiniMax, Supermemory
