# Known Limitations

Scope: **Final Project Review** (`2026-10-31`, covering the complete ProxiSpeak ecosystem through 60 FPS Canvas Rendering, Single-Origin Production Serving, Deployment Preparation, and Hardening). These are limits of the current implementation and of the checks actually run in this environment—not claims about what a browser or another deployment must do.

## Audio and browser behavior

### Live audible audio and real-browser GPU frame pacing are not verified here

Node tests use fake `RTCPeerConnection`, media, `AudioContext`, stats, and 2D `<canvas>` context objects. They verify protocol, maths, operation equivalence, allocation discipline, and cleanup logic—not microphone capture, codecs, speakers, echo, GPU rasterization/compositing, or what a person hears or sees on a physical monitor. Neither live two-browser hearing tests nor a real-browser 60-second GPU frame-pacing run could be executed in this sandbox.

The scale and mesh checks use Socket.io clients and signaling payloads; they do not create 50 real browser peer connections. Their `N = 50` results are mesh-policy evidence, not browser media or rendering measurements.

### STUN-only default; no provisioned TURN

The example ICE configuration contains public STUN only (`stun:stun.l.google.com:19302`). Restrictive or symmetric NATs (such as college/university Wi-Fi, corporate firewalls, or mobile carrier NATs) can prevent direct peer connections. No TURN relay service or SFU media server is provisioned or tested (outside the project specification).

### No custom ICE restart policy

`PeerManager` deliberately does not auto-retry a failed peer connection. Later server graph lifecycle events may create a new generation, but there is no dedicated ICE-restart or media-recovery controller. Network mobility and long-lived browser sessions need separate validation.

### Autoplay and Safari interruption recovery need browser validation

The hint covers `suspended` and `interrupted`; Join, page pointer, and visible-tab paths call `resume()`, and these paths have unit tests. Real autoplay policies, phone calls, Bluetooth route changes, and Safari versions were not exercised. A user may still need another gesture or browser intervention.

### Line-of-sight-only occlusion; no movement collision or frequency filtering

Room layouts and furniture/wall obstacles are persisted in MongoDB with optimistic concurrency (`layoutRevision`), validated schemas, real-time `room:layout` live sync, and client-side straight-line `GainNode` sound occlusion (`docs/OCCLUSION.md`). Remaining limits:

- **Line-of-sight ray only**: Occlusion tests a single 2D straight line segment between peer centers using multiplicative `GainNode` transmission (`gainForDistance(d) * T`); there is no wave diffraction around corners, thickness-dependent attenuation, height/elevation, frequency-dependent low-pass filtering (`BiquadFilterNode`), or acoustic reflection/reverb.
- **Client-side gain only**: Blocked peers inside `PEER_DISCONNECT_RADIUS_PX` remain WebRTC-connected so unblocking is instant without ICE renegotiation; network bandwidth is still consumed while occluded.
- **No movement collision**: Avatars walk freely across obstacle rectangles (segments with an endpoint inside an obstacle still count that obstacle).

### Stereo panning without head orientation or HRTF

Each peer's audio chain (`MediaStreamAudioSourceNode -> StereoPannerNode -> GainNode -> destination`) pans left/right from relative 2D screen coordinates (`pan = 0.85 * dx / max(dist, 30)`, `docs/PANNING.md`). Remaining limits:

- **No head orientation / avatar facing**: Avatars have no facing angle in the protocol; larger world `x` is always heard toward the right ear and smaller `x` toward the left ear.
- **No HRTF, elevation, or front/back cues**: Uses Web Audio `StereoPannerNode` equal-power stereo panning, not a 3D HRTF `PannerNode`, vertical elevation, Doppler, or room reverb. When `createStereoPanner` is unavailable, audio falls back cleanly to centred mono attenuation.

## Canvas rendering behavior

### `requestAnimationFrame` follows the display refresh rate

`createCanvasLoop` (`client/src/canvas/frameLoop.js`, `docs/RENDERING.md`) caches the static room on an offscreen `<canvas>` and runs a single `requestAnimationFrame` callback:

- **Display-governed cadence (`rAF` follows the panel)**: Browser `requestAnimationFrame` fires at the display's native refresh rate (e.g., `60 Hz` on standard panels, `120 Hz` / `144 Hz` on ProMotion/high-refresh displays, or `30 Hz` under OS low-power throttling). The loop neither synthesizes frames faster than the display nor artificially throttles `120/144 Hz` panels down to `60 Hz`; movement uses elapsed rAF timestamps (`dt` clamped to `MAX_FRAME_DT_MS = 50` ms) so world speed is identical across refresh rates.
- **Dropped-frame threshold calibration**: `DROPPED_FRAME_MS = 25` assumes a `>= 60 Hz` panel (`16.67 ms` refresh). On a `30 Hz` power-saving display (`33.3 ms` refresh), every interval exceeds `25 ms` even without missed refreshes.
- **4K HiDPI pixel cap (`MAX_BACKING_PIXELS = 16,000,000`)**: On very large high-DPR viewports (such as `3840 × 2160` at `DPR 3`), effective DPR is reduced proportionally (`~1.39`) so each canvas stays `<= 64 MB` RGBA and below WebKit/mobile GPU texture limits (`~16.7M` pixels), trading full `3x` sharpness for a guaranteed non-blank canvas.
- **Continuous loop for remote interpolation**: The loop does not skip frames via dirty flags when local input is idle so remote avatar interpolation remains smooth; background tabs (`document.hidden`) pause drawing until visible again.

## Mesh, auth, and multi-instance operation

### No user authentication system (shared admin token only)

The join protocol has no user accounts, login, or session identity. The room layout save API (`PUT /api/rooms/:roomId/layout`) relies solely on a single shared secret `ROOM_ADMIN_TOKEN` passed in `x-room-admin-token` (compared in constant time; unset token disables edits with `403 editing_disabled`). There is no role-based access control or automated token rotation.

### A closer newcomer does not evict an existing peer when capped

At the default cap (`MAX_PEERS_PER_USER = 8`), sync fills available slots nearest-first, but it does not drop an existing connected peer merely because a closer user walks up later. A nearby user can remain unconnected until an existing peer walks past `PEER_DISCONNECT_RADIUS_PX` (`115` px) or leaves.

### Unlimited mode does not scale like an SFU

`MAX_PEERS_PER_USER=0` preserves unlimited behavior for compatibility and tests. A full WebRTC mesh grows quadratically (`N * (N - 1) / 2` edges) and places encode/decode/upload work in every browser.

### Per-instance in-memory rate limiters

Socket `move` / `signal` token buckets and the REST layout-save IP rate limiter (`10` requests/min/IP) live in process memory. Across `K` server instances without a shared Redis rate-limit store, each instance enforces its own local budget independently.

### Sticky sessions required behind a load balancer

Each joined Socket.io session and its local socket state belong to the Node process that accepted it. Behind a multi-instance load balancer, sticky sessions (or direct WebSocket transport without unpinned HTTP long-polling hops) are required; Redis Pub/Sub fans out events across instances but does not migrate open sockets between processes.

### Redis is optional, but normal operation still needs MongoDB

An empty `REDIS_URL` selects in-memory single-instance edge state. It does not replace MongoDB presence/geospatial/room storage. If MongoDB is unavailable, the normal server (`npm start`) does not accept traffic.

### Degraded Redis mode and full Redis wipes

During Redis failure, already-established WebRTC media is peer-to-peer in principle, while cross-instance broadcasts and shared edge mutations degrade until reconnect reconciliation runs (moves during a Redis outage log a `WARN` on the server and emit a `server_error` notice to the client without dropping the socket). A full Redis wipe (`FLUSHALL`) rebuilds current edges with monotonic generations above surviving floors rather than restoring historical Redis records.

### Crash cleanup, position fencing, and Redis key / RSS growth watch items

Orphan-edge and stale-presence sweeps run on intervals (`30 s` default, validating up to `100` live edges per pass). MongoDB presence writes and Redis revision bumps are fenced and retried once, not a single distributed transaction.

**Redis key count and Node RSS growth remain operational watch items** under sustained churn:

| Run (60 users, 2 instances, 180 s) | Baseline RSS MB | First joined RSS MB | Last RSS MB | Post-cleanup RSS MB | Peak Redis keys during churn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 108.19 | 125.84 | 161.78 | 161.49 | 1,761 |
| 2 | 100.13 | 118.46 | 164.55 | 162.53 | 1,783 |
| 3 | 109.39 | 126.71 | 165.29 | 163.32 | 1,799 |

Tracked application maps and Redis keys returned to `0` after all clients left, while V8/allocator resident set size (`RSS`) remained ~`54–62 MB` above pre-join baseline after one 180 s run. Longer multi-hour soak profiling is needed before claiming bounded long-term RSS in production.

## HTTP, security, and deployment

### CORS is not authentication

Origin checks (`CLIENT_URL`) restrict browser cross-origin requests (same-origin only when `CLIENT_URL` is empty in production for both HTTP and Socket.io); they do not authenticate non-browser clients.

### Dependency audit status

On `2026-10-31`, both `npm audit --prefix server` and `npm audit --prefix client` report **`0` vulnerabilities** (`qs` patched to `6.16.2` and `vite` patched to `6.4.5` via `npm audit fix` without `--force`).

### Single-origin hosting vs. excluded infrastructure

Express serves `client/dist/` directly on the same origin as `/api/*`, `/health`, and `/socket.io`, with `railway.json` and `docs/DEPLOY.md` provided for cloud deployment. Dockerfiles, Kubernetes manifests, SFU media servers, and TURN relay servers are intentionally excluded per the project specification.

## Verification limits in this sandbox (`2026-10-31`)

- Without services: server **197 passed / 77 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests).
- With real Redis (`redis-server` `6.2.14`): server **234 passed / 40 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests).
- Embedded two-instance Redis `mesh-check` passed **37/37**.
- Single-origin production-mode HTTP + static + SPA + Socket.io smoke test passed on `0.0.0.0`.
- All `40` remaining server skips require MongoDB (`mongod` unavailable under sandbox egress rules). Real MongoDB spatial audits, Mongo-backed `npm start` / `npm run seed` / `room-layout` CLI runs, two-browser audible audio, and real-browser 60 FPS GPU compositing remain **NOT VERIFIED** here. See `docs/DEPLOY.md`, `docs/DEMO_FINAL.md`, `docs/ROOM_PERSISTENCE.md`, `docs/OCCLUSION.md`, `docs/PANNING.md`, `docs/RENDERING.md`, and `docs/REQUIREMENTS_TRACE.md`.
