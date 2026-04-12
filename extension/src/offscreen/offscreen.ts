// ── Offscreen Document ──
// Captures tab audio via tabCapture, extracts PCM chunks,
// plays translated audio back through a selectable output device (e.g. BlackHole).

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: AudioWorkletNode | null = null;
let processorMonitorGain: GainNode | null = null;
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

type SinkAwareAudioContext = AudioContext & {
  setSinkId?: (deviceId: string) => Promise<void>;
};
let hasReportedUnsupportedSinkRouting = false;

// Target: 16kHz mono Int16 PCM for Speechmatics
const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const WORKLET_PROCESSOR_NAME = "pcm-capture-worklet";
const CAPTURE_WORKLET_URL = chrome.runtime.getURL("capture-worklet.js");

// ── Audio Processing ──
function downsampleBuffer(
  buffer: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
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

function processCapturedChunk(inputData: Float32Array, sampleRate: number): void {
  // Check if there's actually audio (skip silence)
  let sum = 0;
  for (let i = 0; i < inputData.length; i++) {
    sum += Math.abs(inputData[i]);
  }
  if (sum / inputData.length < 0.001) return; // Skip near-silence

  // Downsample to 16kHz
  const downsampled = downsampleBuffer(
    inputData,
    sampleRate,
    TARGET_SAMPLE_RATE
  );

  // Convert to Int16 PCM
  const pcm = floatTo16BitPCM(downsampled);

  // Send to service worker
  chrome.runtime.sendMessage({
    type: "audio-data",
    target: "background",
    data: Array.from(new Uint8Array(pcm.buffer)),
  });
}

function getPlaybackElement(): HTMLAudioElement {
  if (!playbackElement) {
    playbackElement = new Audio();
    playbackElement.preload = "auto";
  }
  return playbackElement;
}

function detectAudioMimeType(bytes: Uint8Array): string {
  // RIFF....WAVE
  const isWav =
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45; // E

  if (isWav) return "audio/wav";
  // Default to MP3 for MiniMax.
  return "audio/mpeg";
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

async function applyPlaybackSink(
  element: HTMLAudioElement,
  deviceId: string
): Promise<void> {
  const sinkAware = element as SinkAwareAudioElement;
  if (typeof sinkAware.setSinkId !== "function") {
    console.warn(
      "[Offscreen] HTMLMediaElement.setSinkId is unavailable in this Chrome build"
    );
    if (!hasReportedUnsupportedSinkRouting) {
      hasReportedUnsupportedSinkRouting = true;
      chrome.runtime.sendMessage({
        type: "error",
        target: "background",
        message:
          "Per-device output routing is unsupported in this Chrome build. Using system default output.",
      });
    }
    return;
  }

  try {
    await sinkAware.setSinkId(deviceId);
    console.log("[Offscreen] setSinkId succeeded for:", deviceId);
  } catch (err) {
    console.error("[Offscreen] Failed to set sink ID:", err);
    chrome.runtime.sendMessage({
      type: "error",
      target: "background",
      message:
        "Failed to route translated audio to detected output device. Verify BlackHole is detected and Chrome media permissions are granted.",
    });
  }
}

// ── Set Output Device ──
function setOutputDevice(deviceId: string): void {
  outputDeviceId = deviceId || null;
  // If playback element exists, update its sink
  if (playbackElement) {
    if (deviceId) {
      void applyPlaybackSink(playbackElement, deviceId);
    } else {
      const sinkAware = playbackElement as SinkAwareAudioElement;
      if (typeof sinkAware.setSinkId === "function") {
        sinkAware.setSinkId("").catch((err: Error) => {
          console.error("[Offscreen] Failed to reset sink ID:", err);
        });
      }
    }
  }
  console.log("[Offscreen] Output device set to:", deviceId || "default");
}

// ── Start Capturing ──
async function startCapture(
  streamId: string,
  initialOutputDeviceId?: string
): Promise<void> {
  try {
    if (typeof initialOutputDeviceId === "string") {
      setOutputDevice(initialOutputDeviceId);
    }

    // Get media stream from tab
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

    // Do not passthrough original tab audio.
    // We only capture it for STT so users don't hear untranslated + translated audio together.

    if (!audioContext.audioWorklet) {
      throw new Error("AudioWorklet is not available in this browser");
    }
    await loadCaptureWorklet(audioContext);

    // Extract PCM chunks via AudioWorkletNode
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
      const inputData = event.data;
      if (!(inputData instanceof Float32Array) || !audioContext) return;
      processCapturedChunk(inputData, audioContext.sampleRate);
    };

    console.log("[Offscreen] Capture started");
  } catch (err) {
    console.error("[Offscreen] Capture error:", err);
    chrome.runtime.sendMessage({
      type: "error",
      target: "background",
      message: `Capture failed: ${err}`,
    });
  }
}

// ── Stop Capturing ──
function stopCapture(): void {
  if (processorNode) {
    processorNode.port.onmessage = null;
  }
  processorNode?.disconnect();
  processorMonitorGain?.disconnect();
  sourceNode?.disconnect();
  audioContext?.close();
  mediaStream?.getTracks().forEach((t) => t.stop());

  processorNode = null;
  processorMonitorGain = null;
  sourceNode = null;
  audioContext = null;
  mediaStream = null;

  console.log("[Offscreen] Capture stopped");
}

async function playUsingAudioElement(
  bytes: Uint8Array,
  generation: number
): Promise<void> {
  const element = getPlaybackElement();
  if (outputDeviceId) {
    await applyPlaybackSink(element, outputDeviceId);
  }
  if (generation !== playbackGeneration) return;

  stopPlaybackElement();

  const rawBuffer = bytes.buffer;
  const audioBuffer = rawBuffer instanceof ArrayBuffer
    ? rawBuffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : new Uint8Array(bytes).buffer;
  const mimeType = detectAudioMimeType(bytes);
  const blob = new Blob([audioBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  currentPlaybackUrl = url;
  element.src = url;
  element.currentTime = 0;
  element.onended = () => {
    if (currentPlaybackUrl === url) {
      stopPlaybackElement();
    }
  };
  element.onerror = () => {
    if (currentPlaybackUrl === url) {
      stopPlaybackElement();
    }
  };

  await element.play();
  if (generation !== playbackGeneration) {
    stopPlaybackElement();
    return;
  }
  console.log("[Offscreen] Audio element play() started");
}

/**
 * Parse a RIFF/WAVE header and return the sample rate and data payload
 * slice. If the buffer is not a WAV, return null and let the caller assume
 * the backend-default 16 kHz raw PCM.
 */
function parseWavHeader(bytes: Uint8Array): {
  sampleRate: number;
  dataOffset: number;
  dataSize: number;
} | null {
  if (bytes.length < 12) return null;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return null;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 16000;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      sampleRate = view.getUint32(offset + 12, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize;
  }
  if (dataOffset < 0) return null;
  return { sampleRate, dataOffset, dataSize };
}

async function playUsingAudioContextFallback(
  bytes: Uint8Array,
  generation: number
): Promise<void> {
  try {
    if (!playbackContext || playbackContext.state === "closed") {
      playbackContext = new AudioContext();
    }

    if (playbackContext.state === "suspended") {
      await playbackContext.resume();
    }

    // Detect WAV wrapper and use the declared sample rate + data range.
    // Without this, a hard-coded rate (e.g. 24000) would mismatch Azure's
    // Riff16Khz16BitMonoPcm output and play audio at 1.5× speed — the
    // infamous "mouse voice" bug.
    const parsed = parseWavHeader(bytes);
    const sampleRate = parsed ? parsed.sampleRate : 16000;
    const pcmOffset = parsed ? parsed.dataOffset : 0;
    const pcmByteLength = parsed ? parsed.dataSize : bytes.length;

    if (pcmByteLength < 2) {
      console.warn("[Offscreen] Fallback: empty PCM payload");
      return;
    }

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
        // Ignore if already stopped.
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
      if (fallbackSource === source) {
        fallbackSource = null;
      }
    };
    source.start();
    console.log(
      "[Offscreen] Fallback playing %d samples @ %d Hz (%.2fs)",
      frameCount, sampleRate, frameCount / sampleRate
    );
  } catch (err) {
    console.error("[Offscreen] Playback fallback error:", err);
  }
}

// ── Play Translated Audio (routes to selected output device) ──
//
// We queue incoming audio chunks and play them sequentially. This is
// required because the backend now streams translated text to TTS in
// ~5-word pieces: each piece arrives as its own audio message, and if
// we played them with `playbackGeneration` cancellation, every new
// chunk would cut off the previous one. The queue plays back-to-back
// so the user hears a continuous translated utterance.
const playbackQueue: Uint8Array[] = [];
let playbackBusy = false;

async function playNextInQueue(): Promise<void> {
  if (playbackBusy) return;
  const bytes = playbackQueue.shift();
  if (!bytes) return;

  playbackBusy = true;
  const generation = ++playbackGeneration;

  // Attach a one-shot "done" handler that advances the queue. The
  // HTMLAudioElement emits `ended` on successful completion; `error`
  // fires on decode failure (in which case we fall back to the
  // AudioContext PCM path, which triggers its own `onended`).
  const element = getPlaybackElement();
  const onDone = () => {
    element.removeEventListener("ended", onDone);
    element.removeEventListener("error", onDone);
    playbackBusy = false;
    // Advance. Schedule on a microtask so multiple chunks don't
    // recurse deeply when arriving in quick succession.
    queueMicrotask(() => {
      void playNextInQueue();
    });
  };
  element.addEventListener("ended", onDone);
  element.addEventListener("error", onDone);

  try {
    await playUsingAudioElement(bytes, generation);
  } catch (err) {
    console.warn(
      "[Offscreen] Audio element playback failed; trying PCM fallback:",
      err
    );
    element.removeEventListener("ended", onDone);
    element.removeEventListener("error", onDone);
    await playUsingAudioContextFallback(bytes, generation);
    // The fallback path uses AudioBufferSourceNode whose `onended`
    // callback we hook inside playUsingAudioContextFallback. Here we
    // advance manually once the fallback source finishes — we attach a
    // temporary onended chaining handler.
    const fallback = fallbackSource;
    if (fallback) {
      const prevOnEnded = fallback.onended;
      fallback.onended = (ev: Event) => {
        if (typeof prevOnEnded === "function") {
          prevOnEnded.call(fallback, ev);
        }
        playbackBusy = false;
        queueMicrotask(() => {
          void playNextInQueue();
        });
      };
    } else {
      // No fallback source — unblock immediately.
      playbackBusy = false;
      queueMicrotask(() => {
        void playNextInQueue();
      });
    }
  }
}

function playTranslatedAudio(audioData: number[]): void {
  console.log(
    "[Offscreen] Enqueue translated audio (%d bytes, queue=%d)",
    audioData.length,
    playbackQueue.length + 1
  );
  playbackQueue.push(new Uint8Array(audioData));
  void playNextInQueue();
}

// ── Message Listener ──
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;

  switch (message.type) {
    case "start-capture":
      startCapture(message.streamId, message.outputDeviceId);
      break;
    case "stop-capture":
      stopCapture();
      break;
    case "translated-audio":
      void playTranslatedAudio(message.data);
      break;
    case "set-output-device":
      setOutputDevice(message.deviceId);
      break;
  }
});
