/**
 * meet-bridge.ts — Isolated-world content script for Google Meet
 *
 * Bridges communication between:
 *   - meet-interceptor.ts  (main world, via window.postMessage)
 *   - background.ts        (service worker, via chrome.runtime.connect port)
 *
 * This script runs in the extension's isolated world and therefore has full
 * access to chrome.* APIs while being sandboxed from the page's JS context.
 */

const LOG_PREFIX = "[meet-bridge]";
const MSG_SOURCE = "interpreter-ext";
const PORT_NAME = "mic-capture";

let micPort: chrome.runtime.Port | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, ...args);
}

// ── Port lifecycle ───────────────────────────────────────────────────────────

function activateMicCapture(): void {
  if (micPort) {
    // Port already open — just re-signal the interceptor to activate in case
    // it missed a previous message (e.g. page reload within same session).
    log("Port already open, re-signalling interceptor activate");
    postToInterceptor("interpreter-activate");
    return;
  }

  log("Opening port to background:", PORT_NAME);
  try {
    micPort = chrome.runtime.connect({ name: PORT_NAME });
  } catch (err) {
    warn("Failed to open port to background:", err);
    return;
  }

  micPort.onMessage.addListener((msg: Record<string, unknown>) => {
    handlePortMessage(msg);
  });

  micPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      warn("Port disconnected with error:", err.message);
    } else {
      log("Port disconnected by background");
    }
    micPort = null;
    // Inform the interceptor so it stops feeding PCM frames.
    postToInterceptor("interpreter-deactivate");
  });

  // Signal the interceptor to begin capturing.
  postToInterceptor("interpreter-activate");
  log("Mic capture activated");
}

function deactivateMicCapture(): void {
  log("Deactivating mic capture");
  // Signal the interceptor first so it stops sending PCM before we drop the port.
  postToInterceptor("interpreter-deactivate");

  if (micPort) {
    try {
      micPort.disconnect();
    } catch (err) {
      warn("Error disconnecting port:", err);
    }
    micPort = null;
  }
}

// ── Port message handler ─────────────────────────────────────────────────────

function handlePortMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "mic-translated-audio":
      // Forward translated PCM audio back to the interceptor for injection.
      postToInterceptor("interpreter-translated-audio", { data: msg.data });
      break;

    case "mic-transcript":
      // Forward transcript text to the widget / popup via chrome messaging.
      forwardTranscript(
        msg.isFinal ? "mic-transcript-final" : "mic-transcript-partial",
        typeof msg.text === "string" ? msg.text : ""
      );
      break;

    case "mic-translated-text":
      forwardTranslatedText("mic-translated-text", typeof msg.text === "string" ? msg.text : "");
      break;

    case "mic-translated-text-partial":
      forwardTranslatedText(
        "mic-translated-text-partial",
        typeof msg.text === "string" ? msg.text : ""
      );
      break;

    default:
      warn("Unhandled port message type:", msg.type);
  }
}

// ── window.postMessage helpers ───────────────────────────────────────────────

/**
 * Post a typed message to the main-world interceptor.
 * All messages carry `source: MSG_SOURCE` so the interceptor can filter them
 * from Meet's own messages.
 */
function postToInterceptor(type: string, extra?: Record<string, unknown>): void {
  window.postMessage({ source: MSG_SOURCE, type, ...extra }, "*");
}

// ── chrome.runtime.sendMessage helpers ──────────────────────────────────────

function forwardTranscript(type: string, text: string): void {
  chrome.runtime
    .sendMessage({ type, target: "popup", text })
    .catch(() => {
      // Popup may be closed — silently ignore.
    });
}

function forwardTranslatedText(type: string, text: string): void {
  chrome.runtime
    .sendMessage({ type, target: "popup", text })
    .catch(() => {});
}

// ── chrome.runtime.onMessage — activation commands from background ───────────

chrome.runtime.onMessage.addListener(
  (message: Record<string, unknown>, _sender, sendResponse) => {
    switch (message.type) {
      case "mic-interceptor-activate":
        activateMicCapture();
        sendResponse({ success: true });
        break;

      case "mic-interceptor-deactivate":
        deactivateMicCapture();
        sendResponse({ success: true });
        break;

      default:
        // Not our message — let other listeners handle it.
        return;
    }
  }
);

// ── window 'message' — incoming PCM / events from main-world interceptor ────

window.addEventListener("message", (event: MessageEvent) => {
  // Ignore messages that didn't come from this window (e.g. cross-origin iframes).
  if (event.source !== window) return;

  const msg = event.data as Record<string, unknown> | null | undefined;
  if (!msg || msg.source !== MSG_SOURCE) return;

  switch (msg.type) {
    case "interpreter-mic-pcm": {
      if (!micPort) {
        // Port not open yet — drop the frame rather than queue unboundedly.
        return;
      }
      const buffer = msg.data;
      if (!(buffer instanceof ArrayBuffer)) {
        warn("interpreter-mic-pcm: expected ArrayBuffer, got", typeof buffer);
        return;
      }
      // chrome port messaging cannot transfer ArrayBuffers directly; serialise
      // to a plain number[] so the background can reconstruct a Uint8Array.
      try {
        micPort.postMessage({
          type: "mic-audio-data",
          data: Array.from(new Uint8Array(buffer)),
        });
      } catch (err) {
        warn("Failed to post PCM to background port:", err);
        // Port may have been invalidated — clear our reference.
        micPort = null;
        postToInterceptor("interpreter-deactivate");
      }
      break;
    }

    case "interpreter-track-attached":
      // Notify background that the interceptor successfully hooked an audio track.
      chrome.runtime
        .sendMessage({ type: "mic-track-attached", target: "background" })
        .catch(() => {});
      break;

    default:
      // Ignore unknown message types from the interceptor.
      break;
  }
});

log("Bridge installed and ready");
