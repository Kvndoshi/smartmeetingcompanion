# Azure Speech Pipeline — Replacing Speechmatics + MiniMax

**Date:** 2026-04-11
**Status:** Approved for implementation plan
**Owner:** Kevin

## Goal

Replace the current Speechmatics (STT + translation) + MiniMax (LLM translation + TTS) pipeline with an Azure-only pipeline that is faster, more accurate, and does not spend LLM tokens for translation.

Primary target experience: a user speaks into the Chrome extension mic in one language, and within ~500 ms hears partial translated audio in another language, using a high-quality Azure neural voice.

Voice cloning is explicitly **out of scope for v1** (see "Out of scope" below), but the TTS layer is designed to be swappable so a cloning backend can replace it without touching the recognition pipeline.

## Non-goals

- Voice cloning of the input speaker. Investigated and rejected for v1 — Azure Personal Voice is gated, requires mandatory consent audio at the API level, and has no path for cloning third-party media.
- Chunk-level streaming of TTS audio back to the client (send first syllables before the full sentence is synthesized). Keeps current `send_bytes(full_audio)` contract; revisit in v2.
- Speaker diarization / multi-speaker sessions. Single speaker per WebSocket session assumed.
- Removal of Speechmatics or MiniMax code. They stay in the tree, dormant behind provider flags, as rollback paths.

## What we already validated

Smoke test `backend/scripts/test_azure_translation.py` confirmed on 2026-04-11:

- Azure Speech Translation streams partial + final transcripts and translations from the `eastus` region
- First partial arrives ~400–600 ms after the first spoken word (measured after adjusting for speaker reaction time in the raw script output)
- Translation quality is idiomatic (e.g. `"What do you do?"` → `"¿A qué te dedicas?"`), materially better than char-triggered LLM output
- The `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` pair from the multi-service `aifoundry2178453` resource authenticates successfully

## Architecture

```
Client (PCM 16k mono s16le)
      │
      ▼
FastAPI WebSocket  /ws/translate        (main.py)
      │
      │  provider selector: STT_PROVIDER
      │
      ├──► AzureTranslationClient         (services/azure_translation_client.py)
      │       uses azure.cognitiveservices.speech.translation.TranslationRecognizer
      │       wraps PushAudioInputStream for PCM injection
      │       emits on_transcript(text, is_final)
      │             on_translation(text, is_final)
      │
      └──► SpeechmaticsClient             (services/speechmatics_client.py, unchanged, fallback)

Translated text
      │
      │  provider selector: TTS_PROVIDER
      │
      ├──► AzureTtsClient                 (services/azure_tts_client.py)  ← new
      │       uses SpeechSynthesizer, picks voice by target_lang + gender hint
      │       returns full audio bytes (WAV/PCM)
      │
      ├──► SpeechmaticsTtsClient          (unchanged, fallback)
      └──► MinimaxClient.text_to_speech   (unchanged, fallback)

Audio bytes ──► WebSocket send_bytes ──► Client
```

The data flow stays linear: **audio in → translation stream → TTS call → audio out**. The Azure path collapses two external round-trips (Speechmatics + MiniMax) into one streaming connection plus one synth call.

## Components

### 1. `services/azure_translation_client.py` (new)

Thin wrapper around `azure.cognitiveservices.speech.translation.TranslationRecognizer` that:

- Accepts the same constructor shape as `SpeechmaticsClient` — `api_key`, `region`, `language`, `target_language`, `on_transcript`, `on_translation` — so `main.py` can swap providers by changing one line.
- Uses `PushAudioInputStream` configured for `AudioStreamFormat(samples_per_second=16000, bits_per_sample=16, channels=1)`. Each `send_audio(bytes)` call writes into the push stream.
- Attaches handlers for `recognizing`, `recognized`, `canceled`, `session_stopped`. The Speech SDK is sync/callback-based, so each handler marshals into the FastAPI event loop via `asyncio.run_coroutine_threadsafe(callback(...), loop)` captured at `connect()` time.
- Emits `on_transcript(text, is_final)` from `evt.result.text` and `on_translation(text, is_final)` from `evt.result.translations[target]`. Both fire from the same event, so the transcript and its translation are always in sync.
- Tunable endpointing: exposes `AZURE_SEGMENTATION_SILENCE_MS` (default 500, configurable down to ~200) via `speech_config.set_property(PropertyId.Speech_SegmentationSilenceTimeoutMs, ...)`.
- Best-effort speaker gender detection: each recognition event carries a JSON result blob accessible via `evt.result.properties.get(PropertyId.SpeechServiceResponse_JsonResult)`. If that blob contains a gender field, cache it on `self.last_speaker_gender` per event. **This is not guaranteed by the SDK** — if the field is missing, leave it as `None` and the TTS layer falls back to a neutral voice default. Gender is per-utterance, not session-wide, so a later event can overwrite it.
- `close()` calls `stop_continuous_recognition_async()` and cleans up the push stream.

### 2. `services/azure_tts_client.py` (new)

Thin wrapper around `SpeechSynthesizer` that:

- `async def text_to_speech(text: str, language: str, gender_hint: str | None = None) -> bytes | None`
- Chooses a neural voice from a built-in map keyed by `(language, gender)`, with env var overrides:
  ```
  AZURE_TTS_VOICE_EN_MALE=en-US-SteffanNeural
  AZURE_TTS_VOICE_EN_FEMALE=en-US-JennyNeural
  AZURE_TTS_VOICE_ES_MALE=es-ES-AlvaroNeural
  AZURE_TTS_VOICE_ES_FEMALE=es-ES-ElviraNeural
  AZURE_TTS_VOICE_ZH_MALE=zh-CN-YunxiNeural
  AZURE_TTS_VOICE_ZH_FEMALE=zh-CN-XiaoxiaoNeural
  # …one pair per supported target language
  ```
  Sensible defaults baked in, so the pipeline works out-of-box with no extra config.
- Output format: `Riff16Khz16BitMonoPcm` to match the client's existing audio handling (same sample rate as Speechmatics WAV output today).
- Returns full synthesized audio as `bytes` (keeps current `send_bytes(full_audio)` contract).
- Runs synth on a thread executor (`asyncio.to_thread`) because `SpeechSynthesizer.speak_text_async` is only thread-async, not asyncio-native.
- Single long-lived `SpeechConfig` per instance; one `SpeechSynthesizer` per call (cheap to create, avoids cross-call voice state).

### 3. `main.py` edits (minimal)

- Add new managed env keys: `STT_PROVIDER`, `TTS_PROVIDER`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SEGMENTATION_SILENCE_MS`, `AZURE_TTS_VOICE_*`.
- In `websocket_translate`, after loading env:
  ```python
  stt_provider = os.getenv("STT_PROVIDER", "azure").strip().lower()
  tts_provider = os.getenv("TTS_PROVIDER", "azure").strip().lower()
  ```
- Replace the `SpeechmaticsClient` construction block with a provider switch that builds either `AzureTranslationClient` or `SpeechmaticsClient` based on `stt_provider`. Both expose the same interface (`connect()`, `send_audio()`, `close()`, callbacks).
- Replace `synthesize_tts()` with a switch that picks one of `AzureTtsClient`, `SpeechmaticsTtsClient`, or `MinimaxClient` based on `tts_provider`. The new Azure branch additionally passes the `gender_hint` from `azure_translation_client.last_speaker_gender`.
- When `stt_provider == "azure"`:
  - Skip the MiniMax translation path entirely. Azure already translates inline.
  - Remove the `TRANSLATION_TRIGGER_CHAR_THRESHOLD` buffering logic inside `on_transcript`. Finals from Azure are already sentence-scoped via endpointing; buffering them further defeats the purpose.
- Defaults flipped: `STT_PROVIDER=azure`, `TTS_PROVIDER=azure`. Speechmatics and MiniMax stay available as explicit opt-ins.

### 4. `.env` additions

```
# Azure AI Services (multi-service key from aifoundry2178453)
AZURE_SPEECH_KEY=…         (already set)
AZURE_SPEECH_REGION=eastus (already set)

# Provider selection (new defaults)
STT_PROVIDER=azure         # azure | speechmatics
TTS_PROVIDER=azure         # azure | speechmatics | minimax

# Azure STT tuning
# Default 500 matches Azure's built-in endpointing. Drop to ~300 later if finals feel laggy
# after stopping speech; raise to ~800 if Azure is cutting mid-sentence.
AZURE_SEGMENTATION_SILENCE_MS=500

# Azure TTS voice map (optional overrides — sensible defaults baked in)
AZURE_TTS_VOICE_EN_MALE=en-US-SteffanNeural
AZURE_TTS_VOICE_EN_FEMALE=en-US-JennyNeural
AZURE_TTS_VOICE_ES_MALE=es-ES-AlvaroNeural
AZURE_TTS_VOICE_ES_FEMALE=es-ES-ElviraNeural
# …extend per target language as needed
```

### 5. `pyproject.toml` additions

```
"azure-cognitiveservices-speech>=1.49.0",
```

Already installed locally; just formalizing the dependency.

## Data flow — end-to-end trace

```
t=0      Client opens WS, sends {type:"config", source_lang:"zh", target_lang:"en"}
t=0+ε    main.py builds AzureTranslationClient, calls connect()
             → TranslationRecognizer authenticates with eastus, starts continuous recognition
             → session_started event fires
t=…      Client streams PCM 16k frames over WS (~100 ms each)
             → main.py forwards each frame to azure_translation_client.send_audio(bytes)
             → bytes land in PushAudioInputStream
             → Azure streams partial results back
t=T1     First recognizing event:
             on_transcript("Ni hao", is_final=False)
             on_translation("Hello", is_final=False)
             → safe_send_json({type:"transcript", …})
             → safe_send_json({type:"translated_text_partial", …})
t=T2     First recognized event (sentence final):
             on_transcript("Ni hao, wo shi Kevin", is_final=True)
             on_translation("Hello, I am Kevin", is_final=True)
             → safe_send_json({type:"translated_text", …})
             → enqueue_translation("Hello, I am Kevin")
             → translation_worker picks it up
             → speak_translated_text() calls synthesize_tts()
             → AzureTtsClient.text_to_speech(text, "en", gender_hint="male")
             → ~200–400 ms later, bytes return
             → safe_send_bytes(audio) → client plays
```

End-to-end, user-perceived latency from "stopped speaking" to "hears first translated audio" should land in the 700–1100 ms range on a healthy network. The STT+translation hop is ~400–600 ms; the TTS synth is ~200–400 ms.

## Error handling

- **Azure auth failure (`CancellationReason.Error` with `AuthenticationFailure`):** log, emit `{type: "error", message: "azure auth failed"}` to client, close WS with code 1011. No automatic retry — the key is wrong and retrying won't fix it.
- **Azure service error during session (network drop, rate limit):** log, attempt one reconnect of `AzureTranslationClient`, if second attempt fails emit `{type:"error"}` and close.
- **TTS synth failure (network, throttling):** log, send `{type:"error"}` but keep the WS open. The next utterance retries synth independently.
- **Speech SDK push-stream back-pressure:** the SDK internally buffers; if `send_audio` ever raises, log and mark `is_connected=False`, same pattern as the existing Speechmatics client.
- **Empty translation result:** skip TTS entirely (no point synthesizing empty text). Current behavior, preserved.
- **Event-loop marshaling failure:** if `run_coroutine_threadsafe` raises because the loop is closed, swallow the error — it only happens during shutdown, callbacks are best-effort at that point.

## Testing

Three layers:

1. **Unit — pure functions**
   - `AzureTtsClient._pick_voice(lang, gender)` — given `(lang, gender)` and an env state, returns the right voice name. Pure function, no SDK. Table-driven test over every language × gender × env-override combination.
   - `AzureTranslationClient._parse_gender(json_result)` — given a JSON result payload from Azure, returns `"male" | "female" | None`. Pure function.

2. **Integration — live Azure, automated**
   - Reuse the smoke test script as a pytest: `backend/tests/test_azure_translation_live.py`. Skipped when `AZURE_SPEECH_KEY` not set in env. Feeds a pre-recorded Chinese WAV file through the client, asserts a non-empty English translation comes back within 10 seconds. Single test, cheap to run, catches auth / region / SDK-version regressions.

3. **Manual — end-to-end through the extension**
   - Start the backend, open the extension, speak Chinese, verify English audio plays back within ~1.5 seconds of finishing a sentence. Document expected latency ranges in `README.md` for future regression spotting.

TDD order during implementation: unit tests for `_pick_voice` and `_parse_gender` first (truly testable in isolation), then the live integration test skeleton (runs against the real SDK, validates the end-to-end contract), then wire into `main.py`.

## Rollout / rollback

- **Feature-flag driven.** Flipping `STT_PROVIDER=speechmatics TTS_PROVIDER=speechmatics` in `.env` and restarting the backend reverts to the old pipeline. No code changes needed.
- **No DB migration.** SQLite schema unchanged.
- **No client changes required.** WebSocket message shapes (`transcript`, `translated_text`, `translated_text_partial`, binary audio frames) are preserved exactly.

## Open questions deferred to v2

- Chunk-level TTS streaming back to client (start audio playback before full sentence is synthesized).
- Cloning TTS backend (Personal Voice if approved, or swap-in ElevenLabs) — plug into `AzureTtsClient` interface without changing upstream.
- Pre-enrolled voice profiles (the existing `profiles.db` schema) wiring into Azure Personal Voice once access is granted.
- Multi-speaker diarization for meetings with more than one participant per session.

## Out of scope

- Anything not on Azure's catalog.
- Deleting MiniMax or Speechmatics code. They stay as fallbacks.
- Chrome extension changes. The extension already handles all the existing WS message shapes.
- Refactoring the provider selection into a registry/factory pattern. Two `if` branches in `main.py` is fine at this size; abstracting earlier is premature.
