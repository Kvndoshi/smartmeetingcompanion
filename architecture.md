# Distill — Architecture

End-to-end data flow from tab audio capture to translated playback.

## High-Level Flow

```mermaid
flowchart LR
    A["Tab Audio (Google Meet/YouTube/etc.)"] --> B["Chrome Extension Offscreen Capture"]
    B --> C["Extension Service Worker"]
    C -->|"ws://localhost:8000/ws/translate"| D["FastAPI WebSocket Backend"]
    D --> E["Azure STT + Translation"]
    D --> F["Azure Speech Synthesis (TTS)"]
    F --> G["Translated Audio Bytes"]
    G --> C
    C --> H["Offscreen Playback + setSinkId"]
    H --> I["Selected Output Device"]
```

## Detailed Sequence

```mermaid
sequenceDiagram
    participant Tab as Tab Audio Source
    participant OFS as extension/src/offscreen/offscreen.ts
    participant BG as extension/src/background.ts
    participant API as backend/main.py
    participant AZ_STT as AzureTranslationClient / AzureConversationClient
    participant AZ_TTS as backend/services/azure_tts_client.py

    Note over BG,OFS: Start Translation
    BG->>OFS: start-capture {streamId, outputDeviceId}
    OFS->>OFS: setOutputDevice(outputDeviceId)
    OFS->>OFS: capture tab audio via AudioWorklet (48k -> 16k PCM)

    loop Audio chunks
        OFS->>BG: audio-data (Int16 PCM bytes)
        BG->>API: websocket binary send
        API->>AZ_STT: send_audio(bytes)
    end

    Note over AZ_STT,API: Azure Speech recognition + translation
    AZ_STT-->>API: recognized + translated text
    API-->>BG: transcript + translated_text messages

    Note over API: Final translated text enters TTS queue
    API->>AZ_TTS: synthesize(translated_text, target_lang)
    AZ_TTS-->>API: translated audio bytes

    API-->>BG: websocket binary audio
    BG->>OFS: translated-audio (byte array)
    OFS->>OFS: detect MIME, AudioElement.play()
    OFS->>OFS: setSinkId(selected output device)
```

## Runtime Controls (`backend/.env`)

- `STT_PROVIDER`
  - `azure` (default): uses `AzureTranslationClient` or `AzureConversationClient` depending on mode.
  - `speechmatics`: uses Speechmatics RT as alternative STT + translation path.

- `TTS_PROVIDER`
  - `azure` (default): uses Azure Speech Synthesis via `AzureTtsClient`.
  - `minimax`: uses MiniMax TTS as alternative.
  - `speechmatics`: preview test option.

- `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`
  - required for the live Azure STT and TTS path.

- `SPEECHMATICS_API_KEY`
  - required when using Speechmatics as STT or TTS provider.

- `MINIMAX_API_KEY`
  - required when using MiniMax as TTS provider.

- `TRANSLATION_TRIGGER_CHAR_THRESHOLD`, `AZURE_SEGMENTATION_SILENCE_MS`, `SPEECHMATICS_MAX_DELAY`
  - tuning parameters for translation timing and segmentation.

## Profiles and Storage

User profiles are managed by the backend and stored locally in SQLite. The storage layer lives in `backend/services/profile_store.py`. Relevant API routes:

- `GET /api/profiles`
- `POST /api/profiles`
- `GET /api/voice-profile`
- `POST /api/voice-profile`
- `PATCH /api/voice-status`

## Key Files

- Extension capture/playback:
  - `extension/src/offscreen/offscreen.ts`
  - `extension/src/background.ts`
- Backend orchestrator:
  - `backend/main.py`
- Azure provider clients:
  - `backend/services/azure_translation_client.py`
  - `backend/services/azure_conversation_client.py`
  - `backend/services/azure_tts_client.py`
- Alternative provider clients:
  - `backend/services/speechmatics_client.py`
  - `backend/services/speechmatics_tts_client.py`
  - `backend/services/minimax_client.py`
- Profile storage:
  - `backend/services/profile_store.py`
