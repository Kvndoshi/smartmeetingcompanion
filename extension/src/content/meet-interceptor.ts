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

async function setupPipeline(track: MediaStreamTrack): Promise<void> {
  try {
    teardownPipeline();

    audioCtx = new AudioContext({ sampleRate: 48000 });

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
      if (!(inputData instanceof Float32Array) || !audioCtx) return;

      const downsampled = downsampleBuffer(inputData, audioCtx.sampleRate, 16000);
      const pcm = floatTo16BitPCM(downsampled);
      const buffer = pcm.buffer.slice(0) as ArrayBuffer;
      postOut({ type: 'interpreter-mic-pcm', data: buffer }, [buffer]);
    };

    destination = audioCtx.createMediaStreamDestination();

    micSource.connect(workletNode);
    // workletNode output is not connected to destination intentionally:
    // we only want to capture PCM, not re-route mic audio to the destination.
    // The destination only receives translated audio injected via playTranslated().

    // Grab the replacement track from the destination stream
    const destTracks = destination.stream.getAudioTracks();
    if (destTracks.length === 0) {
      throw new Error('[Interceptor] MediaStreamDestination produced no audio tracks');
    }
    replacementTrack = destTracks[0];

    // Mirror enabled (mute) state from the real track
    startEnabledMirror(track);

    postOut({ type: 'interpreter-track-attached' });
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

// Azure TTS is configured server-side as Riff16Khz16BitMonoPcm. Azure streams
// synthesis incrementally: the FIRST chunk carries the RIFF/WAVE header, but
// subsequent chunks are raw Int16 PCM continuations with no header. So per
// chunk we strip any RIFF preamble we find and treat the remainder as raw PCM.
const TTS_SAMPLE_RATE = 16000;

/**
 * If `bytes` begins with a RIFF/WAVE header, return the offset of the 'data'
 * chunk payload. Otherwise return 0 (treat as raw PCM continuation).
 */
function stripRiffHeader(bytes: Uint8Array): number {
  if (bytes.length < 12) return 0;
  // 'RIFF' ... 'WAVE'
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return 0;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return 0;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      return offset + 8;
    }
    offset += 8 + chunkSize;
  }
  // Malformed header — skip standard 44-byte prefix as a fallback.
  return 44;
}

function playTranslated(audioBytes: number[]): void {
  if (!audioCtx || !destination) {
    console.warn('[Interceptor] playTranslated: no audioCtx or destination, dropping audio');
    return;
  }

  const bytes = new Uint8Array(audioBytes);
  const pcmOffset = stripRiffHeader(bytes);
  const pcmByteLength = bytes.length - pcmOffset;

  if (pcmByteLength < 2) {
    console.warn('[Interceptor] playTranslated: empty PCM payload');
    return;
  }

  try {
    // Read little-endian Int16 samples from the underlying buffer. Using a
    // DataView handles non-aligned offsets that Int16Array would reject.
    const view = new DataView(bytes.buffer, bytes.byteOffset + pcmOffset, pcmByteLength);
    const frameCount = pcmByteLength >> 1;
    const buffer = audioCtx.createBuffer(1, frameCount, TTS_SAMPLE_RATE);
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

    console.log(
      '[Interceptor] Playing translated chunk:',
      buffer.duration.toFixed(2), 's',
      pcmOffset > 0 ? '(RIFF header stripped)' : '(raw PCM)'
    );
  } catch (err) {
    console.error('[Interceptor] PCM playback failed:', err);
  }
}

// Reset the playback scheduler when the pipeline deactivates so stale
// `nextPlaybackTime` from a previous session doesn't delay a new one.
function resetPlaybackQueue(): void {
  nextPlaybackTime = 0;
}

// ─── Find all audio senders across tracked peer connections ─────────────────

function discoverAudioSenders(): void {
  for (const pc of peerConnections) {
    try {
      const pcSenders = pc.getSenders();
      for (const sender of pcSenders) {
        if (sender.track && sender.track.kind === 'audio') {
          if (!senders.has(sender)) {
            console.log('[Interceptor] Discovered audio sender via getSenders()');
            senders.add(sender);
            // If we don't have a realTrack yet, grab it from this sender
            if (!realTrack) {
              realTrack = sender.track;
              console.log('[Interceptor] Captured realTrack from sender:', realTrack.label);
            }
          }
        }
      }
    } catch {
      // PC might be closed
    }
  }
}

// ─── Activate / Deactivate ────────────────────────────────────────────────────

async function activate(): Promise<void> {
  console.log('[Interceptor] Activating outgoing translation');
  active = true;

  // Discover any senders we might have missed (e.g. from addTransceiver)
  discoverAudioSenders();

  if (realTrack) {
    await setupPipeline(realTrack);

    if (replacementTrack) {
      console.log('[Interceptor] Swapping', senders.size, 'sender(s) to replacement track');
      for (const sender of senders) {
        try {
          await _origReplaceTrack.call(sender, replacementTrack);
          console.log('[Interceptor] replaceTrack succeeded on sender');
        } catch (err) {
          console.error('[Interceptor] replaceTrack (activate) failed:', err);
        }
      }
    }
  } else {
    console.warn('[Interceptor] No realTrack found yet — will intercept when Meet adds one');
  }
}

async function deactivate(): Promise<void> {
  console.log('[Interceptor] Deactivating outgoing translation');
  active = false;

  // Swap senders back to the real track before tearing down the pipeline
  if (realTrack) {
    for (const sender of senders) {
      try {
        await _origReplaceTrack.call(sender, realTrack);
      } catch (err) {
        console.error('[Interceptor] replaceTrack (deactivate) failed:', err);
      }
    }
  }

  teardownPipeline();
  resetPlaybackQueue();
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
  peerConnections.add(pc);
  console.log('[Interceptor] New RTCPeerConnection created, total:', peerConnections.size);
  return pc;
};
window.RTCPeerConnection.prototype = _origPCConstructor.prototype;
// Preserve static properties
Object.setPrototypeOf(window.RTCPeerConnection, _origPCConstructor);

// Patch addTrack
RTCPeerConnection.prototype.addTrack = function (
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  if (track.kind !== 'audio') {
    return _origAddTrack.call(this, track, ...streams);
  }

  console.log('[Interceptor] addTrack intercepted, audio track:', track.label);
  realTrack = track;

  let sender: RTCRtpSender;

  if (active && replacementTrack) {
    sender = _origAddTrack.call(this, replacementTrack, ...streams);
  } else if (active && !replacementTrack) {
    sender = _origAddTrack.call(this, track, ...streams);
    senders.add(sender);
    void setupPipeline(track).then(() => {
      if (active && replacementTrack) {
        _origReplaceTrack.call(sender, replacementTrack).catch((err: Error) => {
          console.error('[Interceptor] async replaceTrack failed:', err);
        });
      }
    });
    return sender;
  } else {
    sender = _origAddTrack.call(this, track, ...streams);
  }

  senders.add(sender);
  postOut({ type: 'interpreter-track-attached' });
  return sender;
};

// Patch addTransceiver — Google Meet uses this instead of addTrack
RTCPeerConnection.prototype.addTransceiver = function (
  trackOrKind: MediaStreamTrack | string,
  init?: RTCRtpTransceiverInit
): RTCRtpTransceiver {
  // Determine if this is an audio track being added
  const isAudioTrack = trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio';
  const isAudioKind = typeof trackOrKind === 'string' && trackOrKind === 'audio';

  if (!isAudioTrack) {
    return _origAddTransceiver.call(this, trackOrKind, init);
  }

  const track = trackOrKind as MediaStreamTrack;
  console.log('[Interceptor] addTransceiver intercepted, audio track:', track.label);
  realTrack = track;

  let transceiver: RTCRtpTransceiver;

  if (active && replacementTrack) {
    transceiver = _origAddTransceiver.call(this, replacementTrack, init);
  } else if (active && !replacementTrack) {
    transceiver = _origAddTransceiver.call(this, track, init);
    senders.add(transceiver.sender);
    void setupPipeline(track).then(() => {
      if (active && replacementTrack) {
        _origReplaceTrack.call(transceiver.sender, replacementTrack).catch((err: Error) => {
          console.error('[Interceptor] async transceiver replaceTrack failed:', err);
        });
      }
    });
    return transceiver;
  } else {
    transceiver = _origAddTransceiver.call(this, track, init);
  }

  senders.add(transceiver.sender);
  postOut({ type: 'interpreter-track-attached' });
  return transceiver;
};

// Also handle addTransceiver('audio', {}) — kind string without a track
// Meet might create a transceiver with just the kind, then set the track later via replaceTrack
const _origAddTransceiverKind = RTCPeerConnection.prototype.addTransceiver;
// We already patched addTransceiver above; for the string-kind case, senders are
// captured via the RTCRtpSender.replaceTrack patch below when Meet assigns a real track.

// Patch replaceTrack on RTCRtpSender
RTCRtpSender.prototype.replaceTrack = function (
  newTrack: MediaStreamTrack | null
): Promise<void> {
  if (newTrack && newTrack.kind === 'audio') {
    // Check if this is our own replacement call (avoid infinite loop)
    if (newTrack === replacementTrack) {
      return _origReplaceTrack.call(this, newTrack);
    }

    console.log('[Interceptor] replaceTrack intercepted, new audio track:', newTrack.label);
    realTrack = newTrack;
    senders.add(this);

    if (active) {
      // Re-wire the pipeline with the new real track
      void setupPipeline(newTrack).then(() => {
        if (active && replacementTrack) {
          _origReplaceTrack.call(this, replacementTrack).catch((err: Error) => {
            console.error('[Interceptor] re-wire replaceTrack failed:', err);
          });
        }
      });
      return Promise.resolve();
    }
  }

  return _origReplaceTrack.call(this, newTrack);
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
