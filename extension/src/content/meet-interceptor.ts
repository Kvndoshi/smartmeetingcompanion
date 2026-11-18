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
 *   5. "Own voice" mix (interpreter-mix, mic: true): the replacement track also
 *      carries your real mic, for when the room already speaks your language
 *
 * Rules this file must never break (Meet's own mic button depends on them):
 *   - Fail open. Meet's addTrack / addTransceiver / replaceTrack calls reach the
 *     native method synchronously — nothing of ours is awaited first, and nothing
 *     of ours can make them throw, reject or hang. If our audio pipeline isn't
 *     ready (still building, failed, timed out) Meet's real track goes through
 *     untouched and the failure is reported.
 *   - Invisible. `sender.track` keeps returning the track Meet put there, never
 *     our replacement. Meet mutes with whatever it reads from the sender; if it
 *     got our track it would toggle the wrong one and the mic button would freeze.
 *   - Meet owns mute. We only ever mirror Meet's state onto our track.
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

// ─── Native methods (captured before anything is patched) ────────────────────

const _origAddTrack = RTCPeerConnection.prototype.addTrack;
const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
const _origRemoveTrack = RTCPeerConnection.prototype.removeTrack;
const _senderTrackDescriptor = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'track');
const _origSenderTrackGet = _senderTrackDescriptor?.get;

/** The track a sender really carries (Meet's own, or our replacement). */
function carried(sender: RTCRtpSender): MediaStreamTrack | null {
  return _origSenderTrackGet ? _origSenderTrackGet.call(sender) : sender.track;
}

// ─── State ────────────────────────────────────────────────────────────────────

let active = false;
// Bumps on every activate / deactivate so a slow activation can tell it was superseded.
let activationGen = 0;
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

// Audio pipeline: one AudioContext per activation. Its output track (what the
// call carries) stays the same when Meet switches microphones — only the mic
// source node is swapped, synchronously.
let audioCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let replacementTrack: MediaStreamTrack | null = null;
// The mic currently feeding the pipeline (null = none, e.g. Meet stopped it to mute).
let attachedTrack: MediaStreamTrack | null = null;
// Your real voice into the replacement track: gain 1 = others hear you (own voice),
// 0 = they hear only the translation. Kept across pipeline rebuilds.
let micGain: GainNode | null = null;
let micPassthrough = false;

// Mirror mute state from real track to replacement track
let enabledObserverInterval: ReturnType<typeof setInterval> | null = null;

// ─── Inline AudioWorklet (Blob URL) ──────────────────────────────────────────

// Emits fixed-size chunks continuously — silence while no microphone is
// connected — so the speech stream stays alive through a mute.
const WORKLET_CODE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = options?.processorOptions?.chunkSize || 4096;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
    this.silence = new Float32Array(128);
  }
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0] ? input[0] : this.silence;
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

/** `promise`, or a rejection after `ms` — nothing we await may hang forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
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

function postActivationResult(ok: boolean, message?: string): void {
  window.postMessage({ source: 'interpreter-ext', type: 'interpreter-activation-result', ok, message }, '*');
}

// ─── Audio Pipeline ───────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS = 1500;
const BUILD_TIMEOUT_MS = 5000;
const PIPELINE_FAILED = "Couldn't start voice translation in this call — others still hear your own voice. Reload the Meet tab and try again.";
const CONTEXT_NOT_RUNNING =
  "Chrome hasn't let this tab start audio yet — others still hear your own voice. Click anywhere in the Meet tab, then turn “Translate my voice” on again.";
// Why the last build failed, for the message shown to the user.
let pipelineFailure = PIPELINE_FAILED;

// Invalidates builds that are still running when the pipeline is torn down.
let pipelineGen = 0;
let building: Promise<boolean> | null = null;
// Contexts of builds in flight, so a build that hangs can still be closed.
const buildingContexts = new Set<AudioContext>();

/** The translated track exists and its AudioContext is producing audio. */
function pipelineReady(): boolean {
  return !!audioCtx && audioCtx.state === 'running' && !!replacementTrack && replacementTrack.readyState === 'live';
}

function closeContext(ctx: AudioContext): void {
  buildingContexts.delete(ctx);
  ctx.onstatechange = null;
  if (ctx.state !== 'closed') ctx.close().catch(() => {/* ignore */});
}

/** Build the pipeline if there isn't one. Resolves false (never rejects, never hangs) on failure. */
function ensurePipeline(): Promise<boolean> {
  if (pipelineReady()) return Promise.resolve(true);
  if (!building) {
    teardownPipeline(); // a broken leftover (e.g. a context that stopped)
    const gen = pipelineGen;
    const attempt: Promise<boolean> = withTimeout(buildPipeline(gen), BUILD_TIMEOUT_MS, 'Audio pipeline setup')
      .catch((err) => {
        console.error('[Interceptor] Failed to set up audio pipeline — the call keeps your real microphone:', err);
        if (gen === pipelineGen) teardownPipeline();
        return false;
      })
      .finally(() => {
        if (building === attempt) building = null;
      });
    building = attempt;
  }
  return building;
}

async function buildPipeline(gen: number): Promise<boolean> {
  pipelineFailure = PIPELINE_FAILED;
  const ctx = new AudioContext({ sampleRate: 48000 });
  buildingContexts.add(ctx);
  const stale = () => gen !== pipelineGen;
  try {
    // Force this AudioContext's output to the "none" sink so nothing from
    // this graph can ever reach the user's speakers — even if Meet (or any
    // other code) inadvertently connects something to audioCtx.destination.
    // The translated audio still reaches remote peers because it flows
    // through MediaStreamAudioDestinationNode, which is independent of the
    // context's speaker sink.
    const ctxWithSink = ctx as AudioContext & {
      setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
    };
    if (typeof ctxWithSink.setSinkId === 'function') {
      try {
        await withTimeout(ctxWithSink.setSinkId({ type: 'none' }), STEP_TIMEOUT_MS, 'setSinkId');
      } catch (err) {
        console.warn('[Interceptor] setSinkId({type:"none"}) unavailable:', err);
      }
    }
    if (stale()) return false;

    const workletUrl = createWorkletBlobUrl();
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    if (stale()) return false;

    // A context created outside a user gesture can start suspended; its output
    // track would be pure silence, so it must be running before the call gets it.
    if (ctx.state !== 'running') {
      await withTimeout(ctx.resume(), STEP_TIMEOUT_MS, 'AudioContext.resume').catch(() => {/* checked below */});
    }
    if (stale()) return false;
    if (ctx.state !== 'running') {
      pipelineFailure = CONTEXT_NOT_RUNNING;
      throw new Error(`AudioContext is ${ctx.state}, not running`);
    }

    const node = new AudioWorkletNode(ctx, 'interpreter-mic-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { chunkSize: 4096 },
    });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const inputData = event.data;
      if (!(inputData instanceof Float32Array) || !active) return;

      const downsampled = downsampleBuffer(inputData, ctx.sampleRate, 16000);
      const pcm = floatTo16BitPCM(downsampled);
      // Muted in Meet (sender detached): keep the stream alive with silence, never your words.
      if (!isSendingTranslation()) pcm.fill(0);
      const buffer = pcm.buffer.slice(0) as ArrayBuffer;
      postOut({ type: 'interpreter-mic-pcm', data: buffer }, [buffer]);
    };

    // PCM for the translation comes from the mic (attachMic). The destination
    // (what Meet sends) carries the translated audio injected by playTranslated(),
    // plus your real voice only while the "own voice" mix is on.
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = micPassthrough ? 1 : 0;
    gain.connect(dest);

    const destTracks = dest.stream.getAudioTracks();
    if (destTracks.length === 0) throw new Error('MediaStreamDestination produced no audio tracks');

    buildingContexts.delete(ctx);
    audioCtx = ctx;
    workletNode = node;
    destination = dest;
    micGain = gain;
    replacementTrack = destTracks[0];
    replacementTracks.add(replacementTrack);
    nextPlaybackTime = 0;
    ctx.onstatechange = () => onContextStateChange(ctx);
    startEnabledMirror();
    console.log('[Interceptor] Audio pipeline ready, replacementTrack:', replacementTrack.id);
    return true;
  } catch (err) {
    closeContext(ctx);
    throw err;
  }
}

function teardownPipeline(): void {
  pipelineGen++;
  building = null;
  for (const ctx of [...buildingContexts]) closeContext(ctx);
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
  attachedTrack = null;
  if (micGain) {
    micGain.disconnect();
    micGain = null;
  }
  if (destination) {
    destination.disconnect();
    destination = null;
  }
  if (audioCtx) {
    closeContext(audioCtx);
    audioCtx = null;
  }
  replacementTrack = null;
  // A new AudioContext's clock starts at 0 — a stale schedule time from the old
  // context would delay every translated chunk.
  nextPlaybackTime = 0;
}

/**
 * Feed `track` (Meet's current microphone) into the pipeline. Synchronous, so a
 * microphone switch never delays Meet's own call. Returns false if it couldn't.
 */
function attachMic(track: MediaStreamTrack): boolean {
  if (!audioCtx || !workletNode || !micGain) return false;
  if (attachedTrack === track && micSource) return true;
  try {
    const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    source.connect(workletNode);
    source.connect(micGain);
    micSource?.disconnect();
    micSource = source;
    attachedTrack = track;
    // A muted microphone stays muted from the first sample (the mirror keeps it in step).
    if (replacementTrack) replacementTrack.enabled = track.enabled;
    return true;
  } catch (err) {
    console.error('[Interceptor] Could not attach the microphone to the audio pipeline:', err);
    return false;
  }
}

/** The context stopped on its own (device change, tab policy): its track would go silent. */
function onContextStateChange(ctx: AudioContext): void {
  if (ctx !== audioCtx || ctx.state === 'running' || !active) return;
  console.warn('[Interceptor] AudioContext became', ctx.state);
  if (ctx.state !== 'closed') void ctx.resume().catch(() => {/* checked below */});
  setTimeout(() => {
    if (ctx !== audioCtx || !active || ctx.state === 'running') return;
    void failOpen("Voice translation lost its audio engine — others hear your own voice again. Turn “Translate my voice” on again.");
  }, STEP_TIMEOUT_MS);
}

// ─── Mute mirroring ───────────────────────────────────────────────────────────
// Meet may mute by disabling the microphone track. Our replacement follows that
// flag; it is never the other way round, and Meet never sees our track.

function startEnabledMirror(): void {
  stopEnabledMirror();
  enabledObserverInterval = setInterval(() => {
    if (!replacementTrack) return;
    const enabled = attachedTrack ? attachedTrack.enabled : true;
    if (replacementTrack.enabled === enabled) return;
    replacementTrack.enabled = enabled;
    if (active) console.debug('[Interceptor] Meet set the mic track enabled =', enabled, '→ mirrored');
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

  try {
    const bytes = new Uint8Array(audioBytes);
    const { offset: pcmOffset, size: pcmByteLength, sampleRate } = parseAudioChunk(bytes);

    if (pcmByteLength < 2) {
      console.warn('[Interceptor] playTranslated: empty PCM payload');
      return;
    }

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

/**
 * Own voice (true) or translation only (false). Cutting your voice is immediate;
 * bringing it back waits for translated speech that is still queued, so the two
 * never talk over each other.
 */
function setMicMix(mic: boolean): void {
  const changed = micPassthrough !== mic;
  micPassthrough = mic;
  if (!changed || !audioCtx || !micGain) return; // no pipeline yet: applied when it is built
  const now = audioCtx.currentTime;
  const param = micGain.gain;
  param.cancelScheduledValues(now);
  if (mic) {
    // Pin the gain at 0 until the queued translation is over. (Anchoring on
    // `param.value` isn't safe: mid-automation it can be stale, which left your
    // voice faintly audible under the translation.)
    param.setValueAtTime(0, now);
    param.setTargetAtTime(1, Math.max(now, nextPlaybackTime), 0.02);
  } else {
    param.setTargetAtTime(0, now, 0.02);
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
        const track = carried(sender);
        if (senders.has(sender) || !isMicTrack(track)) continue;
        senders.add(sender);
        intended.set(sender, track);
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
  for (const sender of senders) if (carried(sender) === replacementTrack) return true;
  return false;
}

/**
 * Send the translated track on every sender Meet is using for the mic. Muted
 * (null) senders stay muted. A no-op unless translation is on and the pipeline
 * is producing audio.
 */
async function routeMicSenders(): Promise<void> {
  if (!active || !pipelineReady()) return;
  const replacement = replacementTrack!;
  pruneClosed();
  const mic = currentMicTrack();
  if (mic && (!attachedTrack || attachedTrack.readyState !== 'live' || !isSendingTranslation())) attachMic(mic);
  const pending: Promise<void>[] = [];
  for (const sender of senders) {
    if (!isMicTrack(intended.get(sender)) || carried(sender) === replacement) continue;
    pending.push(
      _origReplaceTrack.call(sender, replacement).catch((err) => {
        console.error('[Interceptor] Could not route a sender through the translated track:', err);
      })
    );
  }
  await Promise.all(pending);
}

/** Put back exactly what Meet asked each sender to carry (only where our track is). */
async function restoreMeetTracks(): Promise<void> {
  pruneClosed();
  const pending: Promise<void>[] = [];
  for (const sender of senders) {
    const now = carried(sender);
    if (!now || !replacementTracks.has(now)) continue;
    pending.push(
      _origReplaceTrack.call(sender, intended.get(sender) ?? null).catch((err) => {
        console.error('[Interceptor] Could not restore a sender:', err);
      })
    );
  }
  await Promise.all(pending);
}

/** Something broke while translating: give the call its real microphone back and say so. */
async function failOpen(message: string): Promise<void> {
  console.error('[Interceptor] Falling back to the real microphone:', message);
  active = false;
  activationGen++;
  await restoreMeetTracks();
  if (!active) teardownPipeline();
  postActivationResult(false, message);
}

// ─── Activate / Deactivate ────────────────────────────────────────────────────

async function activate(): Promise<void> {
  console.log('[Interceptor] Activating outgoing translation');
  active = true;
  const gen = ++activationGen;

  // Discover any senders we might have missed (e.g. from addTransceiver)
  discoverAudioSenders();

  const ok = await ensurePipeline();
  if (!active || gen !== activationGen) return; // deactivated / re-activated while building
  if (!ok || !pipelineReady()) {
    await failOpen(pipelineFailure);
    return;
  }

  // No microphone yet (not in the call, or muted with the mic stopped) is fine:
  // the patches below route it the moment Meet sends one.
  await routeMicSenders();
  if (!active || gen !== activationGen) return;
  console.log('[Interceptor] Translating', senders.size, 'sender(s); in call now:', isSendingTranslation());
  postActivationResult(true);
}

async function deactivate(): Promise<void> {
  console.log('[Interceptor] Deactivating outgoing translation');
  active = false;
  activationGen++;

  // Put Meet's own tracks back before tearing down the pipeline. Only senders
  // carrying our track are touched (notes-only mode leaves the call alone).
  await restoreMeetTracks();
  if (active) return; // turned on again meanwhile — that activation owns the pipeline
  teardownPipeline();
}

// ─── RTCPeerConnection / RTCRtpSender patching ───────────────────────────────
// Patch immediately — before any page script (including Google Meet) runs.

// Track all peer connections for sender discovery
const _origPCConstructor = window.RTCPeerConnection;
// @ts-expect-error — overriding global constructor
window.RTCPeerConnection = function (...args: ConstructorParameters<typeof RTCPeerConnection>): RTCPeerConnection {
  const pc = new _origPCConstructor(...args);
  try {
    pruneClosed();
    peerConnections.add(pc);
  } catch {
    /* bookkeeping only */
  }
  return pc;
};
window.RTCPeerConnection.prototype = _origPCConstructor.prototype;
// Preserve static properties
Object.setPrototypeOf(window.RTCPeerConnection, _origPCConstructor);
// The legacy alias must build tracked connections too, or their senders get pruned.
if ('webkitRTCPeerConnection' in window) {
  (window as unknown as { webkitRTCPeerConnection: typeof RTCPeerConnection }).webkitRTCPeerConnection = window.RTCPeerConnection;
}

// Meet reads `sender.track` to find, compare and mute its microphone. It must
// keep seeing its own track while ours is on the wire.
if (_senderTrackDescriptor && _origSenderTrackGet) {
  Object.defineProperty(RTCRtpSender.prototype, 'track', {
    ..._senderTrackDescriptor,
    get(this: RTCRtpSender): MediaStreamTrack | null {
      const track = _origSenderTrackGet.call(this);
      if (track && replacementTracks.has(track)) return intended.get(this) ?? null;
      return track;
    },
  });
}

/**
 * Meet is handing `track` (a microphone) to a sender. Returns the track the
 * sender should really carry: our translated track when translation is on and
 * ready, otherwise Meet's own. Never throws.
 */
function outgoingFor(track: MediaStreamTrack): MediaStreamTrack {
  try {
    realTrack = track;
    sawMicSender = true;
    if (active && pipelineReady() && attachMic(track)) return replacementTrack!;
  } catch (err) {
    console.error('[Interceptor] bookkeeping failed — passing the real microphone through:', err);
  }
  return track;
}

function remember(sender: RTCRtpSender, track: MediaStreamTrack): void {
  senders.add(sender);
  intended.set(sender, track);
}

// Patch addTrack
RTCPeerConnection.prototype.addTrack = function (
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  if (!isMicTrack(track)) {
    return _origAddTrack.call(this, track, ...streams); // video, screen-share audio, our own output
  }

  const sending = outgoingFor(track);
  let sender: RTCRtpSender | null = null;
  if (sending !== track) {
    try {
      sender = _origAddTrack.call(this, sending, ...streams);
    } catch (err) {
      // e.g. this connection already sends our track; routed right after instead.
      console.warn('[Interceptor] addTrack with the translated track failed — adding the real mic:', err);
    }
  }
  const routed = sender !== null;
  if (!sender) sender = _origAddTrack.call(this, track, ...streams); // Meet's own call; its errors are Meet's
  remember(sender, track);
  if (active && !routed) void routeMicSenders();
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
  const sending = outgoingFor(track);
  let transceiver: RTCRtpTransceiver | null = null;
  if (sending !== track) {
    try {
      transceiver = _origAddTransceiver.call(this, sending, init);
    } catch (err) {
      console.warn('[Interceptor] addTransceiver with the translated track failed — adding the real mic:', err);
    }
  }
  const routed = transceiver !== null;
  if (!transceiver) transceiver = _origAddTransceiver.call(this, track, init);
  remember(transceiver.sender, track);
  if (active && !routed) void routeMicSenders();
  return transceiver;
};

// Patch replaceTrack on RTCRtpSender (Meet uses it for mic switches / mute / unmute).
// The native call is always made synchronously, in Meet's order, so a mute that
// follows an unmute can never be overtaken by us.
RTCRtpSender.prototype.replaceTrack = function (
  newTrack: MediaStreamTrack | null
): Promise<void> {
  if (!newTrack) {
    // Meet muting or detaching this sender: remember it so we never "unmute" it.
    if (senders.has(this)) intended.set(this, null);
    if (active) console.debug('[Interceptor] Meet called replaceTrack(null)');
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

  const sending = outgoingFor(newTrack);
  remember(this, newTrack);
  if (active) console.debug('[Interceptor] Meet called replaceTrack(mic) → sending', sending === newTrack ? 'the real mic (pipeline not ready)' : 'the translated track');
  if (sending === newTrack) {
    // Translation off, or its pipeline isn't ready: exactly Meet's own call.
    // (If a build is in flight, activate() routes this sender when it finishes.)
    return _origReplaceTrack.call(this, newTrack);
  }
  return _origReplaceTrack.call(this, sending).catch((err) => {
    // Our track was refused: give Meet precisely what it asked for instead.
    console.error('[Interceptor] replaceTrack with the translated track failed — sending the real mic:', err);
    // Unless Meet has moved on meanwhile (muted, or switched again): its later call stands.
    if (intended.get(this) !== newTrack) return;
    return _origReplaceTrack.call(this, newTrack);
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
  try {
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
  } catch (err) {
    console.error('[Interceptor] getUserMedia bookkeeping failed:', err);
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
setInterval(() => {
  try {
    reportVoiceInCall();
    // Senders Meet set up through a path we didn't see (found by the discovery
    // above) join the translation too, instead of quietly sending the real voice.
    if (active) void routeMicSenders();
  } catch (err) {
    console.error('[Interceptor] periodic check failed:', err);
  }
}, 400);

// ─── postMessage listener ─────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as InterpreterMessage;
  if (!msg || msg.source !== 'interpreter-ext') return;

  switch (msg.type) {
    case 'interpreter-activate':
      void activate().catch((err) => {
        console.error('[Interceptor] activation failed:', err);
        void failOpen(PIPELINE_FAILED);
      });
      break;

    case 'interpreter-deactivate':
      void deactivate().catch((err) => console.error('[Interceptor] deactivation failed:', err));
      break;

    case 'interpreter-mic-state-request':
      reportVoiceInCall(true);
      break;

    case 'interpreter-mix':
      setMicMix((msg as unknown as { mic?: unknown }).mic === true);
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

console.log('[Interceptor] RTC patched: addTrack, addTransceiver, replaceTrack, sender.track, getUserMedia');
