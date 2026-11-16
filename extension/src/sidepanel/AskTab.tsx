import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, streamChat } from "../shared/api";
import type { ChatMessage, ChatSource, Meeting } from "../shared/protocol";

interface Props {
  meeting: Omit<Meeting, "segments"> | null;
  onOpenMeeting: (id: string) => void;
}

type Scope = "meeting" | "all";
type UiMessage = ChatMessage & { error?: boolean; streaming?: boolean };

const MEETING_SUGGESTIONS = [
  "What decisions were made?",
  "List the action items with owners and due dates.",
  "What questions are still open?",
  "What did I commit to?",
];
const ALL_SUGGESTIONS = [
  "What did we decide across my recent meetings?",
  "Which action items are assigned to me?",
  "When did we last discuss the launch date?",
];

/** Render **bold** spans inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>
  );
}

/** Minimal Markdown (paragraphs, bullet/numbered lists, bold) without innerHTML. */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length}>
        {list.items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </Tag>
    );
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet || numbered)![1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(heading ? <p key={blocks.length} className="rt-heading">{inline(heading[1])}</p> : <p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="rich-text">{blocks}</div>;
}

function Sources({ sources, currentId, onOpenMeeting }: { sources: ChatSource[]; currentId: string | null; onOpenMeeting: (id: string) => void }) {
  const shown = sources.filter((s) => s.title || s.excerpt);
  if (!shown.length) return null;
  return (
    <div className="chat-sources">
      {shown.map((s, i) => {
        const openable = !!s.meeting_id && s.meeting_id !== currentId;
        return (
          <button
            key={`${s.id}-${i}`}
            type="button"
            className={`source-chip ${openable ? "openable" : ""}`}
            title={s.excerpt?.slice(0, 400) || s.title || ""}
            onClick={() => openable && onOpenMeeting(s.meeting_id!)}
          >
            {s.kind === "memory" ? "🧠" : "📝"} {s.title || "Source"}
          </button>
        );
      })}
    </div>
  );
}

export default function AskTab({ meeting, onOpenMeeting }: Props) {
  const [scope, setScope] = useState<Scope>(meeting ? "meeting" : "all");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const effectiveScope: Scope = meeting ? scope : "all";
  const historyKey = effectiveScope === "meeting" ? meeting?.id ?? null : null;

  useEffect(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setHistoryError("");
    let alive = true;
    api
      .chatHistory(historyKey)
      .then((msgs) => alive && setMessages(msgs))
      .catch((err: Error) => {
        if (!alive) return;
        setMessages([]);
        setHistoryError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [historyKey, effectiveScope]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateLast = (fn: (m: UiMessage) => UiMessage) =>
    setMessages((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev));

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || streaming) return;
    setInput("");
    setStreaming(true);
    setMessages((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "", sources: [], streaming: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        { question: q, scope: effectiveScope, meeting_id: meeting?.id ?? null, tab_url: meeting?.tab_url ?? null },
        (event) => {
          if (controller.signal.aborted) return;
          switch (event.type) {
            case "sources":
              updateLast((m) => ({ ...m, sources: event.sources }));
              break;
            case "delta":
              updateLast((m) => ({ ...m, content: m.content + event.text }));
              break;
            case "error":
              updateLast((m) => ({ ...m, content: event.message, error: true, streaming: false }));
              break;
            case "done":
              updateLast((m) => ({ ...m, id: event.message_id, streaming: false }));
              break;
          }
        },
        controller.signal
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") updateLast((m) => ({ ...m, content: (err as Error).message, error: true }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(false);
        updateLast((m) => (m.streaming ? { ...m, streaming: false, content: m.content || "No answer received." } : m));
      }
    }
  };

  const clear = async () => {
    abortRef.current?.abort();
    try {
      await api.clearChat(historyKey);
      setMessages([]);
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  };

  const suggestions = effectiveScope === "meeting" ? MEETING_SUGGESTIONS : ALL_SUGGESTIONS;

  return (
    <div className="ask-tab">
      <div className="ask-toolbar">
        <div className="memory-scope-switch" role="tablist" aria-label="Chat scope">
          <button
            className={`memory-scope-btn ${effectiveScope === "meeting" ? "active" : ""}`}
            type="button"
            onClick={() => setScope("meeting")}
            disabled={!meeting}
            role="tab"
            aria-selected={effectiveScope === "meeting"}
            title={meeting ? meeting.title : "Select a meeting first"}
          >
            This meeting
          </button>
          <button
            className={`memory-scope-btn ${effectiveScope === "all" ? "active" : ""}`}
            type="button"
            onClick={() => setScope("all")}
            role="tab"
            aria-selected={effectiveScope === "all"}
          >
            All meetings
          </button>
        </div>
        {messages.length > 0 && (
          <button className="link-btn" type="button" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      <div className="chat-log" ref={scrollRef}>
        {historyError && <div className="inline-error">{historyError}</div>}
        {messages.length === 0 && !historyError && (
          <div className="chat-empty">
            <p>
              {effectiveScope === "meeting"
                ? "Ask anything about this meeting — answers come from the transcript, summary and your notes."
                : "Search across every meeting Distill has captured (via Supermemory when configured)."}
            </p>
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id ?? `local-${i}`} className={`chat-msg ${m.role} ${m.error ? "error" : ""}`}>
            {m.role === "assistant" ? (
              <>
                {m.content ? <RichText text={m.content} /> : <span className="typing">Thinking…</span>}
                {!m.error && m.sources && m.sources.length > 0 && !m.streaming && (
                  <Sources sources={m.sources} currentId={meeting?.id ?? null} onOpenMeeting={onOpenMeeting} />
                )}
              </>
            ) : (
              m.content
            )}
          </div>
        ))}
      </div>

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <textarea
          className="memory-input"
          rows={2}
          value={input}
          maxLength={4000}
          placeholder={effectiveScope === "meeting" ? "Ask about this meeting…" : "Ask about all your meetings…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        <button className="memory-submit" type="submit" disabled={streaming || !input.trim()}>
          {streaming ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
