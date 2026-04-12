# Realtime TTS + Multi-Speaker + Dashboard Stop

**Date:** 2026-04-11
**Status:** Approved, implementing

## Goal

Fix three issues: (1) TTS latency — audio arrives ~1-2s after translation, (2) no way to stop translation from the dashboard, (3) all speakers share one voice.

## Changes

### 1. Streaming TTS (latency fix)

**Current:** `AzureTtsClient._synthesize_blocking` creates a new `SpeechConfig` + `SpeechSynthesizer` per call, waits for full audio, then sends all bytes at once. The `translation_lock` serializes TTS calls.

**New:**
- Reuse one `SpeechConfig` per `AzureTtsClient` instance (cache on init).
- Replace `text_to_speech` with `text_to_speech_streaming(text, language, voice_hint, on_chunk)` that uses the `synthesizing` event to send audio chunks to the client as they're generated.
- Remove `translation_lock` from `speak_translated_text` — concurrent TTS is safe since each call creates its own `SpeechSynthesizer`.
- Client already plays received bytes immediately, so incremental chunks just work.

### 2. Multi-speaker voice rotation

- Parse `SpeakerId` from Azure's detailed JSON result in `_update_gender_from_event`.
- Expose `last_speaker_id: str | None` on `AzureTranslationClient`.
- Add `_pick_voice_for_speaker(speaker_id, language, gender)` to `AzureTtsClient` that maps speakers to distinct voices using a round-robin pool of 2-3 voices per language.
- If `SpeakerId` is unavailable, alternate voices by sentence index as a fallback.
- Thread the combined `voice_hint` (speaker_id + gender) through to TTS.

### 3. Dashboard stop button

- Add "Start Translation" / "Stop Translation" buttons to `dashboard.html`.
- Send `{ type: "stop" }` over WebSocket from dashboard JS.
- Handle `{ type: "stop" }` in `main.py` WebSocket handler — close STT client, drain queue, reset state.
- Update dashboard UI to show translation status (idle/active).
- Update dashboard translation engine options to include Azure.

## Files touched

- `backend/services/azure_tts_client.py` — streaming synthesis, speaker voice rotation
- `backend/services/azure_translation_client.py` — SpeakerId parsing
- `backend/main.py` — remove lock, wire streaming TTS, handle stop message, pass speaker info
- `backend/dashboard.html` — stop/start buttons, Azure options, active status
