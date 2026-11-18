# Testing Distill

## Automated (no keys needed)

```bash
cd backend
uv run pytest -q
```

```bash
cd extension
npm run build
npm test
```

- `pytest` runs 148 tests:
  - WebSocket contract tests with fake providers
  - Soniox and Deepgram stream parsers, plus the Azure clients
  - the LLM client
  - summarizer and chat
  - meeting store and Supermemory sync
  - settings
  - an end-to-end dry run
  - multilingual behaviour (`test_multilingual.py`):
    - auto-detect config for Soniox and Deepgram
    - language tags, same-language skip and echo drop
    - re-config on the same socket
    - the registry's auto-detect rules
    - migrating an old database
- `npm run build` runs a `tsc` type-check plus the vite build into `extension/dist`.
- `npm test` runs the room-language estimator tests with Node 24's built-in runner.

### Meet interceptor browser test page

This page exercises the real built interceptor against fake `RTCPeerConnection`s in Chrome: the mic swap, mute handling, and the own-voice mix used by "Auto — match the room".

```bash
cd extension
npm run build
node tests/interceptor-harness/prepare.mjs
```

```bash
cd extension/tests/interceptor-harness
python -m http.server 5181 --bind 127.0.0.1
```

Open `http://127.0.0.1:5181/` in Chrome and click **Run interceptor tests**. Every line should say PASS (75 checks, about a minute). The page plays Meet: it toggles the mic every way a call UI can (`replaceTrack(null)` / `replaceTrack(track)`, `track.enabled` through its own reference and through `sender.track`, `track.stop()` plus a fresh track), measures what the far end of a loopback call really hears, and forces pipeline failures (blocked worklet, context that will not run, a build that hangs) to check the call keeps the real mic.

## Live providers (needs keys in `backend/.env`)

```bash
cd backend
uv run python scripts/smoke_providers.py
```

```bash
cd backend
powershell -File scripts/make_test_meeting.ps1
```

```bash
cd backend
uv run uvicorn main:app --port 8000
```

```bash
cd backend
uv run python scripts/e2e_meeting.py
```

- **`smoke_providers.py`** prints a pass/skip/fail table, one row per provider that has a key.
- **`make_test_meeting.ps1`** generates `fixtures/meeting.wav` and `s2s_en.wav`. The WAVs are gitignored, so run it once per checkout.
- **The `uvicorn` command** starts the backend. Keep it running in another terminal while `e2e_meeting.py` runs.
- **`e2e_meeting.py`** checks the charter criteria: STT ≥ 85% · summary decisions and action items · chat ≥ 80% · EN→ES and EN→FR speech-to-speech. It writes a report to `backend/reports/`.

## Manual checklist (Chrome and Edge)

Setup:
1. Start the backend.
2. Load `extension/dist` unpacked.
3. Open the dashboard at `http://localhost:8000/` and check that your keys show as configured.

Tab capture needs a real click on the toolbar icon, so these steps can't be automated. The first two sections cover paths no automated test exercised, so do them first.

### 0. Two-way and multi-language translation (Google Meet, needs keys)
Use headphones on every machine. Each "participant" can be another browser profile or a phone.
- [ ] **Soniox probe.** With Soniox, My language English and They speak Auto-detect, have someone speak English, then Hindi.
  - You never hear either speaker's real voice, not even the first syllable.
  - English speech is read back in English by the translated voice, exactly once, with no translation line.
  - Hindi speech is translated, with an `HI` tag in the side panel.
  - Note what Soniox's one-way translation does with speech already in the target language. The backend must not speak it a second time.
- [ ] **Two people, both directions.** You (English) and a Hindi speaker; only you run Distill.
  - Turn on **What I hear**: you hear them in English.
  - Set **Others hear me in = Hindi** and press **Translate my voice**. They hear you in Hindi, not your original voice.
- [ ] **Live switch.** While translating your voice, change **Others hear me in** from Hindi to Gujarati.
  - Within a sentence or two they hear Gujarati.
  - The connection does not restart, and the status line updates.
- [ ] **Own voice.** With **What I hear** running and They speak = Auto-detect, set **Others hear me in** back to Auto with nobody speaking yet. The status (amber dot) says it is not translating yet and others hear your own voice, and they do hear you.
- [ ] **Auto with nothing to match.** Stop **What I hear**, set They speak = Auto-detect and Others hear me in = Auto, then press **Translate my voice**. It refuses with "Choose the language the others should hear you in…" and Meet's mic is untouched.
- [ ] **Three people (Hindi, Gujarati, English), everyone runs Distill.** Each person sets My language to their own language, What I hear to Auto-detect, and voice translation off.
  - Each person hears the other two in their own language.
  - Speakers already in your language are read back by the translated voice (you don't hear their real voice).
  - Chips and notes show the right language per line.
- [ ] **Auto — match the room.** Only you run Distill. The others speak mostly Hindi, so you're heard in Hindi.
  - One stray Gujarati sentence doesn't switch it.
  - When the room switches to Gujarati and keeps talking, your voice follows within about two minutes. That's how long Gujarati takes to reach a 60% share of the 3-minute window.
- [ ] **Speakers vs headphones.** Repeat the two-person test on laptop speakers. Expect some echo; the headphones hint is the mitigation.
- [ ] **Keep original voices quietly underneath** (off by default). With it off, you hear only the translated voice — no real voice before, under or after it. With it on, the original voices stay faintly audible under the translation.

### 1. Meet widget and outgoing translation (Google Meet)
- [ ] **Failure path.** Open a fresh Meet tab without clicking the toolbar icon, then press **Start** in the widget.
  - It shows an error that tells you to start from the toolbar icon.
  - The button goes back to **Start**. It must not stay stuck on "Starting…".
- [ ] Click the toolbar icon once, then use the widget's **Start**. The status turns live and transcript lines appear in the widget.
- [ ] **Translate my voice while muted.** Join the call with your mic **muted**, pick **Others hear me in**, then turn it on. It starts, Meet stays muted, and it translates once you unmute.
- [ ] **Meet's mic button keeps working (regression: it used to freeze).** With **Translate my voice** on, click Meet's mic button — and press Ctrl+D — at least five times in each direction, starting once from muted and once from unmuted.
  - The button changes state every time, and Meet's "you're muted" indicator follows.
  - While muted the other participant hears nothing (no translation, no real voice); after unmuting they hear the translation again.
  - Do the same with **Others hear me in = Auto** while the status says "not translating yet" (own voice).
  - If anything sticks, open DevTools on the Meet tab and copy the `[Interceptor]` console lines.
- [ ] Unmute, pick **Others hear me in**, then turn on **Translate my voice**. A second participant (a phone or another browser profile) hears the translated voice, not your original voice.
- [ ] While translating, mute and then unmute. Translation resumes.
- [ ] While translating, switch the mic in Meet's settings. Translation continues from the new mic.
- [ ] Turn **Translate my voice** off ("Stop — others hear my own voice"). The other participant hears your **real** voice again.
- [ ] The widget and the popup stay in sync: changing a language in one shows up in the other.
- [ ] **Stop & summarize** in the widget. The widget returns to idle and the side panel shows the meeting as ended.

### 2. Popup Start, side panel and microphone
- [ ] In the popup, choose **Take notes** and press **Start**.
  - The side panel opens straight away, on the **Live** tab.
  - Lines appear within a few seconds, with speaker colours.
- [ ] **Take notes only.** You can still hear the call audio.
- [ ] **What I hear.** The original audio is silent from the start; you hear only the translated voice (or, with **Keep original voices quietly underneath** ticked, the originals faintly under it).
  - The translation line appears under each transcript line.
  - With no TTS key, the original audio stays audible and a warning shows.
- [ ] **Your microphone (on by default).** On a fresh install, press **Start** with **Take notes** on.
  - The "Allow microphone" page opens next to the meeting. The other participants are already being transcribed.
  - Press **Allow microphone**. The page closes itself and focus returns to the meeting.
  - Without restarting, your lines appear as **You**, interleaved with the other speakers.
- [ ] **Meet mute.** While taking notes on Meet:
  - Mute yourself in Meet and keep talking. No new **You** lines appear.
  - Unmute. Your lines resume.
- [ ] **Microphone blocked.** Block the microphone for the extension, then Start.
  - The notes still capture the other participants.
  - A warning explains how to allow the microphone, instead of an error.
- [ ] **Service worker restart.** Mid-meeting:
  - Open `chrome://serviceworker-internals` (or `edge://serviceworker-internals`), find Distill and press **Stop**.
  - Within a few seconds, new lines keep arriving in the **same** meeting.
- [ ] Close and reopen the side panel mid-meeting. It reloads the transcript and keeps following live.
- [ ] **Stop & summarize.** The Summary tab shows "Summarizing…", then the summary. This needs a Gemini or Groq key.

### 3. Other platforms
- [ ] **Teams web** (`teams.microsoft.com` or `teams.live.com`) or **Zoom web**:
  - Notes and translation work from the popup.
  - The meeting appears in the list with the right platform.
- [ ] **YouTube video**: notes and translation work, and the Memories tab finds it after sync.
- [ ] **Edge**: repeat section 2. Check that the side panel opens.

### 4. Side panel features
These were already click-tested against a demo backend; re-check them with real data.
- [ ] **Live**:
  - Rename a speaker. The name sticks after a reload.
  - Type in **My notes**, switch meetings and come back. The notes are saved to the right meeting.
- [ ] **Summary**:
  - Change the language, then press **Regenerate**.
  - **Copy Markdown** and **Download .md** both work.
  - **Sync now** shows "Synced" with a Supermemory key, or "kept locally" without one.
- [ ] **Ask**:
  - In **This meeting**, ask for the action items. The answer streams and cites sources.
  - In **All meetings**, ask about an earlier meeting. Clicking a source chip opens that meeting.
- [ ] **Meetings**:
  - Search finds a word from a transcript.
  - Delete needs two clicks, and is disabled for the live meeting.
