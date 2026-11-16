import { useEffect, useState } from "react";
import { api } from "../shared/api";
import type { Meeting } from "../shared/protocol";

interface Props {
  selectedId: string | null;
  liveMeetingId: string | null;
  version: number;
  onSelect: (id: string, ended: boolean) => void;
  onDeleted: (id: string) => void;
}

function durationLabel(m: Meeting): string {
  const end = m.ended_at ?? (m.status === "live" ? Date.now() / 1000 : null);
  if (!end) return "";
  const mins = Math.max(0, Math.round((end - m.started_at) / 60));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export default function MeetingsTab({ selectedId, liveMeetingId, version, onSelect, onDeleted }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listMeetings(debounced || undefined)
      .then((list) => {
        if (!alive) return;
        setMeetings(list);
        setError("");
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [debounced, version, reloadKey]);

  useEffect(() => {
    if (!confirmId) return;
    const id = setTimeout(() => setConfirmId(null), 4000);
    return () => clearTimeout(id);
  }, [confirmId]);

  const remove = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    try {
      await api.deleteMeeting(id);
      setMeetings((list) => list.filter((m) => m.id !== id));
      onDeleted(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="meetings-tab">
      <div className="search-row">
        <input
          className="search-input"
          type="search"
          value={query}
          placeholder="Search titles and transcripts…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search meetings"
        />
        <button className="icon-btn" type="button" onClick={() => setReloadKey((k) => k + 1)} title="Refresh">
          ↻
        </button>
      </div>

      {error && <div className="inline-error">{error}</div>}
      {!error && !loading && meetings.length === 0 && (
        <div className="empty-state">
          <p>{debounced ? `No meetings match “${debounced}”.` : "No meetings yet. Start Distill with Take notes on to record one."}</p>
        </div>
      )}

      <ul className="meeting-list">
        {meetings.map((m) => {
          const live = m.id === liveMeetingId;
          return (
            <li key={m.id} className={`meeting-item ${m.id === selectedId ? "selected" : ""}`}>
              <button type="button" className="meeting-item-main" onClick={() => onSelect(m.id, m.status === "ended")}>
                <div className="meeting-item-title">{m.title}</div>
                <div className="meeting-item-meta">
                  <span>{m.platform_label}</span>
                  <span>{new Date(m.started_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                  {durationLabel(m) && <span>{durationLabel(m)}</span>}
                </div>
                <div className="meeting-item-badges">
                  {live && <span className="status-chip live">Live</span>}
                  {!live && m.status === "live" && <span className="status-chip">Open</span>}
                  {m.summary_status === "ready" && <span className="status-chip ok">Summary</span>}
                  {m.summary_status === "pending" && <span className="status-chip">Summarizing…</span>}
                  {m.summary_status === "error" && <span className="status-chip warn">Summary failed</span>}
                  {typeof m.segment_count === "number" && <span className="status-chip muted">{m.segment_count} lines</span>}
                </div>
              </button>
              <button
                type="button"
                className={`delete-btn ${confirmId === m.id ? "confirm" : ""}`}
                onClick={() => void remove(m.id)}
                disabled={live}
                title={live ? "Stop capturing before deleting" : "Delete meeting"}
              >
                {confirmId === m.id ? "Delete?" : "×"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
