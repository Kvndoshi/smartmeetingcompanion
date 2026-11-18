# Distill — Live Translation & Meeting Notes

Distill is a local-first meeting companion: a Chrome/Edge extension plus a FastAPI backend. It works with any meeting or video that plays in a browser tab: Google Meet, Microsoft Teams (web), Zoom (web client), Webex or YouTube. It can:

- **Translate live, both ways.** You hear every other participant in your language, whatever language each of them speaks (auto-detect). On Google Meet, the others can also hear *you* translated.
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
- Outgoing translation ("Translate my voice") is Meet-only. It intercepts Meet's `RTCPeerConnection` mic track and replaces it with the translated audio, or with your own voice while no translation is needed.
- The local SQLite store is the live record of each transcript. Supermemory is the long-term memory used for "all meetings" chat.

See [architecture.md](architecture.md) for the full design and protocol.

## Providers

Add a key for any provider and it becomes available. If you don't choose one, Distill picks the first configured provider in the order shown.

| Capability | Providers (default order) |
|---|---|
| Speech-to-text | **Soniox** (diarization + native translation + language auto-detect) → **Deepgram** (diarization + language auto-detect) → Speechmatics (native translation) → Azure Speech (translation, or `azure_diarize` for speakers) |
| Text-to-speech | Soniox → Azure Neural TTS → Deepgram → MiniMax → Speechmatics (preview, English only) |
| LLM (summaries, chat, text translation) | **Gemini** → **Groq** (both through their OpenAI-compatible APIs) |
| Text translation (for STT providers without native translation) | LLM → Azure Translator → MiniMax |
| Memory | **Supermemory** (one document per meeting, upserted) |

You can override the defaults with `STT_PROVIDER`, `TTS_PROVIDER`, `LLM_PROVIDER` and `TRANSLATION_PROVIDER` in `backend/.env`, or per session in the popup.

**Languages.**
- The 16 original languages: English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Hindi, Arabic, Russian, Dutch, Swedish, Polish and Turkish.
- Indian languages added: Gujarati, Bengali, Tamil, Telugu, Marathi, Urdu, Punjabi, Kannada and Malayalam.
- **Auto-detect** ("They speak: Auto-detect") needs Soniox or Deepgram. Soniox covers every language above. Deepgram's multilingual mode doesn't cover Urdu, Malayalam or Punjabi.
- Voices for the Indian languages come from Soniox, Azure or Deepgram. Deepgram has no Malayalam, Punjabi or Arabic voice, and MiniMax only covers the original 16.

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
2. Set **My language**: the language you speak and want to hear.
3. Turn on what you want. Each direction has its own colour-coded card:
   - 🎧 **What I hear** (blue): everyone else, translated into My language. **They speak** is **Auto-detect** by default, so each speaker's language is detected on the fly. You hear only the translated voice: the original voices are silent. Anyone already speaking your language is not translated, just read back in the same voice so nobody goes missing. Tick **Keep original voices quietly underneath** (off by default) to leave the real voices at low volume under the translation.
   - 🎤 **What they hear** (purple, Google Meet only): your voice, translated for everyone in the call. Pick **Others hear me in**, then press **Translate my voice**. **Auto — match the room** needs **What I hear** running in the same call (or a fixed **They speak** language); until Distill has heard which language the room speaks, the status says it is *not translating yet* and the others hear your own voice. This card has its own button, independent of Start. You can change the language while it runs. See [Two-way and multi-language calls](#two-way-and-multi-language-calls).
   - 📝 **Take notes** (green): get the transcript, summary and chat. Notes contain everything said in the meeting:
     - The other participants come from the tab audio.
     - You come from your microphone. **Include my microphone** is on by default, because the meeting tab never plays your own voice back.
     - The first time you press Start, a one-time "Allow microphone" page opens next to the meeting. Your voice joins the notes as soon as you allow it.
     - On Google Meet, the notes follow Meet's mute: nothing you say while muted, or before joining the call, is transcribed.
4. Optionally choose providers. Then press **Start**. The notes side panel opens with the live transcript.
5. The side panel has four tabs:
   - **Live**: the transcript. You can rename speakers and type your own notes. A small tag (e.g. `GU`) marks lines spoken in a language other than yours.
   - **Summary**: generate or regenerate the summary, pick its language, copy or download it as Markdown, and sync it to Supermemory.
   - **Ask**: chat about this meeting or all meetings.
   - **Meetings**: history, full-text search and delete.
6. **Stop & summarize** ends the meeting. The summary appears automatically if an LLM key is set.

On Google Meet, a floating widget shows the same three groups in compact form: My language, **What I hear** (with Start/Stop), **What they hear** (with **Translate my voice**), plus **Open notes panel**. Chrome only allows tab capture after you've clicked the toolbar icon on that tab, so if Start fails from the widget, start from the popup once.

**Audio routing.** Translated audio plays through the output device selected in the popup. The original meeting audio plays through the system default output. To feed translated audio into another app, use a virtual device such as BlackHole or VB-Cable.
- While **What I hear** is on and a translated voice is available, the original voices are silent from the first word: you hear only the translated voice. This is the same with a fixed **They speak** language and with **Auto-detect**.
- With **Auto-detect**, speech that is already in your language is read back by the same voice (not translated), a moment after it was said.
- **Keep original voices quietly underneath** (off by default) plays the originals at about 15% instead of silencing them.
- In notes-only mode, or when no translated voice is available (no TTS key or no translator), the meeting plays at full volume.

## Two-way and multi-language calls

**One rule shapes everything: each person in a Meet call sends one audio stream to everyone.** So your outgoing voice can be in only one language at a time, while what you *hear* can come from any number of languages.

**Everyone uses Distill (the universal mode, any number of languages).** Example: Asha speaks Hindi, Bhavin speaks Gujarati and Chris speaks English.
- Each person sets **My language** to their own language, and **They speak** to **Auto-detect**.
- Each person turns on **What I hear** and leaves **Translate my voice** off.
- Everyone talks normally. Each person's Distill detects who is speaking which language and translates it into that person's own language. Bhavin hears Asha and Chris in Gujarati, Asha hears both of them in Hindi, and Chris hears both in English.
- Nobody's outgoing voice is changed. That's why voice translation stays off: every listener translates for themselves.

**Only you use Distill.**
- **What I hear** with Auto-detect still translates everyone into your language.
- **What they hear** sends your voice in one language. Pick it, or choose **Auto — match the room**. Auto follows the language most of the room speaks, detected from the other participants' speech over the last few minutes. It waits for a clear majority and doesn't flip on one stray sentence. While the room speaks your language, the others hear your own voice.
- If two other people speak two different languages, one of them won't understand your translated voice. Ask them to install Distill, or pick the language most of them share.

**Use headphones** for two-way translation. Otherwise your microphone picks up the translated voices from your speakers.

## Testing

```bash
cd backend
uv run pytest -q                              # 148 tests, zero API keys needed (fakes + E2E dry run)
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

```bash
cd extension
npm test                                      # room-language estimator unit tests (Node 24, no extra deps)
```

See [TESTING.md](TESTING.md) for the Meet interceptor browser test page and the manual Chrome/Edge checklist.

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
  - `src/shared/`: protocol, API client, hooks and the room-language estimator.
  - `tests/`: unit tests and the interceptor browser test page.
- `web/`: legacy prototype, not part of the current setup.
