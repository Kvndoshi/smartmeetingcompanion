/**
 * meet-bridge.ts — Isolated-world content script for Google Meet
 *
 * Bridges communication between:
 *   - meet-interceptor.ts  (main world, via window.postMessage)
 *   - background.ts        (service worker, via the "mic-capture" port)
 *
 * Only outgoing voice translation flows through here: your mic PCM goes up the
 * port, translated audio comes back down for injection into the call.
 * Transcripts and status reach the widget / side panel straight from the
 * service worker as `target: "ui"` broadcasts.
 */

const LOG_PREFIX = "[meet-bridge]";
const MSG_SOURCE = "interpreter-ext";
const PORT_NAME = "mic-capture";

let micPort: chrome.runtime.Port | null = null;

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, ...args);
}

/** Post a typed message to the main-world interceptor. */
function postToInterceptor(type: string, extra?: Record<string, unknown>): void {
  window.postMessage({ source: MSG_SOURCE, type, ...extra }, "*");
}

// ── Port lifecycle ───────────────────────────────────────────────────────────

function activateMicCapture(): void {
  if (!micPort) {
    try {
      micPort = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      warn("Failed to open port to background:", err);
      reportActivation(false, "Distill was updated — reload this Meet tab.");
      return;
    }
    const port = micPort;
    port.onMessage.addListener((msg: Record<string, unknown>) => {
      if (msg?.type === "mic-translated-audio" && Array.isArray(msg.data)) {
        postToInterceptor("interpreter-translated-audio", { data: msg.data });
      }
    });
    port.onDisconnect.addListener(() => {
      if (micPort !== port) return;
      micPort = null;
      // Stop feeding PCM and restore the real mic in the call.
      postToInterceptor("interpreter-deactivate");
    });
  }
  // (Re)signal the interceptor; it answers with interpreter-activation-result.
  postToInterceptor("interpreter-activate");
}

function deactivateMicCapture(): void {
  postToInterceptor("interpreter-deactivate");
  const port = micPort;
  micPort = null;
  try {
    port?.disconnect();
  } catch {
    /* already gone */
  }
}

function reportActivation(ok: boolean, message?: string): Promise<void> {
  return chrome.runtime.sendMessage({ type: "outgoing-status", target: "background", ok, message }).then(
    () => undefined,
    () => undefined
  );
}

// ── Commands from the service worker ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  switch (message?.type) {
    case "mic-interceptor-activate":
      activateMicCapture();
      sendResponse({ success: true });
      return;
    case "mic-interceptor-deactivate":
      deactivateMicCapture();
      sendResponse({ success: true });
      return;
    default:
      return; // not ours — let the widget's listener handle it
  }
});

// ── Messages from the main-world interceptor ─────────────────────────────────

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as Record<string, unknown> | null | undefined;
  if (!msg || msg.source !== MSG_SOURCE) return;

  switch (msg.type) {
    case "interpreter-mic-pcm": {
      if (!micPort) return; // not active — drop rather than queue unboundedly
      const buffer = msg.data;
      if (!(buffer instanceof ArrayBuffer)) return;
      // Port messaging can't transfer ArrayBuffers; send a plain number[].
      try {
        micPort.postMessage({ type: "mic-audio-data", data: Array.from(new Uint8Array(buffer)) });
      } catch (err) {
        warn("Failed to post PCM to background port:", err);
        micPort = null;
        postToInterceptor("interpreter-deactivate");
      }
      return;
    }
    case "interpreter-activation-result": {
      const ok = msg.ok === true;
      const message = typeof msg.message === "string" ? msg.message : undefined;
      // On failure, disconnect only after the service worker has the reason —
      // otherwise the port drop can stop translation silently, without the error.
      const reported = reportActivation(ok, message);
      if (!ok) void reported.then(() => deactivateMicCapture());
      return;
    }
    default:
      return;
  }
});

log("Bridge installed and ready");
