import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../logo.png";
import { api } from "../shared/api";
import { BACKEND_HTTP_URL } from "../shared/config";
import { ext } from "../shared/ext";
import { formatDuration, useBackendHealth, useElapsed, useSessionState, useTheme } from "../shared/hooks";
import type { Meeting, Segment, Source } from "../shared/protocol";
import AskTab from "./AskTab";
import LiveTab from "./LiveTab";
import MeetingsTab from "./MeetingsTab";
import SummaryTab from "./SummaryTab";

type PanelTab = "live" | "summary" | "ask" | "meetings";

export interface LivePartial {
  speaker: string | null;
  text: string;
  translation?: string;
}

type MeetingMeta = Omit<Meeting, "segments">;

const LIVE_POLL_MS = 10_000;
const PENDING_POLL_MS = 3_000;

/** Merge segments by id; ids are assigned in arrival order, so they also order tab + mic lines. */
function upsertSegments(prev: Segment[], incoming: Segment[]): Segment[] {
  if (!incoming.length) return prev;
  const byId = new Map(prev.map((s) => [s.id, s]));
  for (const seg of incoming) byId.set(seg.id, { ...byId.get(seg.id), ...seg });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function stripSegments(m: Meeting): MeetingMeta {
  const { segments: _segments, ...meta } = m;
  return meta;
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const session = useSessionState();
  const { online, recheck } = useBackendHealth();

  const [tab, setTab] = useState<PanelTab>("live");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<MeetingMeta | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [partials, setPartials] = useState<Partial<Record<Source, LivePartial>>>({});
  const [banner, setBanner] = useState<{ kind: "error" | "warning"; text: string } | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [initialised, setInitialised] = useState(false);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;
  const loadSeq = useRef(0);

  const liveMeetingId = session?.isCapturing ? session.meetingId : null;
  const isLive = !!liveMeetingId && liveMeetingId === selectedId;
  const elapsed = useElapsed(session?.captureStartedAt, !!session?.isCapturing);

  const showBanner = useCallback((kind: "error" | "warning", text: string) => {
    setBanner({ kind, text });
  }, []);

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), banner.kind === "error" ? 10_000 : 6_000);
    return () => clearTimeout(id);
  }, [banner]);

  // ── Which meeting is shown ──
  useEffect(() => {
    if (!ext.available) setTab("meetings"); // served outside the extension (tests): no live session
  }, []);

  useEffect(() => {
    if (!session || initialised) return;
    setInitialised(true);
    if (!session.meetingId) setTab("meetings"); // the follow-live effect selects a current meeting
  }, [session, initialised]);

  // A newly started capture always takes over the panel, even if an older
  // meeting was being browsed; otherwise the user's pick stays put.
  const liveId = session?.meetingId ?? null;
  const capturing = !!session?.isCapturing;
  useEffect(() => {
    if (!liveId) return;
    setSelectedId(liveId);
    if (capturing) setTab("live");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveId]);

  const selectMeeting = useCallback((id: string | null, nextTab?: PanelTab) => {
    setSelectedId(id);
    if (nextTab) setTab(nextTab);
  }, []);

  // ── Load + refresh the selected meeting ──
  const loadMeeting = useCallback(
    async (id: string) => {
      const mine = ++loadSeq.current;
      try {
        const full = await api.getMeeting(id);
        if (mine !== loadSeq.current) return;
        setMeeting(stripSegments(full));
        setSegments(full.segments ?? []);
        setPartials({});
      } catch (err) {
        if (mine !== loadSeq.current) return;
        setMeeting(null);
        setSegments([]);
        showBanner("error", (err as Error).message);
      }
    },
    [showBanner]
  );

  const refreshMeeting = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const lastId = segmentsRef.current.length ? segmentsRef.current[segmentsRef.current.length - 1].id : 0;
    try {
      const update = await api.getMeeting(id, lastId);
      if (selectedRef.current !== id) return;
      setMeeting(stripSegments(update));
      setSegments((prev) => upsertSegments(prev, update.segments ?? []));
    } catch {
      /* transient — the next poll retries */
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      loadSeq.current++;
      setMeeting(null);
      setSegments([]);
      setPartials({});
      return;
    }
    void loadMeeting(selectedId);
  }, [selectedId, loadMeeting]);

  // Backfill anything missed while the panel was closed / the worker restarted,
  // and pick up auto-summary results.
  const pollMs =
    meeting?.summary_status === "pending" ? PENDING_POLL_MS : meeting?.status === "live" ? LIVE_POLL_MS : 0;
  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => void refreshMeeting(), pollMs);
    return () => clearInterval(id);
  }, [pollMs, refreshMeeting]);

  // ── Live broadcasts from the service worker ──
  useEffect(() => {
    return ext.onUiMessage((msg) => {
      switch (msg.type) {
        case "transcript": {
          if (!msg.meetingId || msg.meetingId !== selectedRef.current) return;
          if (msg.isFinal && msg.segmentId) {
            const seg: Segment = {
              id: msg.segmentId,
              meeting_id: msg.meetingId,
              source: msg.source,
              speaker: msg.speaker,
              text: msg.text,
              translated_text: null,
              language: msg.language ?? null,
              start_ms: msg.startMs ?? 0,
              end_ms: null,
            };
            setSegments((prev) => {
              const existing = prev.find((s) => s.id === seg.id);
              return upsertSegments(prev, [existing ? { ...seg, translated_text: existing.translated_text } : seg]);
            });
            setPartials((p) => ({ ...p, [msg.source]: undefined }));
          } else if (!msg.isFinal) {
            setPartials((p) => ({ ...p, [msg.source]: { speaker: msg.speaker, text: msg.text } }));
          }
          return;
        }
        case "translation": {
          if (!msg.meetingId || msg.meetingId !== selectedRef.current) return;
          if (msg.isFinal && msg.segmentId) {
            const segmentId = msg.segmentId;
            setSegments((prev) =>
              prev.some((s) => s.id === segmentId)
                ? prev.map((s) => (s.id === segmentId ? { ...s, translated_text: msg.text } : s))
                : prev
            );
          } else if (!msg.isFinal) {
            setPartials((p) => {
              const cur = p[msg.source];
              return cur ? { ...p, [msg.source]: { ...cur, translation: msg.text } } : p;
            });
          }
          return;
        }
        case "meeting-ended":
          setListVersion((v) => v + 1);
          if (msg.meetingId === selectedRef.current) {
            setPartials({});
            setTimeout(() => void refreshMeeting(), 400);
          }
          return;
        case "error":
          showBanner("error", msg.message);
          return;
        case "warning":
          showBanner("warning", msg.message);
          return;
      }
    });
  }, [refreshMeeting, showBanner]);

  // ── Actions ──
  const patchMeeting = useCallback(
    async (patch: Parameters<typeof api.updateMeeting>[1], meetingId?: string) => {
      const id = meetingId ?? selectedRef.current;
      if (!id) return;
      setMeeting((m) => (m && m.id === id ? { ...m, ...patch } : m));
      try {
        const updated = await api.updateMeeting(id, patch);
        if (selectedRef.current === id) setMeeting(stripSegments(updated));
        if (patch.title !== undefined) setListVersion((v) => v + 1);
      } catch (err) {
        showBanner("error", `Couldn't save: ${(err as Error).message}`);
      }
    },
    [showBanner]
  );

  const replaceMeeting = useCallback((m: Meeting) => {
    if (m.id !== selectedRef.current) return;
    setMeeting(stripSegments(m));
    setListVersion((v) => v + 1);
  }, []);

  const stopCapture = useCallback(async () => {
    const res = await ext.send({ type: "stop-capture", target: "background", endMeeting: true });
    if (!res.success) showBanner("error", res.error || "Couldn't stop capture");
    setTimeout(() => void refreshMeeting(), 600);
  }, [refreshMeeting, showBanner]);

  const endMeeting = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      replaceMeeting(await api.endMeeting(id));
    } catch (err) {
      showBanner("error", (err as Error).message);
    }
  }, [replaceMeeting, showBanner]);

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "summary", label: "Summary" },
    { id: "ask", label: "Ask" },
    { id: "meetings", label: "Meetings" },
  ];

  return (
    <div className={`app panel ${theme}`}>
      <header className="header">
        <div className="header-logo">
          <img src={logo} alt="" className="header-logo-image" />
        </div>
        <div className="header-text">
          <div className="header-title">Distill</div>
          <div className="header-subtitle">Meeting notes</div>
        </div>
        {session?.isCapturing && (
          <span className="live-pill" title={session.tabTitle || undefined}>
            <span className="live-dot" />
            {session.status === "reconnecting" ? "Reconnecting" : formatDuration(elapsed)}
          </span>
        )}
        <a className="icon-btn" href={BACKEND_HTTP_URL} target="_blank" rel="noreferrer" title="API keys & settings">
          ⚙
        </a>
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme" type="button">
          {theme === "dark" ? "☀︎" : "◗"}
        </button>
      </header>

      {online === false && (
        <div className="banner error">
          <span>Can't reach the Distill backend at localhost:8000.</span>
          <button type="button" onClick={recheck}>
            Retry
          </button>
        </div>
      )}
      {banner && (
        <div className={`banner ${banner.kind}`} role="status">
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <nav className="tab-switcher panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab-switcher-btn ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="panel-body">
        {tab === "live" && (
          <LiveTab
            meeting={meeting}
            segments={segments}
            partials={partials}
            isLive={isLive}
            session={session}
            onPatch={patchMeeting}
            onStop={stopCapture}
            onEndMeeting={endMeeting}
            onShowMeetings={() => setTab("meetings")}
          />
        )}
        {tab === "summary" && (
          <SummaryTab meeting={meeting} isLive={isLive} onMeetingChange={replaceMeeting} onPatch={patchMeeting} />
        )}
        {tab === "ask" && <AskTab meeting={meeting} onOpenMeeting={(id) => selectMeeting(id, "summary")} />}
        {tab === "meetings" && (
          <MeetingsTab
            selectedId={selectedId}
            liveMeetingId={liveMeetingId}
            version={listVersion}
            onSelect={(id, ended) => selectMeeting(id, ended ? "summary" : "live")}
            onDeleted={(id) => {
              if (id === selectedRef.current) selectMeeting(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
