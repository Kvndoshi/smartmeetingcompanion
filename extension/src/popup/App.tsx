import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../logo.png";
import { api } from "../shared/api";
import { BACKEND_HTTP_URL } from "../shared/config";
import { ext } from "../shared/ext";
import { formatDuration, useBackendHealth, useElapsed, useSessionState, useTheme } from "../shared/hooks";
import { speakerLabel, type Modes, type OriginalAudio, type ProviderInfo, type ProvidersStatus, type Source } from "../shared/protocol";
import { AUTO, LANGUAGES, langName, langShort, sameLanguage } from "../utils/languages";
import MemoriesTab from "./MemoriesTab";

interface AudioDevice {
  deviceId: string;
  label: string;
}

interface PreviewLine {
  key: string;
  source: Source;
  speaker: string | null;
  text: string;
  translation: string;
  language?: string | null;
  segmentId?: number;
}

type PickerMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

type PopupTab = "session" | "memories";
type MicPermission = "granted" | "prompt" | "denied" | "unknown";

const PICK_OUTPUT_OPTION_VALUE = "__pick_output_device__";
const PERMISSIONS_PAGE = "src/permissions/index.html";
const MAX_PREVIEW_LINES = 30;

/* ── Icons ── */

const WaveformBars = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 32 20" fill="currentColor" className={`waveform-svg ${active ? "waveform-active" : ""}`}>
    <rect className="wf-bar" x="3" y="6" width="3" height="8" rx="1.5" />
    <rect className="wf-bar" x="8.5" y="3" width="3" height="14" rx="1.5" />
    <rect className="wf-bar" x="14" y="1" width="3" height="18" rx="1.5" />
    <rect className="wf-bar" x="19.5" y="4" width="3" height="12" rx="1.5" />
    <rect className="wf-bar" x="25" y="6.5" width="3" height="7" rx="1.5" />
  </svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.14v14l11-7-11-7z" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const HeadphonesIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
  </svg>
);

const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
  </svg>
);

const NotesIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h5" />
  </svg>
);

const MEET_URL = /^https:\/\/meet\.google\.com\//i;

function LangOptions({ exclude }: { exclude?: string }) {
  return (
    <>
      {LANGUAGES.filter((l) => l.code !== exclude).map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </>
  );
}

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

function isCapturableUrl(url?: string): boolean {
  if (!url) return true;
  return !/^(chrome|chrome-extension|edge|devtools|about):/i.test(url);
}

function ProviderSelect({
  label,
  value,
  onChange,
  providers,
  defaultId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  providers: ProviderInfo[];
  defaultId: string | null;
  disabled: boolean;
}) {
  const defaultLabel = providers.find((p) => p.id === defaultId)?.label;
  return (
    <label className="provider-field">
      <span className="provider-label">{label}</span>
      <select className="output-select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{defaultLabel ? `Auto (${defaultLabel})` : "Auto"}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.configured}>
            {p.label}
            {p.configured ? "" : " — no key"}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const session = useSessionState();
  const { online, recheck } = useBackendHealth();

  const [activeTab, setActiveTab] = useState<PopupTab>("session");
  // targetLang = My language (I speak it and want to hear it); sourceLang = They speak ("auto" = detect).
  const [sourceLang, setSourceLang] = useState(AUTO);
  const [targetLang, setTargetLang] = useState("en");
  // Others hear me in ("auto" = match the room).
  const [speakLang, setSpeakLang] = useState(AUTO);
  const [originalAudio, setOriginalAudio] = useState<OriginalAudio>("quiet");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [modes, setModes] = useState<Modes>({ translate: true, notes: true });
  // On by default: your own voice is part of the meeting (Meet never plays it back in the tab).
  const [includeMic, setIncludeMic] = useState(true);
  const [sttProvider, setSttProvider] = useState("");
  const [ttsProvider, setTtsProvider] = useState("");
  const [providers, setProviders] = useState<ProvidersStatus | null>(null);
  const [micPermission, setMicPermission] = useState<MicPermission>("unknown");
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<PreviewLine[]>([]);
  const [partial, setPartial] = useState<{ source: Source; speaker: string | null; text: string; translation?: string } | null>(null);
  const [targetTab, setTargetTab] = useState<{ id?: number; url?: string; title?: string; windowId?: number } | null>(null);

  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const selectedDeviceRef = useRef("");
  const lineCounter = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const isCapturing = !!session?.isCapturing;
  const isStarting = busy || session?.status === "connecting";
  const elapsed = useElapsed(session?.captureStartedAt, isCapturing);
  const canPickOutputDevice = typeof (navigator.mediaDevices as PickerMediaDevices).selectAudioOutput === "function";

  // ── Initial load ──
  useEffect(() => {
    void ext
      .storageGet<{
        sourceLang: string;
        targetLang: string;
        speakLang: string;
        originalAudio: OriginalAudio;
        outputDeviceId: string;
        modes: Modes;
        includeMic: boolean;
        sttProvider: string;
        ttsProvider: string;
      }>(["sourceLang", "targetLang", "speakLang", "originalAudio", "outputDeviceId", "modes", "includeMic", "sttProvider", "ttsProvider"])
      .then((d) => {
        if (d.sourceLang) setSourceLang(d.sourceLang);
        if (d.targetLang) setTargetLang(d.targetLang);
        // Before "Others hear me in" existed, voice translation used the meeting language.
        const savedSpeak = d.speakLang || (d.sourceLang && d.sourceLang !== AUTO ? d.sourceLang : AUTO);
        setSpeakLang(sameLanguage(savedSpeak, d.targetLang || "en") ? AUTO : savedSpeak);
        if (d.originalAudio === "muted" || d.originalAudio === "quiet") setOriginalAudio(d.originalAudio);
        if (d.modes && typeof d.modes.translate === "boolean") setModes(d.modes);
        if (typeof d.includeMic === "boolean") setIncludeMic(d.includeMic);
        if (typeof d.sttProvider === "string") setSttProvider(d.sttProvider);
        if (typeof d.ttsProvider === "string") setTtsProvider(d.ttsProvider);
        if (d.outputDeviceId) {
          selectedDeviceRef.current = d.outputDeviceId;
          setSelectedDevice(d.outputDeviceId);
        }
        void loadOutputDevices();
      });
    void ext.activeTab().then(setTargetTab);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        setMicPermission(status.state as MicPermission);
        status.onchange = () => setMicPermission(status.state as MicPermission);
      })
      .catch(() => setMicPermission("unknown"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (online !== true) return;
    api
      .providers()
      .then(setProviders)
      .catch(() => setProviders(null));
  }, [online]);

  const persist = (values: Record<string, unknown>) => ext.storageSet(values);

  // ── Live preview (the side panel has the full transcript) ──
  useEffect(() => {
    return ext.onUiMessage((msg) => {
      if (msg.type === "transcript") {
        if (!msg.isFinal) {
          setPartial({ source: msg.source, speaker: msg.speaker, text: msg.text });
          return;
        }
        const language = msg.language;
        setPartial(null);
        setLines((prev) => {
          if (msg.segmentId && prev.some((l) => l.segmentId === msg.segmentId)) return prev;
          const line: PreviewLine = {
            key: `l${++lineCounter.current}`,
            source: msg.source,
            speaker: msg.speaker,
            text: msg.text,
            translation: "",
            language,
            segmentId: msg.segmentId,
          };
          return [...prev, line].slice(-MAX_PREVIEW_LINES);
        });
      } else if (msg.type === "translation") {
        if (!msg.isFinal) {
          setPartial((p) => (p ? { ...p, translation: msg.text } : p));
          return;
        }
        setLines((prev) => {
          let idx = msg.segmentId ? prev.findIndex((l) => l.segmentId === msg.segmentId) : -1;
          if (idx < 0) {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].source === msg.source && !prev[i].translation) {
                idx = i;
                break;
              }
            }
          }
          if (idx < 0) {
            const line: PreviewLine = { key: `l${++lineCounter.current}`, source: msg.source, speaker: msg.speaker, text: "", translation: msg.text };
            return [...prev, line].slice(-MAX_PREVIEW_LINES);
          }
          const next = [...prev];
          next[idx] = { ...next[idx], translation: msg.text };
          return next;
        });
      } else if (msg.type === "error") {
        setErrorMsg(msg.message);
      }
    });
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [lines, partial]);

  // ── Output devices (translated audio) ──
  const applyOutputDevices = useCallback((devices: AudioDevice[]) => {
    setOutputDevices(devices);
    if (selectedDeviceRef.current) return;
    const blackhole = devices.find((d) => d.label.toLowerCase().includes("blackhole"));
    if (!blackhole) return;
    selectedDeviceRef.current = blackhole.deviceId;
    setSelectedDevice(blackhole.deviceId);
    ext.storageSet({ outputDeviceId: blackhole.deviceId });
    void ext.send({ type: "set-output-device", target: "background", deviceId: blackhole.deviceId });
  }, []);

  const loadOutputDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const map = new Map<string, AudioDevice>();
      for (const d of all) {
        if (d.kind !== "audiooutput" || !d.deviceId || d.deviceId === "default" || map.has(d.deviceId)) continue;
        map.set(d.deviceId, { deviceId: d.deviceId, label: d.label || `Output ${d.deviceId.slice(0, 8)}` });
      }
      applyOutputDevices([...map.values()]);
    } catch (err) {
      console.error("[Popup] Failed to enumerate output devices:", err);
    }
  }, [applyOutputDevices]);

  const chooseDevice = (deviceId: string) => {
    selectedDeviceRef.current = deviceId;
    setSelectedDevice(deviceId);
    ext.storageSet({ outputDeviceId: deviceId });
    void ext.send({ type: "set-output-device", target: "background", deviceId });
  };

  const refreshDevices = async () => {
    await loadOutputDevices();
    if (canPickOutputDevice) {
      try {
        const picked = await (navigator.mediaDevices as PickerMediaDevices).selectAudioOutput!(
          selectedDeviceRef.current ? { deviceId: selectedDeviceRef.current } : undefined
        );
        chooseDevice(picked.deviceId);
        await loadOutputDevices();
      } catch {
        /* picker dismissed */
      }
      return;
    }
    if (micPermission !== "granted") {
      setErrorMsg("Device names appear after microphone access is granted.");
      ext.openTab(PERMISSIONS_PAGE);
    }
  };

  // ── Controls ──
  const setMode = (key: keyof Modes, value: boolean) => {
    const next = { ...modes, [key]: value };
    setModes(next);
    persist({ modes: next });
  };

  const toggleIncludeMic = (value: boolean) => {
    setIncludeMic(value);
    persist({ includeMic: value });
    if (value && micPermission !== "granted") ext.openTab(PERMISSIONS_PAGE);
  };

  const openPanel = () => {
    void ext.openSidePanel(targetTab?.windowId).catch((err: Error) => setErrorMsg(err.message));
  };

  const handleStart = () => {
    setErrorMsg("");
    setLines([]);
    setPartial(null);
    setBusy(true);
    if (selectedDevice) void ext.send({ type: "set-output-device", target: "background", deviceId: selectedDevice });
    // Send first, then open the panel — both synchronously inside the click so the
    // side panel still counts as user-initiated and the start survives the popup closing.
    const started = ext.send({
      type: "start-capture",
      target: "background",
      sourceLang,
      targetLang,
      modes,
      includeMic: modes.notes && includeMic,
      sttProvider: sttProvider || null,
      ttsProvider: modes.translate ? ttsProvider || null : null,
      originalAudio,
      tabId: targetTab?.id,
    });
    if (modes.notes) openPanel();
    // First run: ask for the mic once, next to the meeting. Everyone else is already
    // being transcribed; your voice joins as soon as you click Allow.
    if (modes.notes && includeMic && micPermission !== "granted" && micPermission !== "denied")
      ext.openTab(PERMISSIONS_PAGE, targetTab?.id);
    void started.then((res) => {
      setBusy(false);
      if (!res.success) setErrorMsg(res.error || "Failed to start capture");
    });
  };

  const handleStop = async () => {
    setBusy(true);
    const res = await ext.send({ type: "stop-capture", target: "background", endMeeting: true });
    setBusy(false);
    if (!res.success) setErrorMsg(res.error || "Failed to stop");
  };

  // ── What they hear (your voice, Meet only) ──
  const toggleVoice = async () => {
    setErrorMsg("");
    setVoiceBusy(true);
    const res = session?.isMicTranslating
      ? await ext.send({ type: "stop-mic-translation", target: "background" })
      : await ext.send({ type: "start-mic-translation", target: "background", myLang: targetLang, speakLang, tabId: targetTab?.id });
    setVoiceBusy(false);
    if (!res.success) setErrorMsg(res.error || "Voice translation failed");
  };

  const changeSpeakLang = (value: string) => {
    setSpeakLang(value);
    persist({ speakLang: value });
    if (session?.isMicTranslating) void ext.send({ type: "set-speak-language", target: "background", speakLang: value });
  };

  // ── Derived UI state ──
  const sttConfigured = providers ? providers.stt.providers.some((p) => p.configured) : true;
  const ttsConfigured = providers ? providers.tts.providers.some((p) => p.configured) : true;
  const llmConfigured = providers ? providers.llm.providers.some((p) => p.configured) : true;
  const tabCapturable = isCapturableUrl(targetTab?.url);
  const noMode = !modes.translate && !modes.notes;
  const isMeetTab = MEET_URL.test(targetTab?.url || "") || (!!session?.isMicTranslating && session.tabId === targetTab?.id);
  // Auto-detect needs an STT provider that identifies languages (Soniox, Deepgram).
  const autoCapable = !providers
    ? true
    : sttProvider
      ? !!providers.stt.providers.find((p) => p.id === sttProvider)?.auto_language
      : providers.stt.providers.some((p) => p.configured && p.auto_language);

  const startBlocker =
    online === false
      ? "Start the backend first"
      : !sttConfigured
        ? "Add a speech-to-text key in Settings"
        : noMode
          ? "Turn on What I hear and/or Take notes"
          : !tabCapturable
            ? "Open your meeting tab, then click Distill"
            : sourceLang === AUTO && !autoCapable
              ? "Pick the language they speak"
              : "";

  const statusText = (() => {
    if (!session) return "Ready";
    switch (session.status) {
      case "connecting":
        return "Connecting…";
      case "reconnecting":
        return "Reconnecting to backend…";
      case "capturing":
        return session.modes.translate && session.modes.notes
          ? "Translating & taking notes"
          : session.modes.translate
            ? "Translating live"
            : "Taking notes";
      case "error":
        return session.lastError || "Error";
      default:
        return "Ready";
    }
  })();
  const statusDot =
    session?.status === "capturing" ? "capturing" : session?.status === "error" ? "error" : session?.status === "connecting" || session?.status === "reconnecting" ? "connected" : "idle";

  const selectedDeviceLabel = outputDevices.find((d) => d.deviceId === selectedDevice)?.label ?? "";
  const editable = !isCapturing && !isStarting;
  const voiceOn = !!session?.isMicTranslating;
  const myLangName = langName(targetLang);

  const voiceStatus = (() => {
    if (!session) return { dot: "", text: "" };
    switch (session.outgoingStatus) {
      case "starting":
        return { dot: "starting", text: "Connecting your voice…" };
      case "error":
        return { dot: "error", text: "Voice translation stopped — see the message above" };
      case "on":
        if (session.outgoingLang) return { dot: "on", text: `Others hear you in ${langName(session.outgoingLang)}` };
        if (session.speakLang === AUTO && !session.isCapturing)
          return { dot: "on", text: "Others hear your own voice — press Start so Distill can hear which language the room speaks" };
        if (session.speakLang === AUTO)
          return { dot: "on", text: `Others hear your own voice — the room speaks ${myLangName} or hasn't said enough yet` };
        return { dot: "on", text: "Others hear your own voice" };
      default:
        return { dot: "", text: "" };
    }
  })();
  const sttInfo = providers?.stt.providers.find((p) => p.id === (sttProvider || providers.stt.default));

  return (
    <div className={`app ${theme}`}>
      <div className="header">
        <div className="header-logo">
          <img src={logo} alt="Distill logo" className="header-logo-image" />
        </div>
        <div className="header-text">
          <div className="header-title">Distill</div>
          <div className="header-subtitle">Translate · Transcribe · Summarize</div>
        </div>
        {isCapturing && <span className="header-timer">{formatDuration(elapsed)}</span>}
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme" type="button">
          {theme === "dark" ? "☀︎" : "◗"}
        </button>
        <div className={`header-waveform ${isCapturing ? "active" : ""}`}>
          <WaveformBars active={isCapturing} />
        </div>
      </div>

      <div className="status-bar">
        <span className={`status-dot ${statusDot}`} />
        <span className="status-text">{statusText}</span>
        {session?.isCapturing && session.activeProviders.stt && (
          <span className="status-providers">
            {session.activeProviders.stt}
            {session.activeProviders.tts ? ` → ${session.activeProviders.tts}` : ""}
          </span>
        )}
      </div>

      {online === false && (
        <div className="banner error" style={{ marginTop: 8 }}>
          <span>
            Backend offline. In <code>backend/</code> run <code>uv run uvicorn main:app --port 8000</code>.
          </span>
          <button type="button" onClick={recheck}>
            Retry
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="banner error" style={{ marginTop: 8 }}>
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="content">
        <div className="tab-switcher" role="tablist" aria-label="Distill popup sections">
          <button
            className={`tab-switcher-btn ${activeTab === "session" ? "active" : ""}`}
            onClick={() => setActiveTab("session")}
            type="button"
            role="tab"
            aria-selected={activeTab === "session"}
          >
            Session
          </button>
          <button
            className={`tab-switcher-btn ${activeTab === "memories" ? "active" : ""}`}
            onClick={() => setActiveTab("memories")}
            type="button"
            role="tab"
            aria-selected={activeTab === "memories"}
          >
            Memories
          </button>
        </div>

        {activeTab === "session" ? (
          <>
            <label className="my-lang">
              <span className="section-label">My language — I speak it and want to hear it</span>
              <select
                className="lang-select boxed"
                value={targetLang}
                onChange={(e) => {
                  setTargetLang(e.target.value);
                  persist({ targetLang: e.target.value });
                  // "Others hear me in" never offers my own language.
                  if (sameLanguage(speakLang, e.target.value)) changeSpeakLang(AUTO);
                }}
                disabled={!editable || voiceOn}
                aria-label="My language"
              >
                <LangOptions />
              </select>
            </label>

            {/* 🎧 What I hear — everyone else, translated into my language */}
            <div className={`dir-card hear ${modes.translate ? "on" : ""}`}>
              <label className="dir-head">
                <span className="dir-icon">
                  <HeadphonesIcon />
                </span>
                <span className="dir-text">
                  <span className="dir-title">What I hear</span>
                  <span className="dir-sub">Translate everyone else into {myLangName}</span>
                </span>
                <input
                  type="checkbox"
                  className="dir-toggle"
                  checked={modes.translate}
                  onChange={(e) => setMode("translate", e.target.checked)}
                  disabled={!editable}
                  aria-label="Translate what I hear"
                />
              </label>
              <label className="field-row">
                <span>They speak</span>
                <select
                  className="lang-select boxed"
                  value={sourceLang}
                  onChange={(e) => {
                    setSourceLang(e.target.value);
                    persist({ sourceLang: e.target.value });
                  }}
                  disabled={!editable}
                  aria-label="They speak"
                >
                  <option value={AUTO}>Auto-detect (any language)</option>
                  <LangOptions />
                </select>
              </label>
              {modes.translate && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={originalAudio === "quiet"}
                    onChange={(e) => {
                      const next: OriginalAudio = e.target.checked ? "quiet" : "muted";
                      setOriginalAudio(next);
                      persist({ originalAudio: next });
                    }}
                    disabled={!editable}
                  />
                  <span>Keep original voices quietly underneath</span>
                </label>
              )}
              {sourceLang === AUTO && (
                <div className="device-hint">
                  Each speaker's language is detected; anyone already speaking {myLangName} is heard as-is.
                </div>
              )}
              {sourceLang === AUTO && !autoCapable && (
                <div className="device-hint warning">Auto-detect needs Soniox or Deepgram — pick the language they speak, or switch provider.</div>
              )}
            </div>

            {/* 🎤 What they hear — my voice, translated for the others (Meet only) */}
            <div className={`dir-card speak ${voiceOn ? "on" : ""}`}>
              <div className="dir-head">
                <span className="dir-icon">
                  <MicIcon />
                </span>
                <span className="dir-text">
                  <span className="dir-title">What they hear</span>
                  <span className="dir-sub">Your voice, translated for everyone in the call · Google Meet</span>
                </span>
              </div>
              <label className="field-row">
                <span>Others hear me in</span>
                <select
                  className="lang-select boxed"
                  value={speakLang}
                  onChange={(e) => changeSpeakLang(e.target.value)}
                  disabled={voiceBusy}
                  aria-label="Others hear me in"
                >
                  <option value={AUTO}>Auto — match the room</option>
                  <LangOptions exclude={targetLang} />
                </select>
              </label>
              <button
                type="button"
                className={`dir-btn ${voiceOn ? "active" : ""}`}
                onClick={() => void toggleVoice()}
                disabled={voiceBusy || (!voiceOn && (!isMeetTab || online === false))}
              >
                <MicIcon />
                {voiceOn ? "Stop — others hear my own voice" : "Translate my voice"}
              </button>
              {voiceStatus.text && (
                <div className="dir-status">
                  <span className={`dot ${voiceStatus.dot}`} />
                  <span>{voiceStatus.text}</span>
                </div>
              )}
              {!voiceOn && !isMeetTab && <div className="device-hint">Works in Google Meet — open your Meet call tab.</div>}
              {!voiceOn && isMeetTab && (
                <div className="device-hint">
                  One language at a time: everyone hears the same voice. Use headphones. If the others run Distill too, leave this off — they hear
                  you in their own language.
                </div>
              )}
            </div>

            {/* 📝 Notes */}
            <div className={`dir-card notes ${modes.notes ? "on" : ""}`}>
              <label className="dir-head">
                <span className="dir-icon">
                  <NotesIcon />
                </span>
                <span className="dir-text">
                  <span className="dir-title">Take notes</span>
                  <span className="dir-sub">Transcript, summary &amp; chat</span>
                </span>
                <input
                  type="checkbox"
                  className="dir-toggle"
                  checked={modes.notes}
                  onChange={(e) => setMode("notes", e.target.checked)}
                  disabled={!editable}
                  aria-label="Take notes"
                />
              </label>
              {modes.notes && (
                <label className="check-row">
                  <input type="checkbox" checked={includeMic} onChange={(e) => toggleIncludeMic(e.target.checked)} disabled={!editable} />
                  <span>Include my microphone in the notes</span>
                  {includeMic && micPermission !== "granted" && (
                    <button type="button" className="link-btn" onClick={() => ext.openTab(PERMISSIONS_PAGE, targetTab?.id)}>
                      Allow
                    </button>
                  )}
                </label>
              )}
            </div>

            {providers && (
              <div className="provider-grid">
                <ProviderSelect
                  label="Speech-to-text"
                  value={sttProvider}
                  onChange={(v) => {
                    setSttProvider(v);
                    persist({ sttProvider: v });
                  }}
                  providers={providers.stt.providers}
                  defaultId={providers.stt.default}
                  disabled={!editable}
                />
                {modes.translate && (
                  <ProviderSelect
                    label="Voice (TTS)"
                    value={ttsProvider}
                    onChange={(v) => {
                      setTtsProvider(v);
                      persist({ ttsProvider: v });
                    }}
                    providers={providers.tts.providers}
                    defaultId={providers.tts.default}
                    disabled={!editable}
                  />
                )}
              </div>
            )}
            {providers && modes.notes && sttInfo && !sttInfo.diarization && (
              <div className="device-hint warning">{sttInfo.label} doesn't label speakers — try Soniox or Deepgram.</div>
            )}
            {providers && modes.translate && !ttsConfigured && (
              <div className="device-hint warning">No TTS key — you'll get translated text without audio.</div>
            )}
            {providers && modes.notes && !llmConfigured && (
              <div className="device-hint warning">Add a Gemini or Groq key for summaries and chat.</div>
            )}

            {modes.translate && (
              <div className="output-section">
                <div className="output-header">
                  <span className="section-label">
                    <SpeakerIcon />
                    Translated audio output
                  </span>
                  <button className="refresh-btn" onClick={refreshDevices} title="Refresh devices" type="button">
                    <RefreshIcon />
                  </button>
                </div>
                <select
                  className="output-select"
                  value={selectedDevice}
                  onChange={(e) => (e.target.value === PICK_OUTPUT_OPTION_VALUE ? void refreshDevices() : chooseDevice(e.target.value))}
                  disabled={!editable}
                >
                  <option value="">System Default</option>
                  {canPickOutputDevice && <option value={PICK_OUTPUT_OPTION_VALUE}>Choose Output Device…</option>}
                  {outputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {selectedDeviceLabel.toLowerCase().includes("blackhole") && (
                  <div className="device-hint success">BlackHole selected — set your call's mic to BlackHole too</div>
                )}
              </div>
            )}

            {isCapturing ? (
              <button className="action-btn stop" onClick={() => void handleStop()} disabled={busy} type="button">
                <span className="btn-content">
                  <StopIcon />
                  {session?.modes.notes ? "Stop & summarize" : "Stop"}
                </span>
              </button>
            ) : (
              <button className="action-btn start" onClick={handleStart} disabled={isStarting || !!startBlocker} type="button">
                <span className="btn-content">
                  <PlayIcon />
                  {isStarting
                    ? "Starting…"
                    : startBlocker ||
                      (modes.translate && modes.notes ? "Start — hear translated & take notes" : modes.translate ? "Start — hear translated" : "Start taking notes")}
                </span>
              </button>
            )}

            <button className="small-btn ghost wide" type="button" onClick={openPanel}>
              Open notes panel — transcript, summary &amp; chat
            </button>

            {(isCapturing || lines.length > 0) && (
              <div className="transcript-section">
                <span className="section-label">Live preview</span>
                <div className="transcript-box" ref={transcriptRef}>
                  {lines.length === 0 && !partial && <div className="transcript-empty">Listening…</div>}
                  {lines.map((l) => (
                    <div key={l.key} className="transcript-entry">
                      {l.text && (
                        <div className="transcript-original">
                          {l.language && !sameLanguage(l.language, targetLang) && <span className="lang-chip">{langShort(l.language)}</span>}
                          <b>{speakerLabel(l.source === "mic" ? "me" : l.speaker)}:</b> {l.text}
                        </div>
                      )}
                      {l.translation && <div className="transcript-translated">{l.translation}</div>}
                    </div>
                  ))}
                  {partial && (
                    <div className="transcript-entry">
                      <div className="transcript-original">{partial.text}</div>
                      {partial.translation && <div className="transcript-translated">{partial.translation}</div>}
                    </div>
                  )}
                </div>
              </div>
            )}

            <a className="footer-link" href={BACKEND_HTTP_URL} target="_blank" rel="noreferrer">
              API keys &amp; settings ↗
            </a>
          </>
        ) : (
          <MemoriesTab />
        )}
      </div>
    </div>
  );
}
