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
// The track Meet itself asked each sender to carry (null = muted / detached).
// Activation only redirects senders whose intended track is the mic, and
// deactivation puts exactly this back — so we never "unmute" anyone.
const intended = new WeakMap<RTCRtpSender, MediaStreamTrack | null>();
// Tracks that are never the microphone.
const displayTracks = new WeakSet<MediaStreamTrack>(); // screen / tab share audio
const replacementTracks = new WeakSet<MediaStreamTrack>(); // our translated outputs, current and past
// Raw microphone tracks from getUserMedia (Meet may send a processed copy).
const gumMicTracks = new Set<MediaStreamTrack>();
// Have we ever seen Meet send the mic? Until then "is your voice in the call" is unknown.
let sawMicSender = false;

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
      // Muted in Meet (sender detached): keep the stream alive with silence, never your words.
      if (!isSendingTranslation()) pcm.fill(0);
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
    replacementTracks.add(replacementTrack);
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

/** An audio track captured from a microphone — not screen-share audio, not our own output. */
function isMicTrack(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.kind === 'audio' && !displayTracks.has(track) && !replacementTracks.has(track);
}

function isUsableTrack(track: MediaStreamTrack | null | undefined): track is MediaStreamTrack {
  return !!track && isMicTrack(track) && track.readyState === 'live';
}

/** Adopt senders Meet set up before we saw them (only ones carrying the mic). */
function discoverAudioSenders(): void {
  pruneClosed();
  for (const pc of peerConnections) {
    try {
      for (const sender of pc.getSenders()) {
        if (senders.has(sender) || !isMicTrack(sender.track)) continue;
        senders.add(sender);
        intended.set(sender, sender.track);
        sawMicSender = true;
      }
    } catch {
      // PC might be closed
    }
  }
}

/** The mic Meet is actually sending; falls back to the last getUserMedia mic. */
function currentMicTrack(): MediaStreamTrack | null {
  for (const sender of senders) {
    const track = intended.get(sender);
    if (isUsableTrack(track)) return track;
  }
  return isUsableTrack(realTrack) ? realTrack : null;
}

/** True while at least one sender is carrying the translated track to the call. */
function isSendingTranslation(): boolean {
  if (!replacementTrack) return false;
  for (const sender of senders) if (sender.track === replacementTrack) return true;
  return false;
}

async function replaceOn(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
  if (sender.track === track) return;
  try {
    await _origReplaceTrack.call(sender, track);
  } catch (err) {
    console.error('[Interceptor] replaceTrack failed:', err);
  }
}

/** Send `track` on every sender Meet is using for the mic. Muted (null) senders stay muted. */
async function routeMicSendersTo(track: MediaStreamTrack): Promise<void> {
  pruneClosed();
  await Promise.all([...senders].filter((s) => isMicTrack(intended.get(s))).map((s) => replaceOn(s, track)));
}

/** Put back exactly what Meet asked each sender to carry. */
async function restoreMeetTracks(): Promise<void> {
  pruneClosed();
  await Promise.all([...senders].filter((s) => intended.has(s)).map((s) => replaceOn(s, intended.get(s) ?? null)));
}

/** (Re)build the pipeline for `track` and route the mic senders to the translated output. */
async function rewire(track: MediaStreamTrack): Promise<void> {
  await setupPipeline(track);
  if (!active) return;
  // If the pipeline couldn't be built, fall back to the real mic rather than silence.
  if (replacementTrack) await routeMicSendersTo(replacementTrack);
  else await restoreMeetTracks();
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

  const notInCall = 'Join the call with your microphone on first, then turn on voice translation.';
  const mic = currentMicTrack();
  if (!mic) {
    console.warn('[Interceptor] No live microphone track found');
    active = false;
    postActivationResult(false, notInCall);
    return;
  }
  realTrack = mic;

  await rewire(mic);
  if (!active) return; // deactivated while the pipeline was building
  const mutedInCall = [...senders].some((s) => intended.get(s) === null);
  if (replacementTrack && (isSendingTranslation() || mutedInCall)) {
    console.log('[Interceptor] Routing', senders.size, 'sender(s) through the translated track');
    postActivationResult(true);
  } else {
    active = false;
    await restoreMeetTracks();
    postActivationResult(false, replacementTrack ? notInCall : "Couldn't attach to your microphone in this call.");
  }
}

async function deactivate(): Promise<void> {
  console.log('[Interceptor] Deactivating outgoing translation');
  const wasActive = active;
  active = false;

  // Put Meet's own tracks back before tearing down the pipeline. Never touch
  // senders when translation wasn't running (notes-only mode leaves the call alone).
  if (wasActive || replacementTrack) await restoreMeetTracks();

  await pipelineLock;
  teardownPipeline();
}

// ─── RTCPeerConnection / RTCRtpSender patching ───────────────────────────────
// Patch immediately — before any page script (including Google Meet) runs.

const _origAddTrack = RTCPeerConnection.prototype.addTrack;
const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
const _origRemoveTrack = RTCPeerConnection.prototype.removeTrack;

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
// The legacy alias must build tracked connections too, or their senders get pruned.
if ('webkitRTCPeerConnection' in window) {
  (window as unknown as { webkitRTCPeerConnection: typeof RTCPeerConnection }).webkitRTCPeerConnection = window.RTCPeerConnection;
}

/** Which track to hand Meet for a newly added mic track. */
function trackToSend(track: MediaStreamTrack): MediaStreamTrack {
  return active && replacementTrack && pipelineTrack === track ? replacementTrack : track;
}

// Patch addTrack
RTCPeerConnection.prototype.addTrack = function (
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  if (!isMicTrack(track)) {
    return _origAddTrack.call(this, track, ...streams); // video, screen-share audio, our own output
  }

  realTrack = track;
  const sending = trackToSend(track);
  const sender = _origAddTrack.call(this, sending, ...streams);
  senders.add(sender);
  intended.set(sender, track);
  sawMicSender = true;
  if (active && sending !== replacementTrack) void rewire(track);
  return sender;
};

// Patch removeTrack — the sender stops carrying the mic; never put it back.
RTCPeerConnection.prototype.removeTrack = function (sender: RTCRtpSender): void {
  if (intended.has(sender)) intended.set(sender, null);
  return _origRemoveTrack.call(this, sender);
};

// Patch addTransceiver — Google Meet uses this instead of addTrack. A kind-only
// call ('audio') passes straight through; its sender is picked up later by the
// replaceTrack patch or discoverAudioSenders().
RTCPeerConnection.prototype.addTransceiver = function (
  trackOrKind: MediaStreamTrack | string,
  init?: RTCRtpTransceiverInit
): RTCRtpTransceiver {
  if (!(trackOrKind instanceof MediaStreamTrack) || !isMicTrack(trackOrKind)) {
    return _origAddTransceiver.call(this, trackOrKind, init);
  }

  const track = trackOrKind;
  realTrack = track;
  const sending = trackToSend(track);
  const transceiver = _origAddTransceiver.call(this, sending, init);
  senders.add(transceiver.sender);
  intended.set(transceiver.sender, track);
  sawMicSender = true;
  if (active && sending !== replacementTrack) void rewire(track);
  return transceiver;
};

// Patch replaceTrack on RTCRtpSender (Meet uses it for mic switches / mute / unmute)
RTCRtpSender.prototype.replaceTrack = function (
  newTrack: MediaStreamTrack | null
): Promise<void> {
  if (!newTrack) {
    // Meet muting or detaching this sender: remember it so we never "unmute" it.
    if (senders.has(this)) intended.set(this, null);
    return _origReplaceTrack.call(this, null);
  }
  if (!isMicTrack(newTrack)) {
    // Video or screen-share audio: not the mic, so this sender isn't ours to touch.
    if (newTrack.kind === 'audio') {
      senders.delete(this);
      intended.delete(this);
    }
    return _origReplaceTrack.call(this, newTrack);
  }

  realTrack = newTrack;
  senders.add(this);
  intended.set(this, newTrack);
  sawMicSender = true;
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
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return stream;

  // Legacy screen/tab capture goes through getUserMedia with chromeMediaSource.
  const audio = constraints?.audio as { mandatory?: { chromeMediaSource?: string }; chromeMediaSource?: string } | boolean | undefined;
  const isScreen = typeof audio === 'object' && !!(audio.mandatory?.chromeMediaSource || audio.chromeMediaSource);
  if (isScreen) {
    for (const track of audioTracks) displayTracks.add(track);
  } else {
    console.log('[Interceptor] getUserMedia returned audio track:', audioTracks[0].label);
    realTrack = audioTracks[0];
    for (const track of audioTracks) gumMicTracks.add(track);
  }
  return stream;
};

// Screen / tab share audio is never the microphone.
if (typeof navigator.mediaDevices.getDisplayMedia === 'function') {
  const _origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async function (options?: DisplayMediaStreamOptions): Promise<MediaStream> {
    const stream = await _origGetDisplayMedia(options);
    for (const track of stream.getTracks()) displayTracks.add(track);
    return stream;
  };
}

// Clones keep their origin (Meet may clone tracks before sending them).
const _origClone = MediaStreamTrack.prototype.clone;
MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack): MediaStreamTrack {
  const copy = _origClone.call(this);
  if (displayTracks.has(this)) displayTracks.add(copy);
  if (replacementTracks.has(this)) replacementTracks.add(copy);
  return copy;
};

// ─── Is your voice reaching the call? ─────────────────────────────────────────
// Meeting notes should only contain what was said in the meeting, so the notes
// mic follows Meet's mute. Reported as true / false, or null while unknown (e.g.
// no mic sender seen yet) — unknown never silences the notes.

/** Meet's own mic button, when present (English UI): true = muted. */
function meetMuteButton(): boolean | null {
  const button = document.querySelector('[data-is-muted][aria-label*="microphone" i]');
  return button ? button.getAttribute('data-is-muted') === 'true' : null;
}

function voiceReachesCall(): boolean | null {
  if (meetMuteButton() === true) return false;
  discoverAudioSenders();
  if (!sawMicSender) return null;
  let sending = false;
  for (const sender of senders) {
    const track = intended.get(sender);
    if (track && track.readyState === 'live' && track.enabled) {
      sending = true;
      break;
    }
  }
  if (!sending) return false; // muted (sender detached / track disabled or stopped) or left the call
  // Meet may send a processed copy and mute the raw microphone track instead.
  for (const track of gumMicTracks) if (track.readyState !== 'live') gumMicTracks.delete(track);
  if (gumMicTracks.size > 0 && ![...gumMicTracks].some((t) => t.enabled)) return false;
  return true;
}

let lastVoiceInCall: boolean | null | undefined;
function reportVoiceInCall(force = false): void {
  const live = voiceReachesCall();
  if (!force && live === lastVoiceInCall) return;
  lastVoiceInCall = live;
  window.postMessage({ source: 'interpreter-ext', type: 'interpreter-mic-state', live }, '*');
}
setInterval(() => reportVoiceInCall(), 400);

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

    case 'interpreter-mic-state-request':
      reportVoiceInCall(true);
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
