// Shared message types: backend WebSocket protocol + extension runtime messages.
// Keep in sync with backend/services/session.py.

export type Source = "tab" | "mic";

/* ── Backend WebSocket (/ws/translate) ─────────────────────────────── */

export interface BackendConfig {
  type: "config";
  /** "auto" = the provider detects each segment's language. */
  source_lang: string;
  target_lang: string;
  mode: { translate: boolean; transcribe: boolean };
  source: Source;
  meeting_id?: string | null;
  tab_url?: string;
  tab_title?: string;
  stt_provider?: string;
  tts_provider?: string;
  translator?: string;
}

export type ServerMessage =
  | {
      type: "session";
      meeting_id: string | null;
      meeting_title: string | null;
      stt_provider: string;
      tts_provider: string | null;
      translator: string | null;
      translate: boolean;
      transcribe: boolean;
      source: Source;
      diarization: boolean;
      source_lang?: string;
      target_lang?: string;
      auto_language?: boolean;
      // Nothing to translate or transcribe: no provider connection until the next config.
      idle?: boolean;
    }
  | {
      type: "transcript";
      text: string;
      is_final: boolean;
      speaker: string | null;
      source: Source;
      /** ISO base code of what was said; null when unknown. */
      language?: string | null;
      segment_id?: number;
      start_ms?: number;
    }
  | { type: "translated_text_partial"; text: string; speaker: string | null; source: Source; language?: string | null }
  | {
      type: "translated_text";
      text: string;
      segment_id: number | null;
      speaker: string | null;
      source: Source;
      language?: string | null;
    }
  | { type: "stopped"; meeting_id: string | null }
  | { type: "meeting_ended"; meeting_id: string | null }
  | { type: "status"; status: "reconnecting" }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; code?: string }
  | { type: "pong"; t?: number };

/* ── Session state (service worker → UI) ───────────────────────────── */

export type CaptureStatus = "idle" | "connecting" | "capturing" | "reconnecting" | "error";
export type MicStatus = "idle" | "starting" | "on" | "error";

export interface Modes {
  translate: boolean;
  notes: boolean;
}

/** What happens to the other participants' own voices while their translation plays. */
export type OriginalAudio = "quiet" | "muted";

export interface SessionState {
  isCapturing: boolean;
  status: CaptureStatus;
  captureStartedAt: number | null;
  tabId: number | null;
  tabTitle: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  modes: Modes;
  includeMic: boolean;
  /** Your own voice in the transcript (offscreen mic, notes mode). */
  micStatus: MicStatus;
  /** Meet-only outgoing voice translation ("What they hear"). */
  isMicTranslating: boolean;
  outgoingStatus: MicStatus;
  /** They speak: "auto" or a language code. */
  sourceLang: string;
  /** My language: what I speak and want to hear. */
  targetLang: string;
  /** Others hear me in: "auto" (match the room) or a language code. */
  speakLang: string;
  /** Language others currently hear me in; null = my own voice (no translation). */
  outgoingLang: string | null;
  /** Detected language the other participants mostly speak (auto mode), if known. */
  roomLang: string | null;
  originalAudio: OriginalAudio;
  sttProvider: string | null;
  ttsProvider: string | null;
  activeProviders: { stt: string | null; tts: string | null; translator: string | null; diarization: boolean };
  outputDeviceId: string | null;
  lastError: string | null;
}

export const INITIAL_STATE: SessionState = {
  isCapturing: false,
  status: "idle",
  captureStartedAt: null,
  tabId: null,
  tabTitle: null,
  meetingId: null,
  meetingTitle: null,
  modes: { translate: true, notes: true },
  includeMic: false,
  micStatus: "idle",
  isMicTranslating: false,
  outgoingStatus: "idle",
  sourceLang: "auto",
  targetLang: "en",
  speakLang: "auto",
  outgoingLang: null,
  roomLang: null,
  originalAudio: "quiet",
  sttProvider: null,
  ttsProvider: null,
  activeProviders: { stt: null, tts: null, translator: null, diarization: false },
  outputDeviceId: null,
  lastError: null,
};

/* ── Broadcasts to every UI surface (popup, side panel, Meet widget) ── */

export type UiMessage =
  | { target: "ui"; type: "state"; state: SessionState }
  | {
      target: "ui";
      type: "transcript";
      source: Source;
      text: string;
      isFinal: boolean;
      speaker: string | null;
      language?: string | null;
      segmentId?: number;
      startMs?: number;
      meetingId: string | null;
    }
  | {
      target: "ui";
      type: "translation";
      source: Source;
      text: string;
      isFinal: boolean;
      speaker: string | null;
      language?: string | null;
      segmentId?: number | null;
      meetingId: string | null;
    }
  | { target: "ui"; type: "error"; channel: "capture" | "mic" | "outgoing"; message: string; code?: string }
  | { target: "ui"; type: "warning"; message: string }
  | { target: "ui"; type: "meeting-ended"; meetingId: string };

/* ── Commands to the service worker ────────────────────────────────── */

export interface StartCaptureRequest {
  type: "start-capture";
  target: "background";
  sourceLang: string;
  targetLang: string;
  modes?: Modes;
  includeMic?: boolean;
  sttProvider?: string | null;
  ttsProvider?: string | null;
  originalAudio?: OriginalAudio;
  tabId?: number;
}

export type BackgroundRequest =
  | StartCaptureRequest
  | { type: "stop-capture"; target: "background"; endMeeting?: boolean }
  | { type: "get-state"; target: "background" }
  | { type: "set-output-device"; target: "background"; deviceId: string }
  // "What they hear": I speak `myLang`; others hear `speakLang` ("auto" = match the room).
  | { type: "start-mic-translation"; target: "background"; myLang: string; speakLang: string; tabId?: number }
  | { type: "set-speak-language"; target: "background"; speakLang: string }
  | { type: "stop-mic-translation"; target: "background" }
  | { type: "open-side-panel"; target: "background" }
  | { type: "audio-data"; target: "background"; data: number[] }
  | { type: "mic-audio-data"; target: "background"; data: number[] }
  | { type: "offscreen-error"; target: "background"; channel: "capture" | "mic"; message: string; fatal?: boolean }
  | { type: "outgoing-status"; target: "background"; ok: boolean; message?: string }
  // Meet only: is your voice reaching the call (null = unknown)? Notes follow Meet's mute.
  | { type: "meet-mic-state"; target: "background"; live: boolean | null };

export interface BackgroundResponse {
  success: boolean;
  error?: string;
  state?: SessionState;
}

/* ── Service worker → offscreen document ───────────────────────────── */

export type OffscreenRequest =
  // originalLevel: volume of the meeting's own audio (tabCapture mutes the tab): 1 = as usual, 0 = silent.
  | { type: "start-capture"; target: "offscreen"; streamId: string; outputDeviceId: string | null; originalLevel: number; duckLevel: number }
  | { type: "stop-capture"; target: "offscreen" }
  | { type: "start-mic-capture"; target: "offscreen" }
  | { type: "stop-mic-capture"; target: "offscreen" }
  | { type: "set-original-level"; target: "offscreen"; level: number; duckLevel: number }
  | { type: "translated-audio"; target: "offscreen"; data: number[] }
  | { type: "set-output-device"; target: "offscreen"; deviceId: string | null };

/* ── Provider status (GET /api/providers) ──────────────────────────── */

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  diarization?: boolean;
  native_translation?: boolean;
  auto_language?: boolean;
  languages?: string[] | null;
  notes?: string;
}

export interface ProviderKindStatus {
  providers: ProviderInfo[];
  default: string | null;
}

export interface ProvidersStatus {
  stt: ProviderKindStatus;
  tts: ProviderKindStatus;
  llm: ProviderKindStatus;
  translator: ProviderKindStatus;
  memory: { supermemory: boolean };
  languages: string[];
}

/* ── Meetings API ──────────────────────────────────────────────────── */

export interface ActionItem {
  task: string;
  owner?: string | null;
  due?: string | null;
}

export interface MeetingSummary {
  title: string;
  overview: string;
  key_points: string[];
  decisions: string[];
  action_items: ActionItem[];
  open_questions: string[];
  topics: { title: string; timestamp?: string | null; summary?: string | null }[];
  next_steps: string[];
  _meta?: { provider: string; model: string; language: string; segment_count: number; generated_at: number };
}

export interface Segment {
  id: number;
  meeting_id: string;
  source: Source;
  speaker: string | null;
  text: string;
  translated_text: string | null;
  language?: string | null;
  start_ms: number;
  end_ms: number | null;
}

export interface Meeting {
  id: string;
  title: string;
  platform: string;
  platform_label: string;
  tab_url: string | null;
  status: "live" | "ended";
  started_at: number;
  ended_at: number | null;
  summary: MeetingSummary | null;
  summary_status: string | null;
  summary_error: string | null;
  summary_language: string | null;
  user_notes: string | null;
  speaker_names: Record<string, string>;
  memory_status: string | null;
  memory_error: string | null;
  segment_count?: number;
  segments?: Segment[];
}

export interface ChatSource {
  id: number;
  kind: "meeting" | "memory" | "transcript";
  title: string | null;
  excerpt?: string;
  meeting_id?: string | null;
}

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
}

export type ChatEvent =
  | { type: "sources"; sources: ChatSource[] }
  | { type: "delta"; text: string }
  | { type: "done"; message_id: number; provider: string; model: string }
  | { type: "error"; message: string; code?: string };

export function speakerLabel(speaker: string | null | undefined, names: Record<string, string> = {}): string {
  if (!speaker) return "Speaker";
  if (names[speaker]) return names[speaker];
  if (speaker === "me") return "You";
  const m = /^S(\d+)$/.exec(speaker);
  return m ? `Speaker ${m[1]}` : speaker;
}

export function formatTimestamp(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
