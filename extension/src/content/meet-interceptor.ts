/**
 * Google Meet WebRTC Audio Interceptor — Main World Content Script
 *
 * Runs in "world": "MAIN" at document_start so it patches RTCPeerConnection
 * and RTCRtpSender before Google Meet initialises them.
 *
 * When "Translate My Voice" is active this script:
 *   1. Intercepts the real microphone track before Meet sends it via WebRTC
 *   2. Captures PCM chunks and forwards them to the bridge via postMessage
 *   3. Receives translated audio back and pipes it into a replacement track
 *   4. Meet unknowingly sends the replacement track to other participants
 *
 * NO chrome.* APIs — page context only. All comms via window.postMessage.
 * Do NOT import anything from other extension files — fully self-contained.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface InterpreterMessage {
  source: 'interpreter-ext';
  type: string;
  data?: ArrayBuffer | number[];
}

// ─── State ────────────────────────────────────────────────────────────────────

let active = false;
let realTrack: MediaStreamTrack | null = null;
const senders = new Set<RTCRtpSender>();
const peerConnections = new Set<RTCPeerConnection>();

// Audio pipeline nodes
let audioCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let replacementTrack: MediaStreamTrack | null = null;

// Mirror mute state from real track to replacement track
let enabledObserverInterval: ReturnType<typeof setInterval> | null = null;

// ─── Inline AudioWorklet (Blob URL) ──────────────────────────────────────────

const WORKLET_CODE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = options?.processorOptions?.chunkSize || 4096;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      let srcOffset = 0;
      while (srcOffset < channel.length) {
        const copyLen = Math.min(this.chunkSize - this.offset, channel.length - srcOffset);
        this.buffer.set(channel.subarray(srcOffset, srcOffset + copyLen), this.offset);
        this.offset += copyLen;
        srcOffset += copyLen;
        if (this.offset === this.chunkSize) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.chunkSize);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('interpreter-mic-processor', PCMCaptureProcessor);
`;

function createWorkletBlobUrl(): string {
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

// ─── Audio Helpers ────────────────────────────────────────────────────────────

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

// ─── postMessage helpers ──────────────────────────────────────────────────────

function postOut(msg: Omit<InterpreterMessage, 'source'>, transfer?: Transferable[]): void {
  const full: InterpreterMessage = { source: 'interpreter-ext', ...msg } as InterpreterMessage;
  if (transfer && transfer.length > 0) {
    window.postMessage(full, '*', transfer);
  } else {
    window.postMessage(full, '*');
  }
}

// ─── Audio Pipeline ───────────────────────────────────────────────────────────

// The track the current pipeline was built from (null when torn down).
let pipelineTrack: MediaStreamTrack | null = null;
// Pipeline (re)builds are serialised: Meet can fire addTrack + replaceTrack in
// quick succession, and two overlapping builds would leak an AudioContext.
let pipelineLock: Promise<void> = Promise.resolve();

function setupPipeline(track: MediaStreamTrack): Promise<void> {
  pipelineLock = pipelineLock.then(() => buildPipeline(track)).catch(() => {});
  return pipelineLock;
}

async function buildPipeline(track: MediaStreamTrack): Promise<void> {
  if (pipelineTrack === track && replacementTrack && audioCtx?.state !== 'closed') return;
  try {
    teardownPipeline();

    audioCtx = new AudioContext({ sampleRate: 48000 });

    // Force this AudioContext's output to the "none" sink so nothing from
    // this graph can ever reach the user's speakers — even if Meet (or any
    // other code) inadvertently connects something to audioCtx.destination.
    // The translated audio still reaches remote peers because it flows
    // through MediaStreamAudioDestinationNode, which is independent of the
    // context's speaker sink.
    const ctxWithSink = audioCtx as AudioContext & {
      setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
    };
    if (typeof ctxWithSink.setSinkId === 'function') {
      try {
        await ctxWithSink.setSinkId({ type: 'none' });
      } catch (err) {
        console.warn('[Interceptor] setSinkId({type:"none"}) unsupported:', err);
      }
    }

    const stream = new MediaStream([track]);
    micSource = audioCtx.createMediaStreamSource(stream);

    const workletUrl = createWorkletBlobUrl();
    await audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    workletNode = new AudioWorkletNode(audioCtx, 'interpreter-mic-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { chunkSize: 4096 },
    });

    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const inputData = event.data;
      if (!(inputData instanceof Float32Array) || !audioCtx || !active) return;

      const downsampled = downsampleBuffer(inputData, audioCtx.sampleRate, 16000);
      const pcm = floatTo16BitPCM(downsampled);
      const buffer = pcm.buffer.slice(0) as ArrayBuffer;
      postOut({ type: 'interpreter-mic-pcm', data: buffer }, [buffer]);
    };

    destination = audioCtx.createMediaStreamDestination();

    // Only capture PCM from the mic; the destination (what Meet sends) carries
    // nothing but the translated audio injected by playTranslated().
    micSource.connect(workletNode);

    const destTracks = destination.stream.getAudioTracks();
    if (destTracks.length === 0) {
      throw new Error('[Interceptor] MediaStreamDestination produced no audio tracks');
    }
    replacementTrack = destTracks[0];
    pipelineTrack = track;

    // Mirror enabled (mute) state from the real track
    startEnabledMirror(track);
    console.log('[Interceptor] Audio pipeline ready, replacementTrack:', replacementTrack.id);
  } catch (err) {
    console.error('[Interceptor] Failed to set up audio pipeline — using passthrough:', err);
    teardownPipeline();
  }
}

function teardownPipeline(): void {
  stopEnabledMirror();

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (destination) {
    destination.disconnect();
    destination = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {/* ignore */});
    audioCtx = null;
  }
  replacementTrack = null;
  pipelineTrack = null;
  // A new AudioContext's clock starts at 0 — a stale schedule time from the old
  // context would delay every translated chunk.
  nextPlaybackTime = 0;
}

// ─── Mute mirroring ───────────────────────────────────────────────────────────

function startEnabledMirror(source: MediaStreamTrack): void {
  stopEnabledMirror();
  enabledObserverInterval = setInterval(() => {
    if (replacementTrack && source) {
      replacementTrack.enabled = source.enabled;
    }
  }, 50);
}

function stopEnabledMirror(): void {
  if (enabledObserverInterval !== null) {
    clearInterval(enabledObserverInterval);
    enabledObserverInterval = null;
  }
}

// ─── Translated audio playback ────────────────────────────────────────────────

// Playback queue — schedules each chunk back-to-back so translated audio
// plays smoothly without overlaps or gaps.
let nextPlaybackTime = 0;

// Sample rate of headerless continuation chunks (taken from the last WAV header).
let lastSampleRate = 16000;

/**
 * Locate the PCM payload. Complete WAVs (what the backend sends per utterance)
 * yield their declared sample rate and exact data size; anything without a
 * RIFF header is treated as raw Int16 PCM at the last seen rate.
 */
function parseAudioChunk(bytes: Uint8Array): { offset: number; size: number; sampleRate: number } {
  const raw = { offset: 0, size: bytes.length, sampleRate: lastSampleRate };
  if (bytes.length < 12) return raw;
  // 'RIFF' ... 'WAVE'
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return raw;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return raw;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = lastSampleRate;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ' && offset + 16 <= bytes.length) {
      sampleRate = view.getUint32(offset + 12, true) || sampleRate;
    } else if (chunkId === 'data') {
      const dataStart = offset + 8;
      lastSampleRate = sampleRate;
      // Clamp: never read past what's actually in the buffer.
      return { offset: dataStart, size: Math.min(chunkSize, bytes.length - dataStart), sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  // Malformed header — skip the standard 44-byte prefix as a fallback.
  return { offset: 44, size: Math.max(0, bytes.length - 44), sampleRate };
}

function playTranslated(audioBytes: number[]): void {
  if (!audioCtx || !destination) {
    console.warn('[Interceptor] playTranslated: no audioCtx or destination, dropping audio');
    return;
  }

  const bytes = new Uint8Array(audioBytes);
  const { offset: pcmOffset, size: pcmByteLength, sampleRate } = parseAudioChunk(bytes);

  if (pcmByteLength < 2) {
    console.warn('[Interceptor] playTranslated: empty PCM payload');
    return;
  }

  try {
    // Read little-endian Int16 samples from the underlying buffer. Using a
    // DataView handles non-aligned offsets that Int16Array would reject.
    const view = new DataView(bytes.buffer, bytes.byteOffset + pcmOffset, pcmByteLength);
    const frameCount = pcmByteLength >> 1;
    const buffer = audioCtx.createBuffer(1, frameCount, sampleRate);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);

    // Schedule back-to-back so streamed chunks play as continuous speech.
    const now = audioCtx.currentTime;
    const startAt = Math.max(now, nextPlaybackTime);
    source.start(startAt);
    nextPlaybackTime = startAt + buffer.duration;
  } catch (err) {
    console.error('[Interceptor] PCM playback failed:', err);
  }
}

// ─── Sender bookkeeping ───────────────────────────────────────────────────────

/** Forget closed peer connections and senders that no longer belong to a live one. */
function pruneClosed(): void {
  const live = new Set<RTCRtpSender>();
  for (const pc of peerConnections) {
    if (pc.signalingState === 'closed') {
      peerConnections.delete(pc);
      continue;
    }
    try {
      for (const s of pc.getSenders()) live.add(s);
    } catch {
      peerConnections.delete(pc);
    }
  }
  for (const s of senders) if (!live.has(s)) senders.delete(s);
}

function isUsableTrack(track: MediaStreamTrack | null): track is MediaStreamTrack {
  return !!track && track.readyState === 'live' && track !== replacementTrack;
}

function discoverAudioSenders(): void {
  pruneClosed();
  for (const pc of peerConnections) {
    try {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') continue;
        senders.add(sender);
        // Prefer a live mic track (never our own replacement) as the source.
        if (!isUsableTrack(realTrack) && isUsableTrack(sender.track)) {
          realTrack = sender.track;
          console.log('[Interceptor] Captured realTrack from sender:', realTrack.label);
        }
      }
    } catch {
      // PC might be closed
    }
  }
}

/** Point every tracked audio sender at `track`. */
async function swapAllSenders(track: MediaStreamTrack | null): Promise<void> {
  pruneClosed();
  await Promise.all(
    [...senders].map((sender) =>
      sender.track === track
        ? Promise.resolve()
        : _origReplaceTrack.call(sender, track).catch((err: Error) => {
            console.error('[Interceptor] replaceTrack failed:', err);
          })
    )
  );
}

/** (Re)build the pipeline for `track` and route every sender to the translated output. */
async function rewire(track: MediaStreamTrack): Promise<void> {
  await setupPipeline(track);
  if (!active) return;
  // If the pipeline couldn't be built, fall back to the real mic rather than silence.
  await swapAllSenders(replacementTrack ?? track);
}

function postActivationResult(ok: boolean, message?: string): void {
  window.postMessage({ source: 'interpreter-ext', type: 'interpreter-activation-result', ok, message }, '*');
}

// ─── Activate / Deactivate ────────────────────────────────────────────────────

async function activate(): Promise<void> {
  console.log('[Interceptor] Activating outgoing translation');
  active = true;

  // Discover any senders we might have missed (e.g. from addTransceiver)
  discoverAudioSenders();

  if (!isUsableTrack(realTrack)) {
    console.warn('[Interceptor] No live microphone track found');
    active = false;
    postActivationResult(false, 'Join the call with your microphone on first, then turn on voice translation.');
    return;
  }

  await rewire(realTrack);
  if (!active) return; // deactivated while the pipeline was building
  if (replacementTrack) {
    console.log('[Interceptor] Routing', senders.size, 'sender(s) through the translated track');
    postActivationResult(true);
  } else {
    active = false;
    await swapAllSenders(realTrack);
    postActivationResult(false, "Couldn't attach to your microphone in this call.");
  }
}

async function deactivate(): Promise<void> {
  console.log('[Interceptor] Deactivating outgoing translation');
  active = false;

  // Swap senders back to the real track before tearing down the pipeline
  if (isUsableTrack(realTrack)) await swapAllSenders(realTrack);

  await pipelineLock;
  teardownPipeline();
}

// ─── RTCPeerConnection / RTCRtpSender patching ───────────────────────────────
// Patch immediately — before any page script (including Google Meet) runs.

const _origAddTrack = RTCPeerConnection.prototype.addTrack;
const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;

// Track all peer connections for sender discovery
const _origPCConstructor = window.RTCPeerConnection;
// @ts-expect-error — overriding global constructor
window.RTCPeerConnection = function (...args: ConstructorParameters<typeof RTCPeerConnection>): RTCPeerConnection {
  const pc = new _origPCConstructor(...args);
  pruneClosed();
  peerConnections.add(pc);
  return pc;
};
window.RTCPeerConnection.prototype = _origPCConstructor.prototype;
// Preserve static properties
Object.setPrototypeOf(window.RTCPeerConnection, _origPCConstructor);

/** Which track to hand Meet for a newly added mic track. */
function trackToSend(track: MediaStreamTrack): MediaStreamTrack {
  return active && replacementTrack && pipelineTrack === track ? replacementTrack : track;
}

// Patch addTrack
RTCPeerConnection.prototype.addTrack = function (
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  if (track.kind !== 'audio' || track === replacementTrack) {
    return _origAddTrack.call(this, track, ...streams);
  }

  realTrack = track;
  const sending = trackToSend(track);
  const sender = _origAddTrack.call(this, sending, ...streams);
  senders.add(sender);
  if (active && sending !== replacementTrack) void rewire(track);
  return sender;
};

// Patch addTransceiver — Google Meet uses this instead of addTrack. A kind-only
// call ('audio') passes straight through; its sender is picked up later by the
// replaceTrack patch or discoverAudioSenders().
RTCPeerConnection.prototype.addTransceiver = function (
  trackOrKind: MediaStreamTrack | string,
  init?: RTCRtpTransceiverInit
): RTCRtpTransceiver {
  if (!(trackOrKind instanceof MediaStreamTrack) || trackOrKind.kind !== 'audio' || trackOrKind === replacementTrack) {
    return _origAddTransceiver.call(this, trackOrKind, init);
  }

  const track = trackOrKind;
  realTrack = track;
  const sending = trackToSend(track);
  const transceiver = _origAddTransceiver.call(this, sending, init);
  senders.add(transceiver.sender);
  if (active && sending !== replacementTrack) void rewire(track);
  return transceiver;
};

// Patch replaceTrack on RTCRtpSender (Meet uses it for mic switches / unmute)
RTCRtpSender.prototype.replaceTrack = function (
  newTrack: MediaStreamTrack | null
): Promise<void> {
  if (!newTrack || newTrack.kind !== 'audio' || newTrack === replacementTrack) {
    return _origReplaceTrack.call(this, newTrack);
  }

  realTrack = newTrack;
  senders.add(this);
  if (!active) return _origReplaceTrack.call(this, newTrack);

  // Rebuild for the new mic, then point every sender (including this one) at
  // the new translated track — or at the real mic if the rebuild failed.
  return rewire(newTrack).then(() => {
    const target = active && replacementTrack ? replacementTrack : newTrack;
    if (this.track !== target) return _origReplaceTrack.call(this, target);
  });
};

// ─── getUserMedia override — catch the mic track early ──────────────────────
// Meet calls getUserMedia to get the mic, then addTrack/addTransceiver.
// Override getUserMedia to capture the mic track as early as possible.

const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

navigator.mediaDevices.getUserMedia = async function (
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  const stream = await _origGetUserMedia(constraints);

  // Check if this was an audio request
  if (constraints?.audio) {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      console.log('[Interceptor] getUserMedia returned audio track:', audioTracks[0].label);
      realTrack = audioTracks[0];
    }
  }

  return stream;
};

// ─── postMessage listener ─────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as InterpreterMessage;
  if (!msg || msg.source !== 'interpreter-ext') return;

  switch (msg.type) {
    case 'interpreter-activate':
      void activate();
      break;

    case 'interpreter-deactivate':
      void deactivate();
      break;

    case 'interpreter-translated-audio': {
      const data = msg.data;
      if (Array.isArray(data)) {
        playTranslated(data);
      }
      break;
    }

    default:
      break;
  }
});

console.log('[Interceptor] RTC patched: addTrack, addTransceiver, replaceTrack, getUserMedia');
