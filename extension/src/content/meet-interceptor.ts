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

// Audio pipeline nodes
let audioCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let replacementTrack: MediaStreamTrack | null = null;

// Mirror mute state from real track to replacement track
let enabledObserverInterval: ReturnType<typeof setInterval> | null = null;

// ─── Inline AudioWorklet (Blob URL) ──────────────────────────────────────────
// Cannot reference chrome-extension:// URLs from the page's main world, so we
// embed the processor as a Blob URL created at runtime.

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
    console.log('[Interceptor] Audio pipeline ready');
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

function playTranslated(audioBytes: number[]): void {
  if (!audioCtx || !destination) return;

  const bytes = new Uint8Array(audioBytes);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  audioCtx.decodeAudioData(
    arrayBuffer,
    (decoded) => {
      if (!audioCtx || !destination) return;
      const source = audioCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(destination);
      source.start();
    },
    (err) => {
      console.error('[Interceptor] decodeAudioData failed:', err);
    }
  );
}

// ─── Activate / Deactivate ────────────────────────────────────────────────────

async function activate(): Promise<void> {
  active = true;

  if (realTrack) {
    await setupPipeline(realTrack);

    if (replacementTrack) {
      for (const sender of senders) {
        try {
          _origReplaceTrack.call(sender, replacementTrack);
        } catch (err) {
          console.error('[Interceptor] replaceTrack (activate) failed:', err);
        }
      }
    }
  }
}

function deactivate(): void {
  active = false;

  // Swap senders back to the real track before tearing down the pipeline
  if (realTrack) {
    for (const sender of senders) {
      try {
        _origReplaceTrack.call(sender, realTrack);
      } catch (err) {
        console.error('[Interceptor] replaceTrack (deactivate) failed:', err);
      }
    }
  }

  teardownPipeline();
}

// ─── RTCPeerConnection / RTCRtpSender patching ───────────────────────────────
// Patch immediately — before any page script (including Google Meet) runs.

const _origAddTrack = RTCPeerConnection.prototype.addTrack;
const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;

RTCPeerConnection.prototype.addTrack = function (
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  if (track.kind !== 'audio') {
    return _origAddTrack.call(this, track, ...streams);
  }

  // Save the real mic track
  realTrack = track;

  let sender: RTCRtpSender;

  if (active && replacementTrack) {
    // Pipeline already running — use replacement track
    sender = _origAddTrack.call(this, replacementTrack, ...streams);
  } else if (active && !replacementTrack) {
    // Active but pipeline not yet ready — pass real track and set up async
    sender = _origAddTrack.call(this, track, ...streams);
    senders.add(sender);
    void setupPipeline(track).then(() => {
      if (active && replacementTrack) {
        try {
          _origReplaceTrack.call(sender, replacementTrack);
        } catch (err) {
          console.error('[Interceptor] async replaceTrack failed:', err);
        }
      }
    });
    return sender;
  } else {
    // Not active yet — pass real track through, save sender for later
    sender = _origAddTrack.call(this, track, ...streams);
  }

  senders.add(sender);
  postOut({ type: 'interpreter-track-attached' });
  return sender;
};

RTCRtpSender.prototype.replaceTrack = function (
  newTrack: MediaStreamTrack | null
): Promise<void> {
  if (newTrack && newTrack.kind === 'audio') {
    realTrack = newTrack;

    if (active) {
      // Re-wire the pipeline with the new real track
      void setupPipeline(newTrack).then(() => {
        if (active && replacementTrack) {
          try {
            _origReplaceTrack.call(this, replacementTrack);
          } catch (err) {
            console.error('[Interceptor] re-wire replaceTrack failed:', err);
          }
        }
      });
      // Return resolved promise — Meet doesn't need to wait for the async setup
      return Promise.resolve();
    }
  }

  return _origReplaceTrack.call(this, newTrack);
};

// ─── postMessage listener ─────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  // Only handle messages from the same window tagged as interpreter-ext
  if (event.source !== window) return;
  const msg = event.data as InterpreterMessage;
  if (!msg || msg.source !== 'interpreter-ext') return;

  switch (msg.type) {
    case 'interpreter-activate':
      void activate();
      break;

    case 'interpreter-deactivate':
      deactivate();
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

console.log('[Interceptor] RTCPeerConnection and RTCRtpSender patched');
