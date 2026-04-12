# Outgoing Voice Translation via RTC Interception

**Date:** 2026-04-12
**Status:** Approved for implementation

## Problem

Currently the extension only translates **incoming** audio (tab audio from remote speakers). Users need to also have their **own voice** translated and sent to other Google Meet participants in the target language.

## Approach: RTCPeerConnection.addTrack Override

Inject a main-world content script that monkey-patches `RTCPeerConnection.prototype.addTrack` and `RTCRtpSender.prototype.replaceTrack`. When Meet adds the user's mic audio track to the peer connection, we intercept it, capture PCM from the real mic, send it through the existing backend translation pipeline, and feed translated audio into a replacement track that Meet sends to other participants.

## Architecture

### Data Flow

```
User speaks into mic
  |
RTCPeerConnection.addTrack intercepted by meet-interceptor.ts (main world)
  |
Real mic -> AudioContext -> AudioWorklet (PCM 16kHz capture)
  |
PCM chunks -> window.postMessage -> meet-bridge.ts (content script, isolated world)
  |
chrome.runtime.connect port -> background.ts -> WebSocket #2 -> backend
  |
Backend: Azure STT -> Translation -> TTS
  |
Translated audio bytes <- WebSocket #2 <- background.ts
  |
chrome port -> meet-bridge.ts -> window.postMessage -> meet-interceptor.ts
  |
Decode audio -> AudioBufferSource -> MediaStreamDestination -> replacement track
  |
Google Meet sends replacement track to other participants via WebRTC
```

### New Files

1. **`extension/src/content/meet-interceptor.ts`** — Main-world script (`"world": "MAIN"`)
   - Patches `RTCPeerConnection.prototype.addTrack` to intercept audio tracks
   - Patches `RTCRtpSender.prototype.replaceTrack` to catch Meet's internal track swaps
   - Runs AudioContext + inline AudioWorklet for PCM capture from real mic
   - Decodes translated audio and plays into MediaStreamDestination
   - Communicates with bridge via `window.postMessage`

2. **`extension/src/content/meet-bridge.ts`** — Isolated-world content script (bridge)
   - Relays binary PCM between main-world interceptor and background service worker
   - Uses `chrome.runtime.connect` port for persistent streaming connection
   - Listens to `window` messages from interceptor, forwards via port
   - Receives translated audio from port, posts back to interceptor

### Modified Files

3. **`extension/src/content/meet-widget.ts`** — Add "Translate My Voice" toggle
   - Second independent toggle alongside existing "Start Translation"
   - Sends `start-mic-translation` / `stop-mic-translation` to background
   - Shows outgoing transcript in a separate section or with different styling

4. **`extension/src/background.ts`** — Manage outgoing WebSocket
   - New `micState` object parallel to existing `state`
   - Opens second WebSocket to `ws://localhost:8000/ws/translate` with swapped language pair
   - Handles `mic-audio-data` messages from bridge port
   - Forwards translated audio back through the port
   - Handles `start-mic-translation` / `stop-mic-translation` from widget

5. **`extension/manifest.json`** — Register new content scripts
   - Add `meet-interceptor.ts` with `"world": "MAIN"`, `"run_at": "document_start"`
   - Add `meet-bridge.ts` with default isolated world

## Detailed Component Design

### meet-interceptor.ts (Main World)

```
Globals:
  - audioCtx: AudioContext | null
  - micSource: MediaStreamAudioSourceNode | null
  - destination: MediaStreamDestinationNode | null
  - replacementTrack: MediaStreamTrack (from destination.stream)
  - realTrack: MediaStreamTrack | null
  - senders: Set<RTCRtpSender> (all senders we've intercepted)
  - active: boolean (outgoing translation enabled)
  - workletReady: boolean

On load (document_start):
  1. Save originals: _origAddTrack = RTCPeerConnection.prototype.addTrack
                     _origReplaceTrack = RTCRtpSender.prototype.replaceTrack
  2. Patch addTrack:
     - If track.kind !== 'audio', pass through to original
     - If not active, save reference but pass through
     - If active: save realTrack, set up audio pipeline, return original.call(pc, replacementTrack, stream)
     - Store the returned RTCRtpSender in senders set
  3. Patch replaceTrack:
     - If new track is audio and active: intercept same as addTrack
     - If new track is audio and not active: let through, update realTrack reference
     - If not audio: pass through

Audio pipeline setup (called when activating):
  1. Create AudioContext at 48kHz
  2. Create MediaStreamSource from realTrack's stream
  3. Register inline AudioWorklet (Blob URL) for PCM capture
  4. Connect: micSource -> workletNode (captures PCM, posts to main thread)
  5. Create MediaStreamDestination (silence by default)
  6. replacementTrack = destination.stream.getAudioTracks()[0]
  7. workletNode.port.onmessage -> downsample 48k->16k, float->int16, postMessage to bridge

On translated audio received (from bridge via window message):
  1. Receive audio bytes (WAV/MP3)
  2. Decode using audioCtx.decodeAudioData()
  3. Create AudioBufferSourceNode, connect to destination
  4. source.start() -> audio flows into replacementTrack -> Meet sends to peers

Activate (message from bridge):
  1. Set active = true
  2. Set up audio pipeline with current realTrack
  3. For all senders: sender.replaceTrack(replacementTrack)

Deactivate (message from bridge):
  1. Set active = false
  2. Tear down audio pipeline
  3. For all senders: sender.replaceTrack(realTrack)
```

### meet-bridge.ts (Isolated World, Content Script)

```
On load:
  - Listen for window messages from interceptor (postMessage)
  - On 'start-mic-translation' from widget/background:
    - Open port: chrome.runtime.connect({name: 'mic-capture'})
    - Post 'activate' to interceptor via window.postMessage
  - On 'stop-mic-translation':
    - Post 'deactivate' to interceptor
    - Disconnect port

Message relay:
  - interceptor -> bridge (window message 'mic-pcm'): forward ArrayBuffer via port
  - background -> bridge (port message 'mic-translated-audio'): forward to interceptor via window.postMessage
  - background -> bridge (port message 'mic-transcript'): forward to widget (or interceptor posts to widget)
```

### background.ts Changes

```
New state:
  micState = {
    isTranslating: boolean
    micSocket: WebSocket | null   // WS#2 for outgoing
    sourceLang: string            // user's language
    targetLang: string            // target language for others
    port: chrome.runtime.Port | null
  }

New port listener:
  chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'mic-capture') {
      micState.port = port
      port.onMessage.addListener(msg => {
        if (msg.type === 'mic-audio-data') {
          // Forward PCM binary to micSocket
          micSocket.send(new Uint8Array(msg.data).buffer)
        }
      })
      port.onDisconnect.addListener(() => stopMicTranslation())
    }
  })

micSocket.onmessage:
  - Binary (translated audio) -> port.postMessage({type: 'mic-translated-audio', data: [...]})
  - JSON transcript/translation -> port.postMessage({type: 'mic-transcript', ...})
                                 -> also broadcastToPopup for UI

New message handlers:
  'start-mic-translation': open micSocket (WS#2), config with swapped langs
  'stop-mic-translation': close micSocket, notify port
```

### meet-widget.ts UI Changes

Add below existing action button:
- "Translate My Voice" toggle button (same style, different label/icon)
- When toggled ON: sends `start-mic-translation` with sourceLang/targetLang to background
- When toggled OFF: sends `stop-mic-translation`
- Outgoing status indicator (separate from incoming)
- Outgoing transcripts shown with a mic icon prefix to distinguish from incoming

## Message Protocol

### New Messages

| From | To | Type | Payload |
|------|----|------|---------|
| Widget | Background | `start-mic-translation` | `{sourceLang, targetLang}` |
| Widget | Background | `stop-mic-translation` | — |
| Bridge | Background (port) | `mic-audio-data` | `{data: ArrayBuffer}` |
| Background (port) | Bridge | `mic-translated-audio` | `{data: number[]}` |
| Background (port) | Bridge | `mic-transcript` | `{text, isFinal}` |
| Background (port) | Bridge | `mic-translated-text` | `{text}` |
| Bridge | Interceptor (postMessage) | `interpreter-activate` | — |
| Bridge | Interceptor (postMessage) | `interpreter-deactivate` | — |
| Bridge | Interceptor (postMessage) | `interpreter-translated-audio` | `{data: number[]}` |
| Interceptor | Bridge (postMessage) | `interpreter-mic-pcm` | `{data: ArrayBuffer}` |
| Interceptor | Bridge (postMessage) | `interpreter-track-attached` | — |

All postMessage events use a `{source: 'interpreter-ext', ...}` wrapper to avoid collisions with Meet's own messages.

## Toggle Behavior

- **Incoming (existing):** "Start Translation" captures tab audio, translates others' speech
- **Outgoing (new):** "Translate My Voice" intercepts mic, translates user's speech for others
- Both can run simultaneously on independent WebSocket connections
- Language pair is shared (source/target from widget selectors)
- Incoming uses: source=sourceLang, target=targetLang
- Outgoing uses: source=targetLang, target=sourceLang (user speaks targetLang's perspective is flipped — actually NO: if user speaks English and wants Spanish speakers to hear Spanish, outgoing source=en target=es, same direction)

Wait — clarification: The language selectors mean "I speak [source] and want to hear [target]". So:
- Incoming: STT in source (others speak source lang), translate to target, TTS in target
- Outgoing: STT in target... no. Let me think again.

Actually the widget has "Source" and "Target" where source = language being spoken (by others), target = language you want to hear. For outgoing translation:
- User speaks in their own language (= target, the language they understand)
- Translated to source language (= the language others speak)
- So outgoing WebSocket config: source_lang = targetLang, target_lang = sourceLang

This swap is handled in background.ts when opening WS#2.

## Edge Cases

1. **Meet mute/unmute:** Meet may stop/restart the track or toggle `track.enabled`. The interceptor watches for `replaceTrack` calls. For `enabled` toggling, we mirror it on the replacement track.
2. **Device switch in Meet:** Meet calls `replaceTrack` with a new mic track. Our patch catches this and re-wires the audio pipeline to the new track.
3. **Tab navigation away from meeting:** Content scripts unload. Interceptor state is lost, which is fine — WebRTC connections also close.
4. **Backend disconnection:** Bridge detects port disconnect or socket close, notifies interceptor to deactivate (swap back to real track).
5. **Silence during translation delay:** Between user speaking and translated audio arriving (~1s), the replacement track outputs silence. This is acceptable — like a slight connection delay.
