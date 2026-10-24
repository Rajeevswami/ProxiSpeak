# Known Limitations

This document lists the known limitations of ProxiSpeak as of the end of Week 3 (Day 14). Each item is honest and verified against the code.

## Mesh and peer management

### No peer eviction when capped

When `MAX_PEERS_PER_USER` is reached, new edges are rejected with `capped: true`. Existing edges are **never** dropped to make room for a closer newcomer. The candidate list is processed nearest-first, so a user's 8 closest neighbors get edges, but if a 9th user walks closer than one of the existing 8, no swap occurs.

**Impact:** In dense clusters, a user may be connected to 8 peers who are 90 px away while a 9th peer at 10 px is not connected.

**Mitigation:** The hysteresis band (100–115 px) reduces churn at the boundary, and the nearest-first ordering ensures the cap is filled with the closest available peers at the time of sync.

**Future work:** Consider an eviction policy that drops the farthest edge when a closer peer arrives, with a cooldown to prevent flapping.

### No TURN server (STUN only)

The default `ICE_SERVERS` configuration includes only a public STUN server. WebRTC connections between peers behind symmetric NATs may fail because STUN cannot establish a direct path.

**Impact:** Users on restrictive networks (corporate firewalls, mobile carriers with symmetric NAT) may not be able to connect audio.

**Mitigation:** The `ICE_SERVERS` environment variable can be set to include TURN servers with credentials. However, TURN requires a server with bandwidth capacity, which is out of scope for this project.

**Future work:** Document how to configure a TURN server (e.g., coturn) and provide example `ICE_SERVERS` values.

## Scaling and infrastructure

### Per-instance rate limiters

The `TokenBucket` rate limiters for `move` and `signal` events are per-socket, per-instance. They are **not** shared across instances via Redis. A user who connects to instance A and instance B simultaneously (e.g., via a load balancer without sticky sessions) gets double the rate limit.

**Impact:** Minimal in practice because a user typically has one socket. But a malicious client could spread connections across instances to multiply their rate limit.

**Mitigation:** Use sticky sessions (session affinity) in the load balancer so each user's sockets always hit the same instance.

### Sticky sessions required behind a load balancer

The Socket.io gateway stores session state (room, user data, peer graph registration) in-memory on each instance. If a user's requests are load-balanced across multiple instances, the session state is lost.

**Impact:** Without sticky sessions, users may see "not_joined" errors or lose their presence on reconnect.

**Mitigation:** Configure the load balancer for session affinity (e.g., Nginx `ip_hash`, AWS ALB sticky sessions, HAProxy `balance source`). The Redis adapter handles room fan-out across instances, but the socket session itself is instance-local.

**Future work:** Document load balancer configuration for common providers (Nginx, HAProxy, AWS ALB, Cloudflare).

### Edges not preserved across full Redis wipe

If Redis is completely wiped (e.g., `FLUSHALL` or a Redis restart without persistence), all edge state is lost. The `reconcileLocalUsers` function runs on Redis recovery and recreates edges based on current proximity, but edges that existed before the wipe are not restored from memory.

**Impact:** After a Redis wipe, users may briefly lose their audio connections until the next sync (triggered by movement or the orphan edge sweep).

**Mitigation:** Enable Redis persistence (RDB or AOF) to survive restarts. The orphan edge sweep also runs on boot and cleans up any stale edges.

**Future work:** Consider maintaining an in-memory edge cache that can be replayed into Redis on recovery.

## Audio quality and performance

### Audio quality not measured

The project does not measure or guarantee audio quality (bitrate, latency, jitter) in browser-to-browser WebRTC connections. Audio quality depends on the browser's WebRTC implementation, network conditions, and the ICE path (direct vs. relayed).

**Impact:** Users may experience varying audio quality depending on their network and browser.

**Mitigation:** The WebRTC `rtcStats` module collects inbound/outbound bytes and connection state, which can be used to estimate quality. However, no automated quality monitoring or alerts are implemented.

**Future work:** Integrate WebRTC stats collection (via `getStats()`) to measure audio bitrate, latency, and packet loss. Add quality metrics to the audio overlay.

### 60 FPS rendering not optimized

The canvas renderer runs at the browser's `requestAnimationFrame` rate (typically 60 FPS), but the rendering logic is not optimized for high user counts. Drawing 100+ avatars with obstacles and grid lines may cause frame drops on low-end devices.

**Impact:** Smooth movement may degrade in rooms with many users.

**Mitigation:** The renderer uses spatial partitioning (only draws avatars within the viewport) and avoids unnecessary redraws. However, no WebGL acceleration or offscreen canvas is used.

**Future work:** Optimize the renderer for 100+ users (e.g., batch draw calls, use OffscreenCanvas, implement level-of-detail for distant avatars).

## Browser compatibility

### Safari AudioContext "interrupted" state

Safari's `AudioContext` can enter an `interrupted` state (e.g., when a phone call arrives) in addition to the standard `suspended` state. The audio paused hint treats both states the same, but the resume logic may not work reliably in all Safari versions.

**Impact:** Safari users may need to click the page multiple times to resume audio after an interruption.

**Mitigation:** The `audioPausedHint` module detects both `suspended` and `interrupted` states and shows the hint. The existing visibility change handler attempts to resume the context when the tab becomes visible.

**Future work:** Test on Safari 16+ and add Safari-specific resume logic if needed.

### Chrome requires muted `<audio>` element for Web Audio

Chrome does not deliver remote WebRTC audio through the Web Audio API unless the same `MediaStream` is also attached to an `HTMLMediaElement`. The `audioMixer` creates a hidden `<audio autoplay playsinline muted>` element for each peer to satisfy this requirement.

**Impact:** Minor DOM overhead (one hidden audio element per peer). The element is muted, so only the Web Audio chain is audible (no double playback).

**Mitigation:** The hidden element is created once per peer and removed when the peer disconnects. No user-visible impact.

## Testing and verification

### Live browser audio not verified by automated tests

The WebRTC audio path (getUserMedia → RTCPeerConnection → Web Audio API → speakers) cannot be tested in Node.js. Automated tests cover the pure logic (attenuation curve, mixer state machine, peer manager protocol) but not the actual audio flow.

**Impact:** Audio bugs that only manifest in real browsers (e.g., codec issues, autoplay policy violations) may not be caught by tests.

**Mitigation:** The demo script (docs/DEMO_WEEK3.md) includes a manual two-browser audio check. The audio overlay shows connection state, distance, volume, and bytes, which can be verified visually.

**Future work:** Add Playwright or Puppeteer end-to-end tests that open two browser instances and verify audio flow.

### MongoDB and Redis tests skipped without services

Server tests that require MongoDB or Redis are skipped with a "NOT VERIFIED" message when the services are not available. This means some integration paths (e.g., geospatial queries, Redis edge store, multi-instance signaling) are not tested in CI environments without these services.

**Impact:** Regressions in MongoDB/Redis-dependent code may not be caught.

**Mitigation:** The test suite logs which tests are skipped and why. CI pipelines should provision MongoDB and Redis (or use in-memory mocks) to run the full suite.

**Future work:** Add Docker Compose or GitHub Actions workflows that spin up MongoDB and Redis for CI testing.

---

## Summary

ProxiSpeak is a functional prototype that demonstrates geospatial proximity audio with WebRTC, but it has several limitations typical of a 3-week student project:

* **Mesh:** No peer eviction, STUN only (no TURN)
* **Scaling:** Per-instance rate limiters, sticky sessions required, edges not preserved across Redis wipe
* **Audio:** Quality not measured, Safari quirks, Chrome hidden element workaround
* **Testing:** Live audio not automated, MongoDB/Redis tests skipped without services

These limitations are documented honestly and can be addressed in future iterations. The core functionality (proximity-based audio with bounded mesh and optional Redis scaling) is implemented, tested, and demo-ready.
