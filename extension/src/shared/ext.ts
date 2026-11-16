// Thin adapter over chrome.* for UI pages. Without the extension runtime (e.g. the
// built side panel served from a localhost static server for testing) every call
// degrades to a harmless no-op so the backend-driven UI still works.
import type { BackgroundRequest, BackgroundResponse, SessionState, UiMessage } from "./protocol";

const hasRuntime = typeof chrome !== "undefined" && !!chrome.runtime?.id;

export const ext = {
  available: hasRuntime,

  send(message: BackgroundRequest): Promise<BackgroundResponse> {
    if (!hasRuntime) return Promise.resolve({ success: false, error: "Extension runtime unavailable" });
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response?: BackgroundResponse) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ success: false, error: err.message });
        else resolve(response ?? { success: false, error: "No response from background" });
      });
    });
  },

  async getState(): Promise<SessionState | null> {
    const res = await ext.send({ type: "get-state", target: "background" });
    return res.state ?? null;
  },

  onUiMessage(handler: (msg: UiMessage) => void): () => void {
    if (!hasRuntime) return () => {};
    const listener = (msg: any) => {
      if (msg && msg.target === "ui") handler(msg as UiMessage);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  },

  async storageGet<T extends Record<string, unknown>>(keys: string[]): Promise<Partial<T>> {
    if (!hasRuntime) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(`distill:${k}`);
          if (v !== null) out[k] = JSON.parse(v);
        } catch {
          /* storage unavailable */
        }
      }
      return out as Partial<T>;
    }
    return (await chrome.storage.sync.get(keys)) as Partial<T>;
  },

  storageSet(values: Record<string, unknown>): void {
    if (!hasRuntime) {
      for (const [k, v] of Object.entries(values)) {
        try {
          localStorage.setItem(`distill:${k}`, JSON.stringify(v));
        } catch {
          /* storage unavailable */
        }
      }
      return;
    }
    void chrome.storage.sync.set(values);
  },

  async activeTab(): Promise<{ id?: number; url?: string; title?: string; windowId?: number } | null> {
    if (!hasRuntime) return { url: location.href, title: document.title };
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ?? null;
  },

  /** Must be called synchronously inside a click handler (user gesture). */
  openSidePanel(windowId: number | undefined): Promise<void> {
    if (!hasRuntime || !chrome.sidePanel || windowId === undefined) return Promise.resolve();
    return chrome.sidePanel.open({ windowId });
  },

  openTab(path: string): void {
    if (!hasRuntime) {
      window.open(path, "_blank");
      return;
    }
    void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  },
};
