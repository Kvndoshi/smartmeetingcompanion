// ── Distill service worker ──
// Orchestrates popup / side panel / Meet widget ↔ offscreen capture ↔ backend WebSockets.
//
// Sockets (all to /ws/translate, see backend/services/session.py):
//   tab       tab audio (other participants): "What I hear" translation and/or notes.
//             They speak "auto" → the backend detects each speaker's language.
//   mic       your microphone (notes mode, offscreen getUserMedia) → same meeting
//   outgoing  Meet-only "What they hear": your voice translated and injected into
//             the call. One language at a time (a participant sends one stream);
//             "auto" follows the language the others speak (shared/roomLanguage.ts).
//
// State is mirrored to chrome.storage.session so a restarted service worker can
// reconnect to the same meeting (the offscreen document keeps capturing).

import { BACKEND_WS_URL } from "./shared/config";
import {
  INITIAL_STATE,
  type BackendConfig,
  type BackgroundRequest,
  type BackgroundResponse,
  type OffscreenRequest,
  type ServerMessage,
  type SessionState,
  type StartCaptureRequest,
  type UiMessage,
} from "./shared/protocol";
import { emptyRoom, observeRoom, type RoomState } from "./shared/roomLanguage";
import { AUTO, sameLanguage } from "./utils/languages";

const STATE_KEY = "distill-session";
const MAX_PENDING_BYTES = 16000 * 2 * 15; // ≤ 15 s of audio buffered before the backend acks
const PING_INTERVAL_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_RECONNECTS = 8;

let state: SessionState = structuredClone(INITIAL_STATE);

// ── Backend socket ───────────────────────────────────────────────────

interface SessionHandlers {
  onMessage(msg: ServerMessage, session: BackendSession): void;
  onAudio?(buf: ArrayBuffer): void;
  onUnexpectedClose(session: BackendSession): void;
}

class BackendSession {
  ws: WebSocket | null = null;
  ready = false;
  meetingId: string | null = null;
  private closedByUs = false;
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private waiters: { kinds: string[]; resolve: (m: ServerMessage | null) => void }[] = [];

  constructor(
    readonly label: string,
    private readonly buildConfig: () => Promise<BackendConfig>,
    private readonly handlers: SessionHandlers
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUs = false;
    this.ready = false;
    const ws = new WebSocket(BACKEND_WS_URL);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = async () => {
      if (this.ws !== ws) return;
      try {
        const config = await this.buildConfig();
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(config));
      } catch (err) {
        console.error(`[BG:${this.label}] could not build config`, err);
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof event.data !== "string") {
        this.handlers.onAudio?.(event.data as ArrayBuffer);
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "session") {
        this.ready = true;
        this.meetingId = msg.meeting_id;
        this.flushPending();
      } else if (msg.type === "error" && !this.ready) {
        this.dropPending(); // config failed: no `session` will come
      }
      this.resolveWaiters(msg);
      this.handlers.onMessage(msg, this);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearPing();
      this.resolveWaiters(null);
      if (!this.closedByUs) this.handlers.onUnexpectedClose(this);
    };
  }

  sendAudio(buf: ArrayBuffer): void {
    if (this.ready && this.isOpen) {
      this.ws!.send(buf);
      return;
    }
    this.pending.push(buf);
    this.pendingBytes += buf.byteLength;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length) {
      this.pendingBytes -= this.pending.shift()!.byteLength;
    }
  }

  sendJson(payload: object): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(payload));
  }

  /**
   * Re-send a freshly built config on the open socket (e.g. a new target
   * language). Audio is buffered until the backend acks with `session` again.
   */
  async reconfigure(): Promise<void> {
    if (!this.isOpen) {
      this.connect();
      return;
    }
    const ws = this.ws!;
    this.ready = false;
    try {
      const config = await this.buildConfig();
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(config));
    } catch (err) {
      console.error(`[BG:${this.label}] could not rebuild config`, err);
    }
  }

  waitFor(kinds: string[], timeoutMs: number): Promise<ServerMessage | null> {
    return new Promise((resolve) => {
      const waiter = { kinds, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  /** Graceful stop: lets the backend flush final words (and end the meeting) before closing. */
  async stop(endMeeting: boolean): Promise<void> {
    this.closedByUs = true;
    if (this.isOpen && this.ready) {
      const wait = this.waitFor(endMeeting && this.meetingId ? ["meeting_ended"] : ["stopped"], STOP_TIMEOUT_MS);
      this.sendJson({ type: "stop", end_meeting: endMeeting });
      await wait;
    }
    this.close();
  }

  close(): void {
    this.closedByUs = true;
    this.dropPending();
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.resolveWaiters(null);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  private flushPending(): void {
    if (!this.isOpen) return;
    for (const buf of this.pending) this.ws!.send(buf);
    this.dropPending();
  }

  private dropPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private resolveWaiters(msg: ServerMessage | null): void {
    const remaining: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (msg === null || w.kinds.includes(msg.type)) w.resolve(msg);
      else remaining.push(w);
    }
    this.waiters = remaining;
  }
}

let tabSession: BackendSession | null = null;
let micSession: BackendSession | null = null;
let outgoingSession: BackendSession | null = null;
// "What they hear": I speak `myLang`; others hear `speakLang` ("auto" = match the room).
let outgoing: { tabId: number; myLang: string; speakLang: string } | null = null;
let room: RoomState = emptyRoom();
let micPort: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let captureEverReady = false; // did the backend ever accept this capture's config?
let captureGen = 0; // bumps on every start/stop so a stale start can't resurrect a stopped capture

// ── State + broadcasting ─────────────────────────────────────────────

function persist(): void {
  void chrome.storage.session.set({ [STATE_KEY]: state }).catch(() => {});
}

type TabIds = (number | null | undefined)[];

/** Send to extension pages, plus content scripts in the captured / outgoing tab and any `extraTabs`. */
function broadcast(msg: UiMessage, extraTabs: TabIds = []): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
  const tabIds = new Set<number>();
  for (const id of [state.tabId, outgoing?.tabId, ...extraTabs]) if (typeof id === "number") tabIds.add(id);
  for (const id of tabIds) chrome.tabs.sendMessage(id, msg).catch(() => {});
}

function setState(patch: Partial<SessionState>, extraTabs: TabIds = []): void {
  // A patch that clears tabId (stop / failed start) must still reach that tab's widget.
  const previousTabId = state.tabId;
  state = { ...state, ...patch };
  persist();
  broadcast({ target: "ui", type: "state", state }, [previousTabId, ...extraTabs]);
}

function reportError(channel: "capture" | "mic" | "outgoing", message: string, code?: string, extraTabs: TabIds = []): void {
  console.warn(`[BG] ${channel} error:`, message);
  if (channel === "capture") state.lastError = message;
  broadcast({ target: "ui", type: "error", channel, message, code }, extraTabs);
}

let restorePromise: Promise<void> | null = null;

/** After a service-worker restart, pick the live meeting back up (lazily, on first use). */
function ensureRestored(): Promise<void> {
  if (!restorePromise) {
    restorePromise = (async () => {
      const saved = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as SessionState | undefined;
      if (!saved) return;
      state = { ...structuredClone(INITIAL_STATE), ...saved, isMicTranslating: false, outgoingStatus: "idle", outgoingLang: null };
      if (saved.isMicTranslating) {
        // The Meet page lost its link to us and went back to your own voice.
        persist();
        broadcast({ target: "ui", type: "warning", message: "Voice translation stopped — turn “Translate my voice” on again." });
      }
      if (!state.isCapturing || tabSession) return;
      if (!(await hasOffscreenDocument())) {
        state = { ...state, isCapturing: false, status: "idle", captureStartedAt: null, micStatus: "idle" };
        persist();
        return;
      }
      console.log("[BG] Restoring live session for meeting", state.meetingId);
      openTabSession();
      if (state.includeMic && state.modes.notes && state.meetingId) void startNotesMic();
    })().catch((err) => console.error("[BG] restore failed", err));
  }
  return restorePromise;
}

// ── Offscreen document ───────────────────────────────────────────────

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capturing meeting audio for live transcription and translation",
  });
}

async function removeOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function sendToOffscreen(message: OffscreenRequest, retries = 12, retryDelayMs = 80): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const notReady = text.includes("Receiving end does not exist") || text.includes("Could not establish connection");
      if (!notReady || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

function toArrayBuffer(data: number[]): ArrayBuffer {
  return new Uint8Array(data).buffer;
}

// ── Tab socket ───────────────────────────────────────────────────────

async function tabInfo(tabId: number | null): Promise<{ url?: string; title?: string }> {
  if (!tabId) return {};
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title };
  } catch {
    return {};
  }
}

function openTabSession(): void {
  tabSession?.close();
  tabSession = new BackendSession(
    "tab",
    async () => {
      const info = await tabInfo(state.tabId);
      return {
        type: "config",
        source_lang: state.sourceLang,
        target_lang: state.targetLang,
        mode: { translate: state.modes.translate, transcribe: state.modes.notes },
        source: "tab",
        meeting_id: state.meetingId, // set on reconnect → backend appends to the same meeting
        ...(info.url ? { tab_url: info.url } : {}),
        ...(info.title ? { tab_title: info.title } : {}),
        ...(state.sttProvider ? { stt_provider: state.sttProvider } : {}),
        ...(state.ttsProvider ? { tts_provider: state.ttsProvider } : {}),
      };
    },
    {
      onMessage: handleTabMessage,
      onAudio: (buf) => {
        if (!state.modes.translate) return;
        void sendToOffscreen({ type: "translated-audio", target: "offscreen", data: Array.from(new Uint8Array(buf)) }).catch(() => {});
      },
      onUnexpectedClose: () => scheduleReconnect(),
    }
  );
  tabSession.connect();
}

// What the backend accepted for the current tab session (null until the ack).
let tabAck: { translate: boolean; tts: string | null } | null = null;

// ── Hearing the original voices (tabCapture mutes the tab) ──────────
//
// Translating: voices sit quietly under their translation ("quiet") or are
// silent ("muted"). With They speak = Auto, someone already speaking your
// language is heard at full volume and isn't translated at all — the volume
// drops only while foreign speech is detected (and while translation plays,
// which the offscreen document handles itself).
const QUIET_LEVEL = 0.15;
const FOREIGN_HOLD_MS = 2500;
let foreignSpeechUntil = 0;
let foreignTimer: ReturnType<typeof setTimeout> | null = null;
let sentOriginalLevel: number | null = null;

function duckLevel(): number {
  return state.originalAudio === "muted" ? 0 : QUIET_LEVEL;
}

function originalLevel(): number {
  if (!state.modes.translate) return 1;
  if (tabAck && (!tabAck.translate || !tabAck.tts)) return 1; // no translated voice will play
  if (state.sourceLang !== AUTO) return duckLevel();
  return Date.now() < foreignSpeechUntil ? duckLevel() : 1;
}

/** Runs on the ack, once capture is live, and whenever detected languages change. */
function syncOriginalLevel(): void {
  if (!state.isCapturing) return;
  const level = originalLevel();
  if (level === sentOriginalLevel) return;
  sentOriginalLevel = level;
  void sendToOffscreen({ type: "set-original-level", target: "offscreen", level, duckLevel: duckLevel() }).catch(() => {});
}

/** Auto mode: a tab transcript (partial or final) told us which language is being spoken. */
function noteSpokenLanguage(language: string | null | undefined): void {
  if (!language || state.sourceLang !== AUTO || !state.modes.translate) return;
  if (sameLanguage(language, state.targetLang)) {
    foreignSpeechUntil = 0;
  } else {
    foreignSpeechUntil = Date.now() + FOREIGN_HOLD_MS;
    if (foreignTimer) clearTimeout(foreignTimer);
    foreignTimer = setTimeout(syncOriginalLevel, FOREIGN_HOLD_MS + 50);
  }
  syncOriginalLevel();
}

/** Auto "Others hear me in": learn which language the other participants speak. */
function noteRoomSegment(language: string | null | undefined, text: string): void {
  const next = observeRoom(room, { lang: language, text, t: Date.now() }, state.targetLang);
  const changed = next.current !== room.current;
  room = next;
  if (!changed) return;
  setState({ roomLang: room.current });
  applyOutgoingTarget();
}

function handleTabMessage(msg: ServerMessage, session: BackendSession): void {
  switch (msg.type) {
    case "session":
      reconnectAttempts = 0;
      captureEverReady = true;
      setState({
        status: state.isCapturing ? "capturing" : state.status,
        meetingId: msg.meeting_id,
        meetingTitle: msg.meeting_title,
        lastError: null,
        activeProviders: { stt: msg.stt_provider, tts: msg.tts_provider, translator: msg.translator, diarization: msg.diarization },
      });
      if (state.includeMic && state.modes.notes && !micSession && !state.isMicTranslating) void startNotesMic();
      tabAck = { translate: msg.translate, tts: msg.tts_provider };
      syncOriginalLevel();
      syncOutgoingMeeting();
      break;
    case "transcript":
      noteSpokenLanguage(msg.language);
      if (msg.is_final) noteRoomSegment(msg.language, msg.text);
      broadcast({
        target: "ui",
        type: "transcript",
        source: msg.source,
        text: msg.text,
        isFinal: msg.is_final,
        speaker: msg.speaker,
        language: msg.language ?? null,
        segmentId: msg.segment_id,
        startMs: msg.start_ms,
        meetingId: state.meetingId,
      });
      break;
    case "translated_text_partial":
    case "translated_text":
      broadcast({
        target: "ui",
        type: "translation",
        source: msg.source,
        text: msg.text,
        isFinal: msg.type === "translated_text",
        speaker: msg.speaker,
        language: msg.language ?? null,
        segmentId: msg.type === "translated_text" ? msg.segment_id : undefined,
        meetingId: state.meetingId,
      });
      break;
    case "status":
      setState({ status: "reconnecting" });
      break;
    case "warning":
      broadcast({ target: "ui", type: "warning", message: msg.message });
      break;
    case "meeting_ended":
      if (msg.meeting_id) broadcast({ target: "ui", type: "meeting-ended", meetingId: msg.meeting_id });
      break;
    case "error":
      reportError("capture", msg.message, msg.code);
      if (!session.ready) {
        // The backend refused the configuration (missing key, unsupported language…).
        void stopCapture(false, msg.message);
      }
      break;
  }
}

function scheduleReconnect(): void {
  if (!state.isCapturing && state.status !== "connecting") return;
  if (!captureEverReady && reconnectAttempts >= 1) {
    const message = "Can't reach the Distill backend at localhost:8000 — start it with: uv run uvicorn main:app --port 8000";
    reportError("capture", message);
    void stopCapture(false, message);
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECTS) {
    reportError("capture", "Lost connection to the Distill backend. Is it still running?");
    void stopCapture(false, "Backend connection lost");
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15_000);
  reconnectAttempts++;
  setState({ status: "reconnecting" });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!state.isCapturing && state.status !== "connecting") return;
    openTabSession();
    if (micSession && !micSession.isOpen) micSession.connect();
  }, delay);
}

// ── Your microphone in the notes (offscreen getUserMedia) ───────────

// Meeting notes hold what was said in the meeting. On Meet the interceptor
// reports whether your voice is actually reaching the call (false while muted
// or before joining); unknown tabs / platforms keep transcribing you.
const voiceInCall = new Map<number, boolean | null>();

function isMutedInMeeting(): boolean {
  return state.tabId !== null && voiceInCall.get(state.tabId) === false;
}

function refreshVoiceInCall(tabId: number | null): void {
  if (tabId === null) return;
  chrome.tabs
    .sendMessage(tabId, { type: "get-meet-mic-state" })
    .then((res: { live?: boolean | null } | undefined) => {
      if (res && "live" in res) voiceInCall.set(tabId, typeof res.live === "boolean" ? res.live : null);
    })
    .catch(() => {}); // not a Meet tab (no bridge) → stays unknown
}

const MIC_NOT_ALLOWED =
  "Your microphone isn't allowed yet, so only the other participants are in the notes. Open Distill and click Allow next to “Include my microphone”.";

async function startNotesMic(): Promise<void> {
  if (micSession || !state.meetingId) return;
  refreshVoiceInCall(state.tabId);
  setState({ micStatus: "starting" });
  micSession = new BackendSession(
    "mic",
    async () => ({
      type: "config",
      // Your own voice: you speak your language, whatever the others speak.
      source_lang: state.targetLang,
      target_lang: state.targetLang,
      mode: { translate: false, transcribe: true },
      source: "mic",
      meeting_id: state.meetingId,
      ...(state.sttProvider ? { stt_provider: state.sttProvider } : {}),
    }),
    {
      onMessage: (msg, session) => {
        if (msg.type === "session") setState({ micStatus: "on" });
        else if (msg.type === "transcript")
          broadcast({
            target: "ui",
            type: "transcript",
            source: "mic",
            text: msg.text,
            isFinal: msg.is_final,
            speaker: "me",
            language: msg.language ?? null,
            segmentId: msg.segment_id,
            startMs: msg.start_ms,
            meetingId: state.meetingId,
          });
        else if (msg.type === "error") {
          reportError("mic", msg.message, msg.code);
          if (!session.ready) void stopNotesMic("error");
        }
      },
      onUnexpectedClose: (session) => {
        if (state.isCapturing && micSession === session) setTimeout(() => micSession === session && session.connect(), 2000);
      },
    }
  );
  micSession.connect();
  try {
    const res = await sendToOffscreen({ type: "start-mic-capture", target: "offscreen" });
    if (!res?.success) throw new Error(res?.error || "Microphone unavailable");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Capture of everyone else carries on; once access is granted the mic joins automatically.
    if (/permission|notallowed/i.test(message)) broadcast({ target: "ui", type: "warning", message: MIC_NOT_ALLOWED });
    else reportError("mic", `Microphone: ${message}`);
    await stopNotesMic("error");
  }
}

// Mic access granted from the permissions page mid-meeting → add your voice now.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes.micPermission?.newValue !== "granted") return;
  void ensureRestored().then(() => {
    if (state.isCapturing && state.includeMic && state.modes.notes && !micSession && !state.isMicTranslating) void startNotesMic();
  });
});

async function stopNotesMic(status: "idle" | "error" = "idle"): Promise<void> {
  const session = micSession;
  micSession = null;
  await sendToOffscreen({ type: "stop-mic-capture", target: "offscreen" }).catch(() => {});
  if (session) await session.stop(false);
  setState({ micStatus: status });
}

// ── Capture start / stop ─────────────────────────────────────────────

function isCapturableTabUrl(url?: string): boolean {
  if (!url) return true; // unknown → let tabCapture decide
  const lower = url.toLowerCase();
  return !["chrome://", "chrome-extension://", "edge://", "devtools://", "about:"].some((p) => lower.startsWith(p));
}

async function resolveCaptureTabId(requestedTabId?: number, senderTabId?: number): Promise<number | null> {
  for (const id of [requestedTabId, senderTabId]) {
    if (typeof id !== "number") continue;
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.id && isCapturableTabUrl(tab.url)) return tab.id;
    } catch {
      /* try the next strategy */
    }
  }
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id && isCapturableTabUrl(focused.url)) return focused.id;
  const active = (await chrome.tabs.query({ active: true })).find((t) => t.id && isCapturableTabUrl(t.url));
  return active?.id ?? null;
}

function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!id) reject(new Error("Failed to get a tab capture stream"));
      else resolve(id);
    });
  });
}

async function startCapture(req: StartCaptureRequest, senderTabId?: number): Promise<void> {
  await ensureRestored();
  if (state.isCapturing || tabSession) await stopCapture(true);

  const modes = req.modes ?? { translate: true, notes: true };
  if (!modes.translate && !modes.notes) throw new Error("Choose Translate audio and/or Take notes");
  const tabId = await resolveCaptureTabId(req.tabId, senderTabId);
  if (!tabId) throw new Error("No capturable tab found — open the meeting tab first");
  const info = await tabInfo(tabId);
  const gen = ++captureGen;

  room = emptyRoom();
  foreignSpeechUntil = 0;
  sentOriginalLevel = null;
  setState({
    sourceLang: req.sourceLang || AUTO,
    targetLang: req.targetLang,
    originalAudio: req.originalAudio === "muted" ? "muted" : "quiet",
    roomLang: null,
    modes,
    includeMic: !!req.includeMic && modes.notes,
    sttProvider: req.sttProvider || null,
    ttsProvider: req.ttsProvider || null,
    tabId,
    tabTitle: info.title ?? null,
    meetingId: null,
    meetingTitle: null,
    status: "connecting",
    micStatus: "idle",
    lastError: null,
    activeProviders: { stt: null, tts: null, translator: null, diarization: false },
  });

  try {
    await ensureOffscreenDocument();
    const streamId = await getMediaStreamId(tabId);
    reconnectAttempts = 0;
    captureEverReady = false;
    tabAck = null;
    openTabSession(); // audio is buffered until the backend acks the config
    sentOriginalLevel = originalLevel();
    const res = await sendToOffscreen({
      type: "start-capture",
      target: "offscreen",
      streamId,
      outputDeviceId: state.outputDeviceId,
      // tabCapture mutes the tab: full volume when only taking notes, see originalLevel().
      originalLevel: sentOriginalLevel,
      duckLevel: duckLevel(),
    });
    if (!res?.success) throw new Error(res?.error || "Tab capture failed");
    if (gen !== captureGen) throw new Error(state.lastError || "Capture was stopped while starting");
  } catch (err) {
    if (gen !== captureGen) throw err; // stopCapture already cleaned up
    tabSession?.close();
    tabSession = null;
    await removeOffscreenDocument();
    setState({ status: "error", isCapturing: false, tabId: null, lastError: (err as Error).message });
    throw err;
  }
  setState({
    isCapturing: true,
    captureStartedAt: Date.now(),
    status: tabSession?.ready ? "capturing" : "connecting", // the session ack may already have arrived
  });
  syncOriginalLevel();
  syncOutgoingMeeting();
  applyOutgoingTarget(); // a fixed "They speak" now defines what "auto" voice translation targets
}

async function stopCapture(endMeeting = true, error?: string): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  // Mark stopped first so nothing below reconnects or restarts the notes mic.
  captureGen++;
  state.isCapturing = false;
  await sendToOffscreen({ type: "stop-capture", target: "offscreen" }).catch(() => {});
  const mic = micSession;
  const tab = tabSession;
  micSession = null;
  tabSession = null;
  if (mic) await mic.stop(false); // mic finals land before the meeting is summarised
  // Same for "Translate my voice": its socket transcribes you into this meeting.
  if (state.isMicTranslating && outgoing?.tabId === state.tabId) await stopMicTranslation();
  if (tab) await tab.stop(endMeeting);
  await removeOffscreenDocument();
  room = emptyRoom();
  if (foreignTimer) clearTimeout(foreignTimer);
  foreignTimer = null;
  setState({
    isCapturing: false,
    status: error ? "error" : "idle",
    captureStartedAt: null,
    micStatus: "idle",
    tabId: null,
    roomLang: null,
    lastError: error ?? null,
  });
  applyOutgoingTarget(); // voice translation in another tab: no room to follow any more
}

// ── Meet outgoing translation (your voice → other participants) ─────

async function waitForMeetingId(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!state.meetingId && state.status === "connecting" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return state.meetingId;
}

const MEET_URL = /^https:\/\/meet\.google\.com\//i;

/**
 * Language the others hear me in right now; null = my own voice.
 * "auto" follows the room: a fixed "They speak" language when one is set,
 * otherwise the language detected in the other participants' speech.
 */
function effectiveSpeakLang(): string | null {
  if (!outgoing) return null;
  let lang: string | null = outgoing.speakLang;
  if (lang === AUTO) {
    const listening = state.isCapturing && state.tabId === outgoing.tabId;
    lang = !listening ? null : state.sourceLang !== AUTO ? state.sourceLang : room.current;
  }
  return lang && !sameLanguage(lang, outgoing.myLang) ? lang : null;
}

/** Tell the Meet page whether the call gets your real voice (own voice) or only the translation. */
function sendVoiceMix(): void {
  if (!outgoing) return;
  void chrome.tabs.sendMessage(outgoing.tabId, { type: "mic-interceptor-mix", mic: state.outgoingLang === null }).catch(() => {});
}

/** Re-target voice translation (new choice, room changed, capture started/stopped). */
function applyOutgoingTarget(): void {
  if (!outgoing || !outgoingSession) return;
  const lang = effectiveSpeakLang();
  if (lang === state.outgoingLang) return;
  setState({ outgoingLang: lang });
  sendVoiceMix();
  void outgoingSession.reconfigure(); // same socket; the backend switches language (or to transcribe-only)
}

async function startMicTranslation(
  myLang: string,
  speakLang: string,
  requestedTabId?: number,
  senderTabId?: number
): Promise<void> {
  await ensureRestored();
  if (outgoingSession) await stopMicTranslation();
  // The widget lives in the Meet tab that asked; the popup names its tab.
  const tabId = requestedTabId ?? senderTabId ?? state.tabId ?? (await resolveCaptureTabId());
  if (!tabId) throw new Error("Open your Google Meet call first");
  const url = (await tabInfo(tabId)).url;
  if (url && !MEET_URL.test(url)) throw new Error("“Translate my voice” works in Google Meet — open your Meet call tab first");
  outgoing = { tabId, myLang, speakLang: speakLang || AUTO };
  if (micSession) await stopNotesMic(); // the outgoing socket transcribes your voice instead
  setState({ isMicTranslating: true, outgoingStatus: "starting", speakLang: outgoing.speakLang, outgoingLang: effectiveSpeakLang() });

  const mine = outgoing;
  outgoingSession = new BackendSession(
    "outgoing",
    async () => {
      const notes = state.isCapturing && state.modes.notes && state.tabId === tabId;
      const meetingId = notes ? await waitForMeetingId(5000) : null;
      const info = await tabInfo(tabId);
      // You speak your language; others hear `outgoingLang`. Own voice → target = your
      // language, which the backend treats as transcribe-only (no translation, no TTS).
      return {
        type: "config",
        source_lang: mine.myLang,
        target_lang: (outgoing === mine ? state.outgoingLang : null) ?? mine.myLang,
        mode: { translate: true, transcribe: !!meetingId },
        source: "mic",
        meeting_id: meetingId,
        ...(info.url ? { tab_url: info.url } : {}),
        ...(info.title ? { tab_title: info.title } : {}),
        ...(state.sttProvider ? { stt_provider: state.sttProvider } : {}),
        ...(state.ttsProvider ? { tts_provider: state.ttsProvider } : {}),
      };
    },
    {
      onMessage: (msg, session) => {
        if (msg.type === "transcript")
          broadcast({ target: "ui", type: "transcript", source: "mic", text: msg.text, isFinal: msg.is_final, speaker: "me", language: msg.language ?? null, segmentId: msg.segment_id, startMs: msg.start_ms, meetingId: msg.segment_id ? state.meetingId : null });
        else if (msg.type === "translated_text_partial" || msg.type === "translated_text")
          broadcast({ target: "ui", type: "translation", source: "mic", text: msg.text, isFinal: msg.type === "translated_text", speaker: "me", language: msg.language ?? null, segmentId: msg.type === "translated_text" ? msg.segment_id : undefined, meetingId: state.meetingId });
        else if (msg.type === "warning") broadcast({ target: "ui", type: "warning", message: `Your voice: ${msg.message}` });
        else if (msg.type === "error") {
          reportError("outgoing", `Your voice: ${msg.message}`, msg.code);
          if (!session.ready) void stopMicTranslation("error");
        }
      },
      onAudio: (buf) => micPort?.postMessage({ type: "mic-translated-audio", data: Array.from(new Uint8Array(buf)) }),
      onUnexpectedClose: (session) => {
        if (outgoingSession === session) setTimeout(() => outgoingSession === session && session.connect(), 2000);
      },
    }
  );
  outgoingSession.connect();
  sendVoiceMix(); // the interceptor keeps it and applies it when its pipeline is built

  try {
    await chrome.tabs.sendMessage(tabId, { type: "mic-interceptor-activate" });
  } catch {
    await stopMicTranslation("error");
    throw new Error("Couldn't reach the Meet page — reload the Google Meet tab and try again");
  }
}

function setSpeakLanguage(speakLang: string): void {
  const value = speakLang || AUTO;
  if (outgoing) outgoing.speakLang = value;
  setState({ speakLang: value });
  applyOutgoingTarget();
}

/**
 * "Translate my voice" turned on before notes started: its socket was opened
 * without a meeting, and the notes mic stays off while it runs — so your words
 * would be missing from the notes. Reconnect it so the config carries the
 * meeting. Runs on the ack and once capture is live, whichever comes last.
 */
let refreshingOutgoing = false;
function syncOutgoingMeeting(): void {
  const session = outgoingSession;
  if (!session || refreshingOutgoing || !state.isCapturing || !state.modes.notes || !state.meetingId) return;
  if (outgoing?.tabId !== state.tabId || session.meetingId === state.meetingId) return;
  refreshingOutgoing = true;
  void (async () => {
    try {
      await session.stop(false);
      if (outgoingSession === session) session.connect();
    } finally {
      refreshingOutgoing = false;
    }
  })();
}

async function stopMicTranslation(status: "idle" | "error" = "idle"): Promise<void> {
  const tabId = outgoing?.tabId;
  const session = outgoingSession;
  const port = micPort;
  outgoingSession = null;
  outgoing = null;
  micPort = null;
  if (tabId) chrome.tabs.sendMessage(tabId, { type: "mic-interceptor-deactivate" }).catch(() => {});
  try {
    port?.disconnect();
  } catch {
    /* already gone */
  }
  if (session) await session.stop(false);
  setState({ isMicTranslating: false, outgoingStatus: status, outgoingLang: null }, [tabId]); // `outgoing` is already cleared
  if (state.isCapturing && state.includeMic && state.modes.notes && !micSession) void startNotesMic();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mic-capture") return;
  micPort = port;
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "mic-audio-data" || !Array.isArray(msg.data) || !outgoingSession) return;
    // Own voice and no notes: nothing to translate or transcribe — don't stream it.
    if (state.outgoingLang === null && !outgoingSession.meetingId) return;
    outgoingSession.sendAudio(toArrayBuffer(msg.data));
  });
  port.onDisconnect.addListener(() => {
    if (micPort !== port) return; // an older port from a previous activation
    micPort = null;
    if (state.isMicTranslating) void stopMicTranslation();
  });
});

// ── Messages ─────────────────────────────────────────────────────────

async function handle(message: BackgroundRequest | Record<string, any>, sender: chrome.runtime.MessageSender): Promise<BackgroundResponse | undefined> {
  switch (message.type) {
    case "audio-data":
      await ensureRestored();
      tabSession?.sendAudio(toArrayBuffer(message.data));
      return undefined;
    case "mic-audio-data":
      if (!micSession) return undefined;
      if (state.tabId !== null && !voiceInCall.has(state.tabId)) {
        voiceInCall.set(state.tabId, null); // ask once (e.g. after a service-worker restart)
        refreshVoiceInCall(state.tabId);
      }
      // Muted in Meet: what you say isn't part of the meeting — send silence, keep the stream alive.
      micSession.sendAudio(isMutedInMeeting() ? new ArrayBuffer(message.data.length) : toArrayBuffer(message.data));
      return undefined;
    case "meet-mic-state":
      if (typeof sender.tab?.id === "number") voiceInCall.set(sender.tab.id, typeof message.live === "boolean" ? message.live : null);
      return undefined;
    case "start-capture":
      try {
        await startCapture(message as StartCaptureRequest, sender.tab?.id);
      } catch (err) {
        // The popup may already be closed (e.g. it opened the side panel), so tell every UI.
        reportError("capture", (err as Error).message, undefined, [sender.tab?.id, (message as StartCaptureRequest).tabId]);
        throw err;
      }
      return { success: true, state };
    case "stop-capture":
      await ensureRestored();
      await stopCapture(message.endMeeting ?? true);
      return { success: true, state };
    case "get-state":
      await ensureRestored();
      return { success: true, state };
    case "set-output-device":
      setState({ outputDeviceId: message.deviceId || null });
      if (await hasOffscreenDocument())
        await sendToOffscreen({ type: "set-output-device", target: "offscreen", deviceId: message.deviceId || null }).catch(() => {});
      return { success: true };
    case "start-mic-translation":
      try {
        await startMicTranslation(message.myLang, message.speakLang, message.tabId, sender.tab?.id);
      } catch (err) {
        reportError("outgoing", (err as Error).message, undefined, [sender.tab?.id, message.tabId]);
        throw err;
      }
      return { success: true, state };
    case "set-speak-language":
      await ensureRestored();
      setSpeakLanguage(message.speakLang);
      return { success: true, state };
    case "stop-mic-translation":
      await stopMicTranslation();
      return { success: true, state };
    case "outgoing-status":
      if (!outgoingSession) return undefined;
      if (message.ok) {
        setState({ outgoingStatus: "on" });
        sendVoiceMix();
      } else {
        reportError("outgoing", message.message || "Couldn't attach to your Meet microphone");
        await stopMicTranslation("error");
      }
      return undefined;
    case "offscreen-error":
      if (message.channel === "mic") {
        reportError("mic", message.message);
        if (micSession) await stopNotesMic("error");
      } else if (message.fatal === false) {
        broadcast({ target: "ui", type: "warning", message: message.message });
      } else {
        reportError("capture", message.message);
        if (state.isCapturing) await stopCapture(true, message.message);
      }
      return undefined;
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.target && message.target !== "background")) return;
  if (message.type === "open-side-panel") {
    // Must run synchronously inside the user gesture forwarded from the Meet widget.
    const tabId = sender.tab?.id;
    const opening = tabId !== undefined ? chrome.sidePanel.open({ tabId }) : Promise.reject(new Error("No tab"));
    opening
      .then(() => sendResponse({ success: true }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  handle(message, sender)
    .then((res) => sendResponse(res ?? { success: true }))
    .catch((err: Error) => {
      console.error("[BG]", message.type, err);
      sendResponse({ success: false, error: err.message, state });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  voiceInCall.delete(tabId);
  if (tabId === state.tabId && state.isCapturing) void stopCapture(true);
  if (tabId === outgoing?.tabId) void stopMicTranslation();
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});
