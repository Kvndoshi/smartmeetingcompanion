// REST client for the local backend (meetings, summaries, chat, providers).
import { BACKEND_HTTP_URL } from "./config";
import type { ChatEvent, ChatMessage, Meeting, MeetingSummary, ProvidersStatus } from "./protocol";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_HTTP_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  } catch {
    throw new ApiError("Can't reach the Distill backend at localhost:8000. Is it running?", 0);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body?.detail || body?.error || (typeof body === "string" ? body : res.statusText);
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string }>("/health"),
  providers: () => request<ProvidersStatus>("/api/providers"),
  listMeetings: (q?: string) =>
    request<{ meetings: Meeting[] }>(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.meetings),
  getMeeting: (id: string, afterId = 0) =>
    request<Meeting>(`/api/meetings/${encodeURIComponent(id)}${afterId ? `?after_id=${afterId}` : ""}`),
  updateMeeting: (id: string, patch: Partial<Pick<Meeting, "title" | "user_notes" | "speaker_names" | "summary_language">>) =>
    request<Meeting>(`/api/meetings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMeeting: (id: string) => request<{ deleted: string }>(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  endMeeting: (id: string) => request<Meeting>(`/api/meetings/${encodeURIComponent(id)}/end`, { method: "POST" }),
  summarize: (id: string, language?: string) =>
    request<{ summary: MeetingSummary; meeting: Meeting }>(`/api/meetings/${encodeURIComponent(id)}/summarize`, {
      method: "POST",
      body: JSON.stringify(language ? { language } : {}),
    }),
  exportMarkdown: async (id: string, transcript = true): Promise<string> => {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/meetings/${encodeURIComponent(id)}/export.md?transcript=${transcript}`);
    if (!res.ok) throw new ApiError(`Export failed (${res.status})`, res.status);
    return res.text();
  },
  syncMemory: (id: string) =>
    request<{ status: string; meeting: Meeting }>(`/api/meetings/${encodeURIComponent(id)}/sync-memory`, { method: "POST" }),
  chatHistory: (meetingId: string | null) =>
    request<{ messages: ChatMessage[] }>(`/api/chat/history${meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : ""}`).then(
      (r) => r.messages
    ),
  clearChat: (meetingId: string | null) =>
    request<{ cleared: boolean }>(`/api/chat/history${meetingId ? `?meeting_id=${encodeURIComponent(meetingId)}` : ""}`, {
      method: "DELETE",
    }),
};

/** Stream a chat answer (Server-Sent Events over a POST). */
export async function streamChat(
  body: { question: string; meeting_id?: string | null; scope: "meeting" | "all"; tab_url?: string | null },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_HTTP_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    onEvent({ type: "error", message: "Can't reach the Distill backend at localhost:8000. Is it running?" });
    return;
  }
  if (!res.ok || !res.body) {
    let message = `Chat failed (${res.status})`;
    try {
      const data = await res.json();
      message = data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : message;
    } catch {
      /* keep default */
    }
    onEvent({ type: "error", message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)) as ChatEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    }
  }
}
