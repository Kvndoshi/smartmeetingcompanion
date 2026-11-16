# Testing Distill

## Automated (no keys needed)

```bash
cd backend
uv run pytest -q
```

```bash
cd extension
npm run build
```

- `pytest` runs 125 tests:
  - WebSocket contract tests with fake providers
  - Soniox and Deepgram stream parsers, plus the Azure clients
  - the LLM client
  - summarizer and chat
  - meeting store and Supermemory sync
  - settings
  - an end-to-end dry run
- `npm run build` runs a `tsc` type-check plus the vite build into `extension/dist`.

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

### 1. Meet widget and outgoing translation (Google Meet)
- [ ] **Failure path.** Open a fresh Meet tab without clicking the toolbar icon, then press **Start** in the widget.
  - It shows an error that tells you to start from the toolbar icon.
  - The button goes back to **Start**. It must not stay stuck on "Starting…".
- [ ] Click the toolbar icon once, then use the widget's **Start**. The status turns live and transcript lines appear in the widget.
- [ ] **Translate my voice.** Join the call with your mic **muted**, then turn it on. Either outcome is fine:
  - the widget explains that it needs the mic to be on, or
  - it starts and translates once you unmute.

  It must not claim to be translating while nothing is being sent.
- [ ] Unmute, then turn on **Translate my voice**. A second participant (a phone or another browser profile) hears the translated voice, not your original voice.
- [ ] While translating, mute and then unmute. Translation resumes.
- [ ] While translating, switch the mic in Meet's settings. Translation continues from the new mic.
- [ ] Turn **Translate my voice** off. The other participant hears your **real** voice again.
- [ ] **Stop & summarize** in the widget. The widget returns to idle and the side panel shows the meeting as ended.

### 2. Popup Start, side panel and microphone
- [ ] In the popup, choose **Take notes** and press **Start**.
  - The side panel opens straight away, on the **Live** tab.
  - Lines appear within a few seconds, with speaker colours.
- [ ] **Take notes only.** You can still hear the call audio.
- [ ] **Translate audio.** The original audio is replaced by the translated voice.
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
