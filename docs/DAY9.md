# Week 2 — Day 9: WebRTC audio

## Scope and provenance

Built on `origin/Rajeev` tip `29b8e4b` (Week 1, Days 1–7 + Day 8 signaling).
Client-only slice: standard WebRTC peer-to-peer audio via the browser's
`getUserMedia`, driven by the existing Day 8 server events. **Browser built-ins
only** — `navigator.mediaDevices.getUserMedia`, `RTCPeerConnection`,
`<audio>` elements. No Web Audio API, no new dependency, no server behavior
change.

The Mid-Project Review "Audio Check" this slice targets: *two browsers
successfully establish a WebRTC audio connection via the signaling server* —
visible as an overlay row that reaches `connected` with a climbing
`bytesReceived` counter.

Implementation commits (real dates, 2026-10-18):

- `7768026` — `client/src/webrtc/localMedia.js`: microphone access with the
  mandated constraints and typed failures (`permission_denied`, `no_device`,
  `insecure_context`); `release()` stops every track.
- `f8fb4da` — `client/src/webrtc/peerManager.js`: one `RTCPeerConnection` per
  edge, generation rules, ICE queueing, offer/answer, dependency-injected.
- `9a57135` — `client/src/webrtc/remoteAudio.js` (one `<audio autoplay
  playsinline>` per remote stream, hidden container) and `rtcStats.js`
  (~1 s `getStats()` poll: `connectionState`, inbound audio `bytesReceived`).
- `39a3138` — join-flow and `useSocket.js` integration: mic first (user
  gesture), then `join`; `closeAll()` on disconnect/reconnect/`session_expired`/
  re-join/unmount; the Join screen *Join with mic / Listen only* choice.
- `91deece` — `client/src/components/AudioStatus.jsx`: the read-only status
  overlay (mic state + per-peer name/connection state/received bytes, ≤1 Hz).
- `448cfdf` — 31 `node:test` cases (peer manager fakes, localMedia typed
  failures, remoteAudio lifecycle, rtcStats poll/cleanup, server signal
  rate-limit headroom proof).

Plus this documentation commit.

## Architecture

```
 JoinScreen (mic choice)                       AudioStatus overlay (≤1 Hz read)
        │                                              ▲ snapshot()
        ▼                                              │
 useSocket ── createLocalMedia() ── getUserMedia  peerManager ── createRtcStats()
     │                                                      │
     │  socket: joined / peer:connect / peer:disconnect / signal
     ▼                                                      ▼
 Day 8 gateway ── PeerGraph ── findNearby ($near)   remoteAudio → <audio> elements
```

The peer manager and the world state both live in refs: `signal` bursts,
`user:moved` and stats polls never re-render React. Only the overlay reads
anything on a timer, at most once per second, and only when the values changed.

## Module map

| File | Responsibility |
| --- | --- |
| `client/src/webrtc/localMedia.js` | `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl }, video: false })`; returns `{ ok, stream }` or `{ ok: false, reason, message }`; `release()` stops all tracks. |
| `client/src/webrtc/peerManager.js` | Registry `peerId -> { generation, pc, pendingCandidates, hasRemoteDescription }`; DI: `createPeerConnection`, socket-like emitter, logger, `localMedia`, `remoteAudio`, `stats`. |
| `client/src/webrtc/remoteAudio.js` | `attach(peerId, stream)` / `remove` / `removeAll`; hidden `.remote-audio` container; plain playback only. |
| `client/src/webrtc/rtcStats.js` | `watch` / `unwatch` / `stopAll` / `get` / `snapshot`; inbound audio `bytesReceived` summed over `inbound-rtp` entries. |
| `client/src/hooks/useSocket.js` | Creates the manager with the socket; `closeAll()` on disconnect (every reconnect passes through it), `session_expired`, re-join and unmount; re-acquires the mic silently on a reconnect when the user joined with mic. |
| `client/src/components/JoinScreen.jsx` | One extra field: *Join with mic / Listen only*. The submit click requests the mic before `join` is emitted. |
| `client/src/components/AudioStatus.jsx` | Mic on/off/listen-only + per-peer rows (`name`, `connectionState`, `bytesReceived`), polled ≤1 Hz. |

## Event flow (client side of the Day 8 contract)

| Event | Direction | Day 9 handling |
| --- | --- | --- |
| `join` | C → S | Emitted **after** the microphone request resolved (mic success or typed failure). |
| `joined` | S → C | `iceServers` stored as the fallback ICE list for `peer:connect`. |
| `peer:connect` | S → C | Create `RTCPeerConnection({ iceServers: event.iceServers \|\| joined.iceServers })`; mic on → `addTrack`, listen-only → `addTransceiver('audio', { direction: 'recvonly' })`; `initiator` → offer + `setLocalDescription` + `signal`. |
| `signal` (offer) | S → C | `setRemoteDescription` → flush queued candidates → `createAnswer` → `setLocalDescription` → `signal` answer. Stale generation or unknown peer: ignored. |
| `signal` (answer) | S → C | `setRemoteDescription` → flush queued candidates. Only applied in `have-local-offer`. |
| `signal` (candidate) | S → C | Before the remote SDP: queued (FIFO, flushed in arrival order right after `setRemoteDescription`); after: `addIceCandidate`. `null`/`undefined` (end-of-candidates) is skipped. |
| local ICE | C → S | `pc.onicecandidate` → `signal { to, generation, data: { type: 'candidate', candidate } }`, trickled as gathered (socket down: dropped, never buffered). |
| `peer:disconnect` | S → C | Matching generation → close pc, remove the audio element, delete the registry entry, unwatch stats. Unknown peer or stale generation: ignored. |

### Edge rules the tests pin down

- **One connection per peer, always.** A `peer:connect` with a *newer*
  generation closes the old pc first; same/older generations are ignored as
  duplicate/stale. A signal whose `generation` does not equal the edge's is
  dropped.
- **ICE race never corrupts state.** Candidates that arrive before the remote
  description sit in `pendingCandidates` and are replayed in order afterwards;
  one rejected candidate is logged and the rest still flush.
- **No auto-retry.** `failed`/`closed` cleans the edge up; the server
  re-creates it through `peer:connect` when the pair is in earshot again.
- **`closeAll()` leaves nothing behind.** Zero connections, zero audio
  elements, zero stats timers, zero active tracks (the microphone LED goes
  off). It runs on socket disconnect (which every reconnect passes through),
  `session_expired`, re-join and unmount.
- **Errors never crash the UI.** Every socket handler is wrapped; async
  rejections are caught and logged through the injected logger.

## Microphone flow

1. The Join button click (a genuine user gesture) requests the microphone
   first, then `join` is emitted.
2. Typed failure (`permission_denied`, `no_device`, `insecure_context`) → a
   clear message on the join screen and in the overlay, and the session joins
   **listen only**: recvonly transceivers, still hearing everyone.
3. On a Socket.io reconnect the mic is re-acquired silently (permission is
   already granted, no prompt) before the re-join, so new edges carry audio
   again after `closeAll()` stopped the old tracks.

## Signal rate limit — server unchanged

A user stepping into a cluster opens up to ~10 edges at once. Pessimistic per
socket: 10 edges × (1 SDP + 7 trickled candidates) = **80 signals in 500 ms**.
The shipped bucket (`SOCKET_SIGNAL_BURST=100`, `SOCKET_SIGNAL_EPS=30`)
budgets 100 + 30 × 0.5 = **115** accepts in that window — 0 dropped, 35
tokens of margin; even the whole burst fits inside the burst capacity alone.
Real browsers send 3–5 signals per edge, so the true load is ~40. No change
was needed and none was made; `server/test/signal.ratelimit.headroom.test.js`
proves it (and re-proves a flood is still dropped).

## Tests

`node --test` only (no framework), no browser required:

| File | Covers |
| --- | --- |
| `client/test/webrtc.peerManager.test.js` | initiator offer / non-initiator answer, ICE queueing + in-order flush (offer and answer paths), stale generation + unknown peer ignored, newer-generation replacement (one pc per peer), `peer:disconnect` + stale disconnect, failed-connection cleanup without retry, `closeAll()` zero-left-behind, listen-only recvonly transceiver, handler exceptions logged, no signaling while the socket is down. |
| `client/test/webrtc.localMedia.test.js` | typed `permission_denied` / `no_device` / `insecure_context` / `not_supported`, the exact constraints object, release stops all tracks, stream reuse while live, error-name classification. |
| `client/test/webrtc.remoteAudio.test.js` | per-peer `<audio autoplay playsinline>` in the hidden container, replace/remove/removeAll lifecycle, no-DOM no-op. |
| `client/test/webrtc.rtcStats.test.js` | ~1 s poll, `bytesReceived` sums audio `inbound-rtp` only, unwatch/stopAll leave zero timers, failing `getStats` is contained. |
| `server/test/signal.ratelimit.headroom.test.js` | the 10-peer burst fits the shipped signal bucket (0 dropped) and a flood is still stopped. |

## Verification in this environment (2026-10-18)

- Fresh installs: `npm run install:all` — clean, 0 vulnerabilities.
- `npm run build --prefix client` — succeeds.
- Root `npm test`:
  - **server: 103 tests — 74 passed, 0 failed, 29 skipped.** The 29 skips are
    the real-MongoDB suites (Day 3/7/8 integration): no MongoDB runs in this
    sandbox (`connect ECONNREFUSED 127.0.0.1:27017`). Per the project rule
    *skipped must be 0 with a local MongoDB*, the MongoDB-dependent behavior is
    **NOT VERIFIED** here — rerun `npm test` with MongoDB up and expect 103
    passed / 0 skipped. The 74 non-DB tests (including the 2 new headroom
    tests) all pass.
  - **client: 132 tests — 132 passed, 0 failed, 0 skipped** (31 new Day 9).
- Week 1–8 behavior: untouched server code (only a new test file), existing
  suites still green; no secrets; `git status` clean.

### NOT VERIFIED here

1. **The real two-browser audio check** (the Mid-Project Review demo): this
   sandbox has no headless Chromium/Firefox and no way to run two real
   browsers, so no actual `connectionState`/`bytesReceived` numbers are
   claimed. Exact manual steps are below; the fake-device flags need no
   hardware.
2. **Real-MongoDB integration behavior** (29 skipped tests), as above.
3. **Browser console cleanliness** of the new code: by construction the code
   logs nothing on success and routes failures to the logger, but this cannot
   be *proven* without a browser run — treat it as part of the manual pass.

### Manual two-browser run (the Audio Check)

```bash
npm run seed            # once, needs MongoDB
npm run dev:server      # terminal 1
npm run dev:client      # terminal 2 — open the URL in two windows
```

1. Headphones on both windows (mandatory — open mics + speakers feed back).
2. Window A: name "Ada", room `lobby`, **Join with mic**. Window B: name "Bob",
   room `lobby`, **Join with mic** (or *Listen only* to prove the recvonly
   path).
3. Walk the avatars within 100 px of each other. Expect within ~2 s: the
   overlay in *both* windows shows a row `Bob`/`Ada` → `connected`, and the
   bytes counter climbs steadily (audio is flowing). With two mics, each hears
   the other.
4. Walk apart. The row disappears (server `peer:disconnect`); the counters are
   gone — nothing is left behind.
5. Kill one window: the other's row disappears. Reload the page mid-session
   and the mesh rebuilds after the re-join.

No-hardware variant: launch Chrome with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` and repeat
in two windows — `getUserMedia` succeeds with a fake tone and the same
offer/answer/ICE path runs end to end.

### Troubleshooting (manual pass)

- **Mic permission denied** → the padlock → Site settings → Microphone → Allow,
  join again; the overlay must show `mic on` afterwards.
- **No audio** → check `bytesReceived` first: climbing bytes + silence means
  playback (tab/OS volume, autoplay policy after a gesture); frozen `0 B` +
  `connecting` means ICE — same machine/LAN works with STUN-only, strict
  networks need a TURN relay (out of scope).
- **`insecure_context` notice** → use `https://` or `localhost`; any other
  http host can never capture audio.
- **STUN-only limitation** → the default `ICE_SERVERS` has no TURN; symmetric
  NATs across different networks may fail to connect. On localhost/LAN this
  never bites.
