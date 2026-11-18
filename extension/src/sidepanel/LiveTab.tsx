import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "../shared/hooks";
import { formatTimestamp, speakerLabel, type Meeting, type Segment, type SessionState, type Source } from "../shared/protocol";
import { langName, langShort, sameLanguage } from "../utils/languages";
import type { LivePartial } from "./App";

interface Props {
  meeting: Omit<Meeting, "segments"> | null;
  segments: Segment[];
  partials: Partial<Record<Source, LivePartial>>;
  isLive: boolean;
  session: SessionState | null;
  onPatch: (
    patch: { title?: string; user_notes?: string; speaker_names?: Record<string, string> },
    meetingId?: string
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onEndMeeting: () => Promise<void>;
  onShowMeetings: () => void;
}

const SPEAKER_COLORS = 6;

export function speakerColorClass(speaker: string | null): string {
  if (speaker === "me") return "spk-me";
  if (!speaker) return "spk-0";
  let hash = 0;
  for (const ch of speaker) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `spk-${(hash % SPEAKER_COLORS) + 1}`;
}

export default function LiveTab({ meeting, segments, partials, isLive, session, onPatch, onStop, onEndMeeting, onShowMeetings }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [notes, setNotes] = useState("");
  const [title, setTitle] = useState("");
  const [showSpeakers, setShowSpeakers] = useState(false);
  const [stopping, setStopping] = useState(false);

  const meetingId = meeting?.id ?? null;
  const names = meeting?.speaker_names ?? {};

  // Reset local editors only when switching meetings (not on every save echo).
  useEffect(() => {
    setNotes(meeting?.user_notes ?? "");
    setTitle(meeting?.title ?? "");
    stickToBottom.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  useEffect(() => {
    if (meeting && document.activeElement?.id !== "meeting-title") setTitle(meeting.title);
  }, [meeting?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // The meeting id travels with the pending save so a flush after switching
  // meetings still writes to the meeting the notes were typed in.
  const saveNotes = useDebouncedCallback((id: string, value: string) => void onPatch({ user_notes: value }, id), 800);
  useEffect(() => saveNotes.flush, [meetingId, saveNotes.flush]);

  const speakers = useMemo(() => {
    const seen = new Set<string>();
    for (const s of segments) if (s.speaker) seen.add(s.speaker);
    return [...seen];
  }, [segments]);

  const partialList = (Object.entries(partials) as [Source, LivePartial | undefined][]).filter(
    (e): e is [Source, LivePartial] => !!e[1]?.text
  );

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments, partials]);

  if (!meeting) {
    return (
      <div className="empty-state">
        <div className="empty-title">No meeting selected</div>
        <p>
          Open your meeting tab (Google Meet, Teams, Zoom web, YouTube…), click the Distill toolbar icon and press{" "}
          <b>Start</b> with <b>Take notes</b> on. The live transcript shows up here.
        </p>
        <button className="ghost-btn" type="button" onClick={onShowMeetings}>
          Browse past meetings
        </button>
      </div>
    );
  }

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== meeting.title) void onPatch({ title: next });
    else setTitle(meeting.title);
  };

  const renameSpeaker = (speaker: string, value: string) => {
    const trimmed = value.trim();
    if ((names[speaker] ?? "") === trimmed) return;
    const next = { ...names };
    if (trimmed) next[speaker] = trimmed;
    else delete next[speaker];
    void onPatch({ speaker_names: next });
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  const providers = isLive ? session?.activeProviders : null;
  const myLang = session?.targetLang ?? null;

  return (
    <div className="live-tab">
      <section className="meeting-head">
        <input
          id="meeting-title"
          className="meeting-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setTitle(meeting.title);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Meeting title"
        />
        <div className="meeting-meta">
          <span className={`status-chip ${meeting.status === "live" ? "live" : ""}`}>
            {meeting.status === "live" ? (isLive ? "Live" : "Open") : "Ended"}
          </span>
          <span>{meeting.platform_label}</span>
          <span>{new Date(meeting.started_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
          {providers?.stt && (
            <span title="Speech-to-text provider">
              {providers.stt}
              {providers.diarization ? " · speakers" : ""}
            </span>
          )}
        </div>
        <div className="meeting-actions">
          {isLive ? (
            <button className="small-btn danger" type="button" onClick={handleStop} disabled={stopping}>
              {stopping ? "Stopping…" : "Stop & summarize"}
            </button>
          ) : (
            meeting.status === "live" && (
              <button className="small-btn" type="button" onClick={() => void onEndMeeting()}>
                End meeting
              </button>
            )
          )}
          {speakers.length > 0 && (
            <button className="small-btn ghost" type="button" onClick={() => setShowSpeakers((v) => !v)}>
              {showSpeakers ? "Hide speakers" : `Speakers (${speakers.length})`}
            </button>
          )}
        </div>
        {showSpeakers && (
          <div className="speaker-editor">
            {speakers.map((spk) => (
              <label key={spk} className="speaker-row">
                <span className={`speaker-badge ${speakerColorClass(spk)}`}>{speakerLabel(spk)}</span>
                <input
                  key={`${meetingId}-${spk}-${names[spk] ?? ""}`}
                  defaultValue={names[spk] ?? ""}
                  placeholder="Name"
                  maxLength={60}
                  onBlur={(e) => renameSpeaker(spk, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="live-transcript" ref={scrollRef} onScroll={onScroll}>
        {segments.length === 0 && partialList.length === 0 && (
          <div className="transcript-empty">
            {isLive ? "Listening… the transcript appears as people speak." : "No transcript for this meeting."}
          </div>
        )}
        {segments.map((seg, i) => {
          const prev = segments[i - 1];
          const lang = seg.language ?? null;
          // A speaker switching language starts a new block so the change is visible.
          const langChanged = !!lang && !!prev?.language && !sameLanguage(prev.language, lang);
          const continued = prev && prev.speaker === seg.speaker && prev.source === seg.source && !langChanged;
          const showChip = !!lang && (langChanged || !myLang || !sameLanguage(lang, myLang));
          return (
            <div key={seg.id} className={`seg ${continued ? "continued" : ""}`}>
              {!continued && (
                <div className="seg-head">
                  <span className={`speaker-name ${speakerColorClass(seg.speaker)}`}>{speakerLabel(seg.speaker, names)}</span>
                  {showChip && (
                    <span className="lang-chip" title={`Spoken in ${langName(lang)}`}>
                      {langShort(lang)}
                    </span>
                  )}
                  <span className="seg-time">{formatTimestamp(seg.start_ms)}</span>
                </div>
              )}
              <div className="seg-text">{seg.text}</div>
              {seg.translated_text && <div className="seg-translation">{seg.translated_text}</div>}
            </div>
          );
        })}
        {partialList.map(([source, p]) => (
          <div key={`partial-${source}`} className="seg partial">
            <div className="seg-head">
              <span className={`speaker-name ${speakerColorClass(source === "mic" ? "me" : p.speaker)}`}>
                {speakerLabel(source === "mic" ? "me" : p.speaker, names)}
              </span>
            </div>
            <div className="seg-text">{p.text}</div>
            {p.translation && <div className="seg-translation">{p.translation}</div>}
          </div>
        ))}
      </div>

      <section className="notes-box">
        <div className="section-label">My notes</div>
        <textarea
          value={notes}
          placeholder="Jot down anything — Distill weaves your notes into the summary."
          onChange={(e) => {
            setNotes(e.target.value);
            saveNotes.call(meeting.id, e.target.value);
          }}
          onBlur={saveNotes.flush}
          rows={4}
          maxLength={50000}
        />
      </section>
    </div>
  );
}
