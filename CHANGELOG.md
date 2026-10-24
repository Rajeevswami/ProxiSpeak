# Changelog

All notable changes to ProxiSpeak, day by day. Dates are the real commit dates
from `git log`; short commit hashes are included so every entry can be checked
against the history.

Week 1 (Days 1–6) delivers the foundation: server, geospatial schema, realtime
channel, browser client and movement — with **no audio and no proximity queries**
(those are Week 2–4).

---

## Day 1 — 2026-10-10 — project skeleton

*Commits: `ccbcc59`, `2411a26`, `d1f1df2`*

**Added**

* Repository layout for `server/` and `client/`, `.gitignore`, `.env.example`
  (port, `MONGO_URI`, `CLIENT_URL`, socket limits), root `package.json` scripts.
* Express server skeleton: `server/src/config/index.js` (every tunable from
  `.env`, nothing else reads `process.env`), `server/src/utils/logger.js`,
  `server/src/app.js` (CORS, JSON body limit, `trust proxy`, `x-powered-by`
  off) and `GET /health`.
* Project README with the problem statement, tech stack, module map and the
  week-wise plan.

## Day 2 — 2026-10-11 — MongoDB and the geospatial schema

*Commits: `54ed1f2`, `9904223`, `abaf653`, `b4ddbac`, `04aae2c`, `7b7c584`, `70377ac`*

**Added**

* MongoDB connection lifecycle (`connectMongo` / `disconnectMongo` /
  `ensureIndexes`) with redacted connection strings in every log.
* `UserPresence` model — one document per connected avatar with pixels **and**
  the projected GeoJSON point, `location` indexed as `2dsphere`, unique
  `sessionId + roomId` upsert target, room/`lastSeen` lookup index.
* `Room` model — pixel dimensions, obstacle rectangles
  (`type`, `blocksAudio`, `attenuation`) and spawn points, stored as data.
* Pixel ⇄ GeoJSON projection (1 px = 0.1 m, tangent plane) with unit tests, and
  the `$centerSphere` / `$maxDistance` helpers the proximity queries will use.
* `presenceStore.upsertPosition` / `removeUser`, the idempotent seed script
  (`lobby`, `studio`, `lounge`) and the Day 2 README section.

## Day 3 — 2026-10-12 — realtime channel

*Commits: `675730e`, `225bb76`, `91a26cb`, `e62fbfd`, `d2a85e6`, `79e4204`, `62110de`, `bac83d7`, `766afc3`, `40f5ed9`*

**Added**

* Socket.io attached to the existing HTTP server (one port for HTTP and the
  websocket), with the same `CLIENT_URL` origin policy.
* `join` → presence write → room channel → `user:joined` → `joined` snapshot
  (room blueprint + everyone inside, newcomer included).
* `move` → validated, clamped into the room, step-capped, rate-limited
  (token bucket, 30 events/s per socket), persisted and broadcast as
  `user:moved` to the room only.
* Disconnect cleanup (`user:left` + delete the socket's own presence row) and a
  single shutdown routine that drains in-flight presence cleanups before
  MongoDB closes.
* Payload validation module, a documented `error` event
  (`invalid_payload`, `room_not_found`, `not_joined`, `already_joined`,
  `server_error`), integration + validation tests, and the Day 3 README section.

**Fixed**

* A double `join` from one socket could create two documents — joins are now
  serialised per socket.
* A socket disconnecting mid-join left a ghost presence row — the aborted join
  cleans up after itself.
* Shutdown could cut off in-flight presence deletes and leave ghost rows.

## Day 4 — 2026-10-13 — React canvas client

*Commits: `bc10edd`, `740861f`, `918e476`, `25139b5`, `0ee249e`, `078f3af`, `5cf7be0`, `07dfb18`, `2129851`, `24e7e10`, `18a9409`*

**Added**

* Vite + React client with a dev proxy for `/socket.io` and `/api`, and one
  place (`client/src/config.js`) that resolves the server URL.
* `useSocket` hook: the world (room + avatars) lives in a ref, so realtime
  updates never re-render React; `joined` / `user:joined` / `user:moved` /
  `user:left` / `error` are applied to it.
* Join screen with local validation and honest error text, including
  `room_not_found`.
* Canvas world: letterboxed floor, grid, obstacles coloured per type, avatars
  with truncated name labels and a highlighted `(you)` avatar;
  devicePixelRatio-aware sizing recomputed on resize.
* Coordinate-helper unit tests (`computeViewport`, `worldToScreen`,
  `screenToWorld`) and the Day 4 README section.

**Fixed**

* Avatar names were lost when a `joined` snapshot was re-served; the server now
  includes `name` in the snapshot and the client keeps a known name as fallback.
* Removed dead code and per-frame allocations from the renderer.

## Day 5 — 2026-10-14 — movement and broadcasting

*Commits: `be2c2dc`, `0c848c3`, `7dc8a91`, `f8b7723`, `8ac65e3`, `c258322`, `b8f6b43`, `abc7609`, `1b94e2a`, `948b0ae`*

**Added**

* Pure movement maths: WASD + arrow keys, normalised diagonals, constant
  300 px/s scaled by frame time, room-bounds clamping, frame-delta cap for
  hidden tabs, click-to-move with exact arrival.
* `useMovement` + a frame-rate-independent movement controller driven by the
  canvas's single `requestAnimationFrame` loop — zero React renders per frame,
  held keys cleared on window blur, movement keys ignored while typing.
* `move` broadcast throttle: at most 10 Hz, only on real change, plus the exact
  resting position after a stop.
* Remote-avatar interpolation `1 − exp(−12·dt)` with a snap beyond 200 px, and
  unit tests for all of it (60 Hz vs 144 Hz, throttle, interpolation, epoch
  reset on a fresh snapshot).
* Server-limit check documenting that a legitimate 10 Hz client is never
  rate-limited or step-corrected (0 dropped, 0 capped in both simulations), so
  the server stayed unchanged; Day 5 README section.

**Fixed**

* A zero-duration frame cancelled a pending click target.
* Startup failures dumped a stack trace instead of one actionable line; the
  default log level now goes through config; the avatar renderer reuses one
  scratch point instead of allocating per avatar.

## Day 6 — 2026-10-15 — Week 1 polish, tests and documentation

*Commits: `b16f84b`, `967494e`, `a1ce339`, `4956407`, `309d365`, `6406db6`, `761827f`, `ab24747`, `0a6db86`, `3f96670`, `b686a84`, `94b830e`, `286caec`, `8795ba4`, `5cbef01`, `6605b50`, plus the changelog commit*

**Changed**

* Removed `README_backup.md`, the unused `.app-shell` rule, the unused
  `clampToWorld` helper and the write-only `socket.data.roomId`; fixed the stale
  `(Day 4)` description in `client/package.json`; `.gitignore` now covers the
  Vite cache, coverage output and log directories.
* Root `npm test` runs **both** suites (server first) through
  `scripts/run-tests.mjs` and fails when either fails; `install:all`, `build`,
  `install:server` added so one set of commands works from a clean checkout.
* Connection UX: a drop before the join is acknowledged no longer leaves the form
  at “Joining…”, a member who is dropped sees “Connection lost — reconnecting…”
  while Socket.io reconnects (no reload, no duplicate avatars), and a server
  rejection after joining is shown in the HUD instead of being invisible.
* Vite dev server accepts an extra host for previews/tunnels via
  `VITE_DEV_ALLOWED_HOSTS` (the strict default is unchanged).

**Fixed**

* The render loop died when the window reported a 0/NaN size (minimised window,
  hidden iframe) — the canvas stayed blank until a reload.
* A very large high-DPR window exceeded the browser's per-canvas pixel budget and
  the canvas was silently never drawn on; the backing store is now capped.
* A user announced by `user:joined` while our own join was in flight could be
  dropped by the snapshot and stay invisible until they moved.
* A `move` sent in the window between an automatic reconnect and the server's
  re-join acknowledgement was rejected with `not_joined`.
* A reconnecting client drew its own ghost avatar (its previous presence row is
  still in the snapshot until the server's ping timeout).
* `connectMongo()` re-registered its lifecycle listeners on every call, so every
  event was logged once per call.
* A busy port crashed with a raw `EADDRINUSE` stack trace instead of one
  actionable line.

**Added**

* Tests for the gaps Week 1 had left: the canvas renderer (recording 2D context,
  no browser), the HTTP surface (`/health`, 404, CORS allow-list, error handler),
  the join-form validation and error sentences, the server-URL resolution, the
  world-state/reconnect rules and the connection-status machine.
* `docs/WEEK1.md` (deliverables → files, event tables, data model, projection,
  ASCII architecture) and `docs/DEMO_WEEK1.md` (5-minute demo + troubleshooting),
  a consolidated Week 1 README section and this changelog.

## Week 2 — Day 7 — 2026-10-16 — proximity engine

Actual implementation/test commits (date confirmed with `git log`):

- `3610b25` — proximity/presence config, geo helper usage and timed-query foundation.
- `bb1cba5` — `$near`, live same-room/self exclusion, exact pixel boundary and ordering.
- `ba2852e` — `$geoWithin` counts and DB-discovered connected-component clusters.
- `5b5aa91` — instance-owned boot/stale cleanup, Engine.IO heartbeat refresh,
  live join snapshots and shutdown drain. Stable default instance identity is
  now `node-local`; multi-instance processes must supply unique stable ids.
- `e666d0f` — node:test real-MongoDB brute-force, boundary, cluster, cleanup,
  index-plan and 50-user timing coverage; database-free runs explicitly skip.

Verification in this environment: server 34 passed / 0 failed / 17 skipped;
client 99 passed / 0 failed / 0 skipped; both fresh dependency installs and
client production build succeeded. Real MongoDB correctness and query p50/p95
are **NOT VERIFIED** (local MongoDB unavailable), not claimed as passing.
See `docs/DAY7.md` for exact rerun commands. No client/dependency changes,
HTTP audit endpoint, peer graph, signaling or audio work is included.

## Day 1–7 local QA fixes — 2026-10-16

- `78dfa05` — serialize per-socket presence writes, retain immutable accepted
  move coordinates, drain in-flight joins/writes before disconnect cleanup.
  Added failing-then-passing socket race regressions with an in-memory store.
- `dc6c08b` — reject malformed/operator identifiers and invalid/oversized query
  radii before MongoDB access; limit radius to the configured world diagonal.
- `06a42d7` — enforce CLIENT_URL at WebSocket admission, not only CORS headers;
  direct forbidden-Origin WebSocket regression failed before and passed after.
- `c59677d` — verify 10 Hz acceptance (20/20 accepted, 0 dropped), Engine.IO pong
  refresh, cleanup ownership/recheck and timer stop/drain using test doubles.
- `9151130` — reject overflowing cleanup intervals/timeouts; avoid Node's silent
  1 ms timer overflow behavior and invalid Date cutoffs.

These local QA fixes are not a claim of real-MongoDB or browser verification.
No dependency, client application, signaling or audio features were added.

## Day 7 follow-up — 2026-10-16

- `1c6e597` — stale sweeps close the owning socket transport (preserving automatic
  reconnect); moves atomically update without upsert and reject missing rows with
  `session_expired`; client reconnect/rejoin uses the existing snapshot path.
  Real-socket tests with store/query doubles cover expiry, automatic rejoin,
  duplicate-free avatars, repeated rejected moves and deletion racing a move.
- `2628beb` — one final live, room-scoped roster query filters vanished ids
  out of computed clusters and removes empty clusters, without splitting/rebuilding
  components. README notes the eventual-consistency limitation.

## Week 2 — Day 8 — 2026-10-17 — peer graph and WebRTC signaling

Backend-only slice. Server-side peer coordination and signaling relay only: no
client WebRTC/audio, no `getUserMedia`, no Redis, no TURN, no new dependency.

Actual implementation/test commits (date from `git log`; this documentation
commit follows them):

- `d4a9492` — in-memory per-room peer graph: order-independent edge keys,
  per-user diffing, monotonically increasing generations, lexicographic
  initiator, idempotent leave, measured recompute timings.
- `ed51158` — gateway integration for join, accepted move, disconnect and
  presence expiry; `peer:connect` / `peer:disconnect` to both endpoints; expiry
  cleanup hook in the presence sweep.
- `66399fc` — `signal` validation and relay restricted to a live edge in the
  sender's room with a matching generation; `no_peer_edge` and
  `stale_generation` error paths; 16 KB cap and candidate whitelisting.
- `4abeee2` — `ICE_SERVERS` JSON parsing with a one-line warning and default
  STUN fallback, `iceServers` in `joined` and `peer:connect`, and the
  `SOCKET_SIGNAL_EPS` / `SOCKET_SIGNAL_BURST` token bucket.
- `848bdf1` — 29 new tests: 12 real-MongoDB/real-socket integration tests,
  8 peer-graph unit tests, 5 signal-validation tests, 4 ICE-config tests.

**Added**

- `server/src/services/peerGraph.js`: one edge per unordered pair (sorted key),
  only the changed user's neighbors re-queried with Day 7 `findNearby`,
  generation on every new edge, deterministic initiator, full cleanup on
  disconnect/expiry.
- `peer:connect { peerId, name, initiator, generation, iceServers }` and
  `peer:disconnect { peerId, generation }`, emitted to both users of the edge.
- `signal` relay (offer/answer/candidate) with `from`/generation rewriting;
  no edge, other room, self, stale generation, malformed/oversized payload and
  pre-join signals are rejected with `error`, never a crash. Throttled signals
  are dropped silently, matching the existing `move` limiter style.
- `ICE_SERVERS` config (default `stun:stun.l.google.com:19302`, no TURN),
  validated and falling back to the default with a clear boot warning when
  malformed. `joined` now carries `iceServers` (duplicate joins included).
- `docs/DAY8.md` and the README “Week 2 — Day 8” section with the event table,
  edge/generation/initiator rules and configuration.

**Fixed**

- A duplicate `join` snapshot now keeps `iceServers` instead of returning an
  empty list.
- Day 3/8 integration suites print their NOT VERIFIED banner only when the
  MongoDB connection actually failed, not before `before()` runs.

**Verified (real MongoDB 6.0.29, 2 vCPU sandbox)**

- Server: 101 tests, 101 passed, 0 failed, 0 skipped (29 new Day 8 tests).
- Client: 101 passed, 0 failed, 0 skipped; `npm run build --prefix client`
  succeeded.
- 50 users × 20 random moves: 1,050 recomputes, edge set equal to the
  brute-force pair set, no duplicate edges, no crash, p50 ≈ 4.7 ms /
  p95 ≈ 11.4 ms (environment-dependent; printed by the test).

## Week 2 — Day 9 — 2026-10-18 — WebRTC audio

Client-only slice: standard browser WebRTC audio (`getUserMedia`,
`RTCPeerConnection`, `<audio>` elements — no other API, no new dependency) over
the Day 8 signaling events. No server behavior change: the rate-limit review
proved the shipped `signal` bucket already covers a 10-peer connect.

Actual implementation/test commits (dates from `git log`; this documentation
commit follows them):

- `7768026` — `client/src/webrtc/localMedia.js`: microphone request with the
  mandated audio constraints and typed failures (`permission_denied`,
  `no_device`, `insecure_context`, `not_supported`); `release()` stops every
  track; injectable `mediaDevices`/`isSecureContext` for Node tests.
- `f8fb4da` — `client/src/webrtc/peerManager.js`: one `RTCPeerConnection` per
  peer edge keyed by `peerId` + `generation`; offer/answer over `signal`,
  ICE trickle with before-SDP queueing and in-order flush, newer-generation
  replacement (never two connections per peer), generation-matched
  `peer:disconnect`, failed/closed cleanup with no auto-retry, `closeAll()`
  that leaves no connection, audio element, timer or track behind; fully
  dependency-injected (pc factory, socket-like emitter, logger, media, audio
  sink, stats).
- `9a57135` — `client/src/webrtc/remoteAudio.js` (one `<audio autoplay
  playsinline>` per remote stream in a hidden container, plain playback only —
  no Web Audio) and `client/src/webrtc/rtcStats.js` (~1 s `getStats()` poll per
  peer exposing `connectionState` + inbound audio `bytesReceived`).
- `39a3138` — join flow + socket wiring: the Join button (user gesture)
  requests the mic before `join`; denial/no-device shows a clear message and
  continues listen-only (recvonly transceiver); `useSocket` creates the peer
  manager on the existing events (`joined` iceServers fallback,
  `peer:connect`/`peer:disconnect`/`signal`) and calls `closeAll()` on
  disconnect/reconnect/`session_expired`/re-join/unmount; one *Join with mic /
  Listen only* choice on the Join screen.
- `91deece` — `client/src/components/AudioStatus.jsx`: minimal read-only
  overlay (plain DOM/CSS): mic on/off/listen-only and per nearby peer name,
  connection state and received audio bytes, updated at most once per second.
- `448cfdf` — 31 `node:test` cases with fakes: initiator offer and
  wait-then-answer, ICE queueing + in-order flush, stale/unknown signals
  ignored, newer-generation replacement, disconnect + stale disconnect,
  `closeAll()` zero-left-behind, listen-only recvonly, handler exceptions
  logged, localMedia typed failures and track release, remoteAudio element
  lifecycle, rtcStats poll/cleanup, and a server signal rate-limit headroom
  proof (10 peers × 8 signals = 80 in 500 ms ≤ 100 burst + 15 refill → 0
  dropped, flood guard still bites).

**Added**

- `client/src/webrtc/` (localMedia, peerManager, remoteAudio, rtcStats) —
  plain JS, no React inside the core logic, unit-tested in Node.
- Mic-first join flow with listen-only fallback and re-acquisition after a
  reconnect; the hidden `.remote-audio` container; the ≤1 Hz `AudioStatus`
  overlay.
- README "Week 2 — Day 9" section (client event flow, two-window manual test
  with mandatory headphones, Chrome fake-device flags, troubleshooting table)
  and `docs/DAY9.md` (module map, edge rules, verification).

**Verified (this environment, 2026-10-18)**

- Fresh `npm run install:all` and `npm run build --prefix client` succeed.
- Root `npm test`: client **132 passed / 0 failed / 0 skipped** (31 new);
  server **74 passed / 0 failed / 29 skipped** (2 new headroom tests pass).
- Server code untouched except the added proof test.

**NOT VERIFIED here**

- The real two-browser audio check: no headless Chromium/Firefox in this
  sandbox — exact manual steps (and the fake-device flags variant) are in
  `docs/DAY9.md`. No `connectionState`/`bytesReceived` numbers are claimed.
- The 29 skipped real-MongoDB tests (no local MongoDB; they self-label
  "NOT VERIFIED"). With a local MongoDB the count must be 0 skipped.

## Day 10 — 2026-10-19 — Mid-Project Review readiness

*Commits: `3699c13` (fast clustering), `38185b2` (spatial audit service/endpoint/script), `1974762` (docs + signal burst), plus the Day 10 review-fix commits that follow them in `git log`*

**Changed**
* `computeClusters` reworked: one lean roster query (id/x/y, live rows of the
  room) + in-memory spatial grid (cell = radius) + exact pixel Euclidean check
  + union-find. The old `$near`-per-user algorithm is kept as
  `computeClustersViaNear`, used only as a cross-check in tests and the audit.
* `SOCKET_SIGNAL_BURST` default raised 100 → 200 so a ~20-user mutually-near
  cluster (~160 signals/socket, pessimistic count) exchanges ICE unthrottled.

**Added**
* Spatial Audit: `server/src/services/spatialAudit.js`,
  `server/scripts/audit.js` (`npm run audit`, exit 1 on FAIL) and guarded
  `GET /api/spatial-audit` (AUDIT_ENABLED default on outside production, off in
  production; users ≤ 500, samples ≤ 100, 429 on concurrent runs, no caller
  roomId). Synthetic throwaway room, planted 99/100/101 px edge cases,
  independent brute-force comparison, `performance.now()` p50/p95/max,
  2dsphere explain check, `finally` cleanup verified empty.
* `docs/REQUIREMENTS_TRACE.md` and `docs/DEMO_MIDREVIEW.md`; autoplay
  troubleshooting row ("bytes climb but silence -> click the page once").

## Week 3 — Day 11 — 2026-10-20 — dynamic distance attenuation

*Commits: `5ba8f32`, `234c209`, `10721f6`, `ffc9310`, `b265b1c`, `9f3f533`, `6e561e1`*

*QA follow-ups from this re-review: default fallback warning, full remote-audio
container teardown, corrected roadmap/history, and explicit NOT VERIFIED trace
statuses for checks blocked by unavailable MongoDB/browser tooling.*

**Added**

- Pure Euclidean pixel distance and smoothstep gain curve (30 px inner radius,
  server-supplied outer radius), with invalid input safely silent.
- `joined.proximityRadiusPx` sourced from the existing server
  `PROXIMITY_RADIUS_PX` config; client fallback is 100 px for older servers.
- One dependency-injected Web Audio mixer with one source → GainNode chain per
  remote peer, zero initial gain, smoothed 50 ms target updates, a 20 Hz maximum
  tick, suspended-context recovery, and full peer/context cleanup. If Web Audio
  is unavailable, hidden remote audio elements fall back to full-volume playback.
- Remote streams remain attached to muted hidden audio elements for Chrome's
  WebRTC/Web Audio compatibility behavior. The existing single render loop
  updates gain from local predicted and remote rendered positions; the status
  overlay reports distance and gain at most once per second.
- Node tests for curve boundaries/sweep/invalid inputs, mixer chain and lifecycle,
  exact gain targets, unknown positions, visibility resume, fallback, and tick
  throttling; documentation and requirement trace updated for Day 11.

**Scope boundary**

- No panning, occlusion, Redis/Pub-Sub, mesh optimization, new library, or new
  UI controls. Stereo panning and occlusion remain Week 4; Redis Pub/Sub is the
  planned Day 12 work.

**Verified in this environment (2026-10-20)**

- Fresh `npm run install:all` succeeded; `npm run build --prefix client` succeeded.
- Root `npm test`: server **80 passed / 0 failed / 32 skipped**; client
  **145 passed / 0 failed / 0 skipped**. Server integration tests were skipped
  because no local MongoDB is available (`127.0.0.1:27017`); the
  `joined.proximityRadiusPx` integration assertion is among those NOT VERIFIED
  server tests. With local MongoDB, expected skipped count is 0.
- No headless Chromium/browser is installed here. Real GainNode measurements at
  10, 50 and 90 px and the two-window hearing test are **NOT VERIFIED**; no
  audible-output numbers are claimed. Exact manual steps and Chrome fake-device
  flags are in `docs/DAY11.md`.

## Week 3 — Day 12 — 2026-10-21 — Redis Pub/Sub and multi-instance edge scaling

*Commits: `da2e332`, `efa9214`, `f3a6312`, `31bdd03`, `63c74a8`, `1d3a901`, `a0e6a0a`, `f73eec3`, `79732a3`, `59463fb`, plus QA bugfix commits `9615fe5`, `8fa43ec`, `8d39cf2`*

**Added**

- `EdgeStore` abstraction (`server/src/services/edgeStore.js`) with strict regex
  validation on `roomId`, `userId`, and `keyPrefix`, collision-free canonical
  length-prefixed pair encoding (`<lenA>:<a>:<lenB>:<b>`), synchronous
  `MemoryEdgeStore`, and store-agnostic `PeerGraph` (`chain()` keeps pure sync
  semantics when `REDIS_URL` is unset).
- Optional Redis connection manager (`server/src/db/redis.js`) supporting
  `redis://` and `rediss://` (TLS), credential redaction across valid and
  malformed URLs, single-warning boot fallback when unreachable without retry
  loops, and live `scaleState` transitions (`"single" | "redis" | "redis-degraded"`).
- `@socket.io/redis-adapter` wiring (`server/src/sockets/redisAdapter.js`) for
  room broadcasts, point-to-point `io.to(socketId).emit(...)` signaling relays,
  `io.serverSideEmit` server coordination, and safe pub/sub rejection handling
  across mid-run outages and shutdowns.
- Atomic Lua-backed `RedisEdgeStore` (`server/src/services/redisEdgeStore.js`)
  guaranteeing single-winner `createEdge` + monotonic per-pair `INCR`
  generations, strict boolean winner `removeEdge`, atomic `removeUser`, and
  bounded `EXPIRE` safety TTLs.
- Multi-instance stale-presence sweeps (`server/src/services/presenceCleanup.js`)
  with atomic per-row claims, `cleanupOnBoot` scoped strictly to `{ instanceId }`,
  and cross-instance raw transport expiry (`socket.conn.close()` via
  `io.serverSideEmit`, never `socket.disconnect(true)`) so clients auto-reconnect
  and recover cleanly.
- Cursor `SCAN`-only orphan sweeper (`server/src/services/edgeSweep.js`, never
  `KEYS`) on boot and every `EDGE_SWEEP_INTERVAL_MS`, plus automatic local peer
  reconciliation (`PeerGraph.reconcileLocalUsers()`) on Redis reconnection.
- Cached `instanceId` and `scaleMode` fields on `GET /health` with zero DB/Redis
  network I/O (`server/src/app.js`), CLI verifier `npm run scale-check`
  (`server/scripts/scale-check.js`), Day 12 test suites, and
  `docs/REDIS_SCALING.md`.

**Scope boundary**

- Client code untouched (`git diff 35bca1a -- client/` is empty). Only
  `@socket.io/redis-adapter` and `ioredis` were added to `server/package.json`.
- **Day 13 mesh optimization / peer caps remain `MISSING` (not started).** Stereo
  panning and obstacle occlusion remain Week 4 scope.

**Verified in this environment (2026-10-21)**

- Real MongoDB Community Server `8.0.0` (`127.0.0.1:27017`) + `redis-server`
  `7.4.2` (`127.0.0.1:6379`) running locally:
  - `MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak_qa" REDIS_URL_TEST="redis://127.0.0.1:6379" npm test`
    -> server **142 passed / 0 failed / 0 skipped**, client **145 passed / 0 failed / 0 skipped** (**287 / 287 total**).
  - `MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak_qa" REDIS_URL="" REDIS_URL_TEST="" npm test`
    -> server **126 passed / 0 failed / 16 skipped**, client **145 passed / 0 failed / 0 skipped**.
  - No MongoDB & no Redis -> server **94 passed / 0 failed / 48 skipped** (with explicit `NOT VERIFIED` banners), client **145 passed / 0 failed / 0 skipped**.
  - `npm run audit` at `users = 50, 100, 250, 500` -> **PASS** across all four (`0` mismatches; 500-user p95 `findNearby=2.880 ms`, `countWithin=1.494 ms`, `computeClusters=10.379 ms <= 20 ms`).
  - Live two-process `npm run scale-check` against ports `4000` & `4001` -> **PASS (8/8 checks)**; `npm run build` -> clean client bundle.
- Live headful two-browser WebRTC audio hearing check remains **NOT VERIFIED**
  here (no browser binary in sandbox); exact steps are in `docs/REDIS_SCALING.md`
  and `docs/DAY11.md`.

## Week 3 — Day 13 — 2026-10-22 — WebRTC mesh optimization (cap + hysteresis)

*Commits: `ed398c0`, `4b7abcc`, `70d6dc5`, `1231b85`, `19d2307`, `49603ab`, `7113c57`, `07f07e0` (this documentation commit follows them)*

**Added**

- `MAX_PEERS_PER_USER` (default `8`, `0` = unlimited) and
  `PEER_DISCONNECT_RADIUS_PX` (default radius + 15 = `115`, validated
  `radius … 3 × radius`) in `server/src/config/index.js`, documented in
  `.env.example`.
- Symmetric, atomic degree cap inside both `EdgeStore` implementations:
  `MemoryEdgeStore.createEdge` checks both `Set` sizes in one synchronous step;
  `RedisEdgeStore.createEdge` adds two `SCARD`s to the existing `CREATE_EDGE_LUA`
  script (same round-trip, no new Redis key). Refused pairs return
  `{ created: false, capped: true }` and emit nothing.
- Hysteresis in `PeerGraph`: one neighbour query at the drop radius, new edges
  only for finite distances `<= PROXIMITY_RADIUS_PX`, existing edges kept until
  the distance exceeds the drop radius. The 100–115 px band stays silent because
  the Day 11 gain curve is 0 at 100 px.
- Nearest-first deterministic candidate ordering `(distancePx, userId)`, bounded
  slot reclaim (one extra sync per endpoint, `isReclaim` prevents cascades),
  cross-instance `proxispeak:edge-removed` reclaim signal, and per-instance mesh
  counters (`edgesCreated`, `edgesRemoved`, `cappedRejections`,
  `hysteresisHolds`) logged at debug level and exposed through `stats().mesh` /
  `meshStats()`.
- `joined` now carries `maxPeers` and `peerDisconnectRadiusPx`; the existing audio
  overlay shows `connected N / max` and `M nearby, not connected (cap)` via the
  pure helper `client/src/realtime/meshIndicator.js` (no new protocol, no new
  library, positions stay out of React state).
- `server/scripts/mesh-check.js` + `npm run mesh-check`: real sockets against two
  embedded instances sharing real Redis (or `--url` / `--urlA` / `--urlB` for
  running servers), tight clusters at N = 10/20/50 with before/after numbers,
  boundary approach and 100-crossing jitter, brute-force invariants, exit code 1
  on failure, cleanup in `finally`.
- `docs/MESH_OPTIMIZATION.md`, updated `docs/REDIS_SCALING.md`, README and
  requirements trace. Tests: `peerGraph.mesh.test.js`, `mesh.twoInstance.test.js`,
  `mesh.config.test.js`, `client/test/meshIndicator.test.js`, plus cap suites in
  `edgeStore.contract.test.js`.

**Changed**

- The Day 8 `peerGraph.integration.test.js` suite asserts the Day 12
  unlimited/no-hysteresis contract, so it now sets `MAX_PEERS_PER_USER=0` and
  `PEER_DISCONNECT_RADIUS_PX = PROXIMITY_RADIUS_PX` explicitly in its test config
  (no assertion weakened).
- `peerGraph.unit.test.js` now expects the single neighbour query at the drop
  radius (hysteresis needs the wider query).

**Measured (`npm run mesh-check`, two instances + redis-server 6.2.14)**

| Tight cluster | Edges before (unlimited) | Edges after (cap 8) | Max connections/browser before → after |
| --- | ---: | ---: | ---: |
| N = 10 | 45 | 36 | 9 → 8 |
| N = 20 | 190 | 73 | 19 → 8 |
| N = 50 | **1225** | **190** | **49 → 8** |

100 boundary crossings: **0** connect/disconnect events with the 115 px drop
radius versus **100 / 100** with the drop radius equal to the connect radius.
Result: **PASS 37/37 checks**, 0 dropped signals at the default burst.

**Verified in this environment (2026-10-22)**

- Redis: real `redis-server` **6.2.14** (apt is offline here, so the binary came
  from the environment tool `redislite`). Redis-dependent suites ran with
  `REDIS_URL_TEST` and **0 skipped**.
- `REDIS_URL_TEST="redis://127.0.0.1:6399" npm test` -> server **135 passed /
  0 failed / 32 skipped**, client **151 passed / 0 failed / 0 skipped**.
  `npm run build --prefix client` succeeded.
- The **32 skips are all MongoDB-backed suites**: no `mongod` is installed and
  the sandbox cannot download one (`apt` and `fastdl.mongodb.org` are
  unreachable). Live MongoDB behaviour and a real two-browser audible check are
  therefore **NOT VERIFIED here**; with a local MongoDB, skipped must be 0.
- `npm run mesh-check` -> **PASS (37/37)**; the exact output is in
  `docs/MESH_OPTIMIZATION.md`.

**Scope boundary**

- No new dependency, no TypeScript, no SFU/MCU, no TURN, no deploy config, no
  Express-served client build, no other client change. With
  `MAX_PEERS_PER_USER=0` and `PEER_DISCONNECT_RADIUS_PX = PROXIMITY_RADIUS_PX`
  the Day 12 behaviour is unchanged (covered by an explicit test).
- Stereo panning and obstacle occlusion remain Week 4 scope, not started.


## Day 14 — 2026-10-24 — Week 2 wrap-up: hardening, polish, documentation

*Commits: `4d5dd96`, `02b7c0a`, `a6c381e`, `ad845d7`, `b182735`, `a3d5f39`, `4754632`*

**Hardening (A)**

* **HTTP CORS alignment** — When `NODE_ENV=production` and `CLIENT_URL` is empty,
  the HTTP layer is now same-origin only (no origin reflection), matching the
  Socket.io layer exactly. Non-production defaults unchanged. Added
  `httpCorsOrigin()` in `server/src/app.js`, documented the rule in
  `.env.example`, regression test in `server/test/app.test.js`.
* **Config drift guard** — `server/test/configDrift.test.js` verifies every
  environment variable read in `server/src/config/index.js` appears in
  `.env.example` (and vice versa), and the same for client `VITE_*` variables.
  Added all missing entries to `.env.example`.
* **Config validation** — Added tests for `MAX_PEERS_PER_USER`,
  `PEER_DISCONNECT_RADIUS_PX`, socket rate limits, `AUDIT_TARGET_MS`,
  `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_EDGE_TTL_SECONDS`, `MONGO_TIMEOUT_MS`.
  All reject invalid values with one clear error line naming the variable.
* **Audio-blocked hint** — Pure function `shouldShowAudioPausedHint()` in
  `client/src/audio/audioPausedHint.js` detects `suspended` and `interrupted`
  AudioContext states while peers exist. The `AudioStatus` overlay shows one
  hint line. Unit tested with 8 tests.

**Bug fix (B)**

* **Peer name cache eviction** — `onEdgeRemoved` in `server/src/sockets/index.js`
  previously called `forgetPeerName` for BOTH endpoints of every removed edge,
  even when one endpoint still had other edges. Fixed to not evict names on
  edge removal (only on leave/departure). Regression test in
  `server/test/peerGraph.nameCache.test.js`.

**Bug hunt checklist (checked, no other genuine bugs found):**

* AudioMixer `closeAll` — safe (sets `context = null` before close; double-close is a no-op)
* `attach()` after `closeAll()` — works correctly (creates new context)
* Redis recovery reconcile — `onRecovered` fires `reconcileLocalUsers()`, errors caught
* `pendingSyncs` cleanup — proper `then/catch` cleanup with identity check
* `pendingCleanups` in socket server — tracked promises removed on resolve/reject
* `edgeSweep` timer — `unref()`'d, cleared on shutdown, `running` flag prevents overlap
* `presenceCleanup` timer — same pattern as edgeSweep
* `remoteNames` cache — bounded by active rooms/users, cleaned on leave/dropRoom/clearRoom
* `trackedPairUsers` — Redis-only, edgeSweep guards with `typeof === 'function'`
* Redis adapter `guardPubSubMethods` — catches unhandled rejections on pub/sub methods

**Documentation (D)**

* README rewritten as one coherent document with architecture diagram, folder
  structure, quick start (single + two instances), script table, test commands.
* `docs/WEEK2.md` — Week 2 deliverables, full Socket.io event table with
  payloads, data model, complete configuration table.
* `docs/DEMO_WEEK3.md` — 8-minute demo script with exact commands, expected
  results, and troubleshooting for each step.
* `docs/LIMITATIONS.md` — honest list: no peer eviction, STUN only, per-instance
  rate limiters, sticky sessions, edges not preserved across Redis wipe, audio
  quality not measured, 60 FPS not optimized, live audio not automated.
* `docs/REQUIREMENTS_TRACE.md` — updated with Day 14 rows (#19–#24).

**Verified in this environment (2026-10-24)**

* Server: `178` tests total, `121` passed, `0` failed, `57` skipped (MongoDB)
* Client: `159` tests, `159` passed, `0` failed, `0` skipped
* `npm run build` — succeeds
* `npm test` — all suites passed
* MongoDB and Redis unavailable in this sandbox (no `apt` access, no internet
  for package repos). MongoDB-backed and Redis-backed tests skip honestly.
* `npm run audit`, `npm run scale-check`, `npm run mesh-check` — NOT VERIFIED
  (require running MongoDB + Redis + two server instances)

**Scope boundary**

* No new dependency, no TypeScript, no SFU/MCU, no TURN, no deploy config, no
  Express-served client build, no new feature beyond the audio paused hint.
* Week 4 (stereo panning, obstacle occlusion, room persistence, 60 FPS) remains
  not started.
