// ── Offscreen Document ──
// Captures tab audio via tabCapture (and optionally your microphone), streams
// 16 kHz Int16 PCM to the service worker, and plays translated audio back
// through a selectable output device (e.g. BlackHole).

import type { OffscreenRequest } from "../shared/protocol";

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: AudioWorkletNode | null = null;
let processorMonitorGain: GainNode | null = null;
// The meeting's own audio. tabCapture mutes the tab, so we play it back through
// this gain: 1 = as usual (notes only), 0 = silent (you hear only the translated
// voice), in between = "quietly underneath". The service worker picks the level.
let tabGain: GainNode | null = null;
let originalLevel = 1;
let playbackContext: AudioContext | null = null;
let playbackElement: HTMLAudioElement | null = null;
let playbackGeneration = 0;
let currentPlaybackUrl: string | null = null;
let fallbackSource: AudioBufferSourceNode | null = null;

// The device ID for translated audio output (e.g. BlackHole)
let outputDeviceId: string | null = null;

type SinkAwareAudioElement = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};
let hasReportedUnsupportedSinkRouting = false;

// Target: 16 kHz mono Int16 PCM (what every STT provider is configured for)
const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const WORKLET_PROCESSOR_NAME = "pcm-capture-worklet";
const CAPTURE_WORKLET_URL = chrome.runtime.getURL("capture-worklet.js");

// ── Audio Processing ──
function downsampleBuffer(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, buffer.length - 1);
    const frac = srcIndex - srcIndexFloor;
    result[i] = buffer[srcIndexFloor] * (1 - frac) + buffer[srcIndexCeil] * frac;
  }
  return result;
}

function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

async function loadCaptureWorklet(context: AudioContext): Promise<void> {
  await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
}

// Audio is sent continuously, silence included: speech providers need the
// pauses for endpointing/diarization, and the steady stream keeps the MV3
// service worker (and its backend WebSocket) alive.
function processCapturedChunk(
  inputData: Float32Array,
  sampleRate: number,
  type: "audio-data" | "mic-audio-data" = "audio-data"
): void {
  const downsampled = downsampleBuffer(inputData, sampleRate, TARGET_SAMPLE_RATE);
  const pcm = floatTo16BitPCM(downsampled);
  chrome.runtime.sendMessage({ type, target: "background", data: Array.from(new Uint8Array(pcm.buffer)) }).catch(() => {
    /* service worker restarting — the next chunk wakes it */
  });
}

function reportError(channel: "capture" | "mic", message: string, fatal = true): void {
  chrome.runtime.sendMessage({ type: "offscreen-error", target: "background", channel, message, fatal }).catch(() => {});
}

function getPlaybackElement(): HTMLAudioElement {
  if (!playbackElement) {
    playbackElement = new Audio();
    playbackElement.preload = "auto";
  }
  return playbackElement;
}

function detectAudioMimeType(bytes: Uint8Array): string {
  const isWav =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45;
  return isWav ? "audio/wav" : "audio/mpeg"; // non-WAV = MiniMax MP3
}

function clearPlaybackObjectUrl(): void {
  if (currentPlaybackUrl) {
    URL.revokeObjectURL(currentPlaybackUrl);
    currentPlaybackUrl = null;
  }
}

function stopPlaybackElement(): void {
  if (!playbackElement) return;
  playbackElement.pause();
  playbackElement.removeAttribute("src");
  playbackElement.load();
  clearPlaybackObjectUrl();
}

async function applyPlaybackSink(element: HTMLAudioElement, deviceId: string): Promise<void> {
  const sinkAware = element as SinkAwareAudioElement;
  if (typeof sinkAware.setSinkId !== "function") {
    if (!hasReportedUnsupportedSinkRouting) {
      hasReportedUnsupportedSinkRouting = true;
      reportError("capture", "Per-device output routing is unsupported in this browser. Using the system default output.", false);
    }
    return;
  }
  try {
    await sinkAware.setSinkId(deviceId);
  } catch (err) {
    console.error("[Offscreen] Failed to set sink ID:", err);
    reportError("capture", "Couldn't route translated audio to the selected output device. Using the system default output.", false);
  }
}

// ── Set Output Device ──
function setOutputDevice(deviceId: string): void {
  outputDeviceId = deviceId || null;
  if (playbackElement) {
    if (deviceId) {
      void applyPlaybackSink(playbackElement, deviceId);
    } else {
      const sinkAware = playbackElement as SinkAwareAudioElement;
      if (typeof sinkAware.setSinkId === "function") {
        sinkAware.setSinkId("").catch((err: Error) => console.error("[Offscreen] Failed to reset sink ID:", err));
      }
    }
  }
}

// ── Tab capture ──
async function startCapture(
  streamId: string,
  initialOutputDeviceId: string | null,
  level: number
): Promise<{ success: boolean; error?: string }> {
  try {
    stopCapture();
    setOutputDevice(initialOutputDeviceId || "");

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      } as any,
    });

    audioContext = new AudioContext({ sampleRate: 48000 });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // tabCapture mutes the tab for the user; play the meeting back through a gain:
    // silent (or quietly underneath) while a translated voice replaces it, full
    // volume in notes-only mode or when no translated voice is available.
    tabGain = audioContext.createGain();
    originalLevel = clampLevel(level);
    tabGain.gain.value = originalLevel;
    sourceNode.connect(tabGain);
    tabGain.connect(audioContext.destination);

    if (!audioContext.audioWorklet) {
      throw new Error("AudioWorklet is not available in this browser");
    }
    await loadCaptureWorklet(audioContext);

    processorNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { chunkSize: BUFFER_SIZE },
    });
    sourceNode.connect(processorNode);
    processorMonitorGain = audioContext.createGain();
    processorMonitorGain.gain.value = 0;
    processorNode.connect(processorMonitorGain);
    processorMonitorGain.connect(audioContext.destination);

    processorNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (event.data instanceof Float32Array && audioContext) {
        processCapturedChunk(event.data, audioContext.sampleRate);
      }
    };

    mediaStream.getAudioTracks()[0]?.addEventListener("ended", () => {
      reportError("capture", "Tab audio capture ended (the tab was closed or navigated).");
    });

    console.log("[Offscreen] Capture started (original level=%s)", originalLevel);
    return { success: true };
  } catch (err) {
    console.error("[Offscreen] Capture error:", err);
    stopCapture();
    return { success: false, error: `Capture failed: ${err instanceof Error ? err.message : err}` };
  }
}

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
}

/** Glide to the new level: quick when lowering, slower when raising (no clicks). */
function setOriginalLevel(level: number): void {
  originalLevel = clampLevel(level);
  if (!audioContext || !tabGain) return;
  const now = audioContext.currentTime;
  tabGain.gain.cancelScheduledValues(now);
  tabGain.gain.setTargetAtTime(originalLevel, now, originalLevel < tabGain.gain.value ? 0.06 : 0.25);
}

function stopCapture(): void {
  if (processorNode) processorNode.port.onmessage = null;
  processorNode?.disconnect();
  processorMonitorGain?.disconnect();
  tabGain?.disconnect();
  sourceNode?.disconnect();
  audioContext?.close().catch(() => {});
  mediaStream?.getTracks().forEach((t) => t.stop());
  processorNode = null;
  processorMonitorGain = null;
  tabGain = null;
  sourceNode = null;
  audioContext = null;
  mediaStream = null;
}

// ── Microphone capture (your own voice in the meeting notes) ──
let micStream: MediaStream | null = null;
let micContext: AudioContext | null = null;
let micNode: AudioWorkletNode | null = null;
let micSourceNode: MediaStreamAudioSourceNode | null = null;
let micSink: GainNode | null = null;

async function startMicCapture(): Promise<{ success: boolean; error?: string }> {
  stopMicCapture();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    return {
      success: false,
      error:
        name === "NotAllowedError"
          ? "microphone permission not granted"
          : `microphone unavailable (${err instanceof Error ? err.message : err})`,
    };
  }
  try {
    micContext = new AudioContext({ sampleRate: 48000 });
    await loadCaptureWorklet(micContext);
    micSourceNode = micContext.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micContext, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { chunkSize: BUFFER_SIZE },
    });
    micSourceNode.connect(micNode);
    micSink = micContext.createGain();
    micSink.gain.value = 0; // keep the graph pulling without playing your voice back
    micNode.connect(micSink);
    micSink.connect(micContext.destination);
    micNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (event.data instanceof Float32Array && micContext) {
        processCapturedChunk(event.data, micContext.sampleRate, "mic-audio-data");
      }
    };
    micStream.getAudioTracks()[0]?.addEventListener("ended", () => reportError("mic", "Microphone disconnected"));
    console.log("[Offscreen] Mic capture started");
    return { success: true };
  } catch (err) {
    stopMicCapture();
    return { success: false, error: `microphone pipeline failed (${err instanceof Error ? err.message : err})` };
  }
}

function stopMicCapture(): void {
  if (micNode) micNode.port.onmessage = null;
  micNode?.disconnect();
  micSink?.disconnect();
  micSourceNode?.disconnect();
  micContext?.close().catch(() => {});
  micStream?.getTracks().forEach((t) => t.stop());
  micNode = null;
  micSink = null;
  micSourceNode = null;
  micContext = null;
  micStream = null;
}

// ── Translated audio playback ──

async function playUsingAudioElement(bytes: Uint8Array, generation: number): Promise<void> {
  const element = getPlaybackElement();
  if (outputDeviceId) {
    await applyPlaybackSink(element, outputDeviceId);
  }
  if (generation !== playbackGeneration) return;

  stopPlaybackElement();

  const audioBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([audioBuffer], { type: detectAudioMimeType(bytes) });
  const url = URL.createObjectURL(blob);
  currentPlaybackUrl = url;
  element.src = url;
  element.currentTime = 0;
  element.onended = () => {
    if (currentPlaybackUrl === url) stopPlaybackElement();
  };
  element.onerror = () => {
    if (currentPlaybackUrl === url) stopPlaybackElement();
  };

  await element.play();
  if (generation !== playbackGeneration) {
    stopPlaybackElement();
  }
}

/** Parse a RIFF/WAVE header → sample rate + data range (null if not a WAV). */
function parseWavHeader(bytes: Uint8Array): { sampleRate: number; dataOffset: number; dataSize: number } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return null;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 16000;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      sampleRate = view.getUint32(offset + 12, true);
    } else if (chunkId === "data") {
      const dataOffset = offset + 8;
      return { sampleRate, dataOffset, dataSize: Math.min(chunkSize, bytes.length - dataOffset) };
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  return null;
}

async function playUsingAudioContextFallback(bytes: Uint8Array, generation: number): Promise<void> {
  try {
    if (!playbackContext || playbackContext.state === "closed") {
      playbackContext = new AudioContext();
    }
    if (playbackContext.state === "suspended") {
      await playbackContext.resume();
    }
    // Use the WAV's declared sample rate; a hard-coded rate plays 16 kHz audio
    // at the wrong speed.
    const parsed = parseWavHeader(bytes);
    const sampleRate = parsed ? parsed.sampleRate : 16000;
    const pcmOffset = parsed ? parsed.dataOffset : 0;
    const pcmByteLength = parsed ? parsed.dataSize : bytes.length;
    if (pcmByteLength < 2) return;

    const frameCount = pcmByteLength >> 1;
    const float32 = new Float32Array(frameCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset + pcmOffset, pcmByteLength);
    for (let i = 0; i < frameCount; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }
    if (generation !== playbackGeneration) return;

    if (fallbackSource) {
      try {
        fallbackSource.stop();
      } catch {
        /* already stopped */
      }
      fallbackSource.disconnect();
      fallbackSource = null;
    }

    const buffer = playbackContext.createBuffer(1, frameCount, sampleRate);
    buffer.getChannelData(0).set(float32);
    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);
    fallbackSource = source;
    source.onended = () => {
      if (fallbackSource === source) fallbackSource = null;
    };
    source.start();
  } catch (err) {
    console.error("[Offscreen] Playback fallback error:", err);
  }
}

// Translated utterances arrive as separate WAV chunks; play them back-to-back.
const playbackQueue: Uint8Array[] = [];
let playbackBusy = false;

async function playNextInQueue(): Promise<void> {
  if (playbackBusy) return;
  const bytes = playbackQueue.shift();
  if (!bytes) return;

  playbackBusy = true;
  const generation = ++playbackGeneration;
  const element = getPlaybackElement();
  const onDone = () => {
    element.removeEventListener("ended", onDone);
    element.removeEventListener("error", onDone);
    playbackBusy = false;
    queueMicrotask(() => void playNextInQueue());
  };
  element.addEventListener("ended", onDone);
  element.addEventListener("error", onDone);

  try {
    await playUsingAudioElement(bytes, generation);
  } catch (err) {
    console.warn("[Offscreen] Audio element playback failed; trying PCM fallback:", err);
    element.removeEventListener("ended", onDone);
    element.removeEventListener("error", onDone);
    await playUsingAudioContextFallback(bytes, generation);
    const fallback = fallbackSource;
    if (fallback) {
      const prevOnEnded = fallback.onended;
      fallback.onended = (ev: Event) => {
        if (typeof prevOnEnded === "function") prevOnEnded.call(fallback, ev);
        playbackBusy = false;
        queueMicrotask(() => void playNextInQueue());
      };
    } else {
      playbackBusy = false;
      queueMicrotask(() => void playNextInQueue());
    }
  }
}

function playTranslatedAudio(audioData: number[]): void {
  playbackQueue.push(new Uint8Array(audioData));
  void playNextInQueue();
}

function stopPlayback(): void {
  playbackQueue.length = 0;
  playbackGeneration++;
  stopPlaybackElement();
  playbackBusy = false;
}

// ── Message Listener ──
chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;

  switch (message.type) {
    case "start-capture":
      void startCapture(message.streamId, message.outputDeviceId, message.originalLevel).then(sendResponse);
      return true;
    case "stop-capture":
      stopCapture();
      stopMicCapture();
      stopPlayback();
      sendResponse({ success: true });
      return false;
    case "start-mic-capture":
      void startMicCapture().then(sendResponse);
      return true;
    case "stop-mic-capture":
      stopMicCapture();
      sendResponse({ success: true });
      return false;
    case "set-original-level":
      setOriginalLevel(message.level);
      sendResponse({ success: true });
      return false;
    case "translated-audio":
      playTranslatedAudio(message.data);
      sendResponse({ success: true });
      return false;
    case "set-output-device":
      setOutputDevice(message.deviceId || "");
      sendResponse({ success: true });
      return false;
  }
  return false;
});
