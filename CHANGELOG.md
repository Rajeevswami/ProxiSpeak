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


## Day 14 — 2026-10-24 — Week 3 wrap-up: hardening, regressions, documentation

**Hardening commits:** `4d5dd96`, `02b7c0a`, `a6c381e`, `ad845d7`,
`635db42`, `9b85dd1`.

* Production HTTP CORS with empty `CLIENT_URL` is same-origin only, matching
  Socket.io. Non-production defaults remain unchanged and the rule is documented.
* Server and client `VITE_*` environment keys have exact bidirectional example
  drift checks, with comments/defaults and placeholders only.
* Validated numeric, boolean and URL settings report one concise startup error
  naming the variable, without echoing values/credentials or printing a stack.
* A pure-tested, single-line paused-audio hint covers `suspended` and
  `interrupted`; there is no per-frame React audio state.

**Bug-hunt fixes (each with regression coverage):**

* `b182735` — do not evict a peer name while that peer still has edges.
* `951dad2` — roll back an edge created after its local user finished leaving.
* `b0b0e6f` — ignore saved ICE/track/state callbacks from torn-down WebRTC edges.
* `8cc0b21` — discard stats reads that finish after unwatch/replacement.
* `d8fdb79` — disconnect partial Web Audio chains after setup failure.
* `0f92b2b` — resume Safari-style `interrupted` contexts on existing recovery paths.
* `5a19ab8` — external mesh-check uses the exact room and current server config;
  embedded before/after behavior remains intact.
* `3be48c1` — socket shutdown drains peer syncs before backing stores close.
* `8118523` — close/unregister a partially initialized RTCPeerConnection.
* `e5399f6` — a real page pointer listener implements the advertised click-to-resume.
* `c5a0091` — scale-check awaits a valid cross-instance ICE candidate, not only SDP.
* `7dbdf8e` — single-instance restart cleanup removes presence left under a previous
  random instance id; multi-instance cleanup remains instance-scoped.

The initial test-gap list, failure evidence and file mapping are in
`docs/WEEK3.md`. `9ef2bc8` adds orphan-sweep overlap/drain and concurrent mixer
close coverage. `4b4f6a8` removes verified-unused exports and corrects package
metadata. No production change was made for audit candidates that did not
reproduce a defect.

**Documentation**

* README rewritten around current architecture, commands, CORS and verification.
* Added `docs/WEEK3.md`; rewrote `docs/DEMO_WEEK3.md` as an approximately
  eight-minute two-instance script with no fabricated transcript.
* Rewrote `docs/LIMITATIONS.md` and this requirements trace so live MongoDB and
  browser claims are not inferred from Node tests.
* Earlier documentation commits `a3d5f39`, `4754632`, `8bf25dc` remain in history;
  stale Week 2 wrap-up text and unverified claims are superseded.

**Verified in this environment (2026-10-24):**

* `npm run install:all` passed earlier; final `npm ci --prefix server` and
  `npm ci --prefix client` clean lockfile installs also passed (130 and 74
  packages). No dependency or lockfile changed. npm reported one high-severity
  server advisory and zero client vulnerabilities; no dependency fix was applied.
* `npm test` without services: server **188 tests, 131 passed, 57 skipped**;
  client **165/165 passed**.
* Real Redis 7.2.5 with `REDIS_URL_TEST` and its binary on `PATH`: server
  **188 tests, 156 passed, 32 skipped**; client **165/165 passed**.
* `npm run build` passed (Vite, 80 modules).
* Embedded real-Redis `npm run mesh-check`: **PASS 37/37**. External two-instance
  Socket.io/Redis harness: **PASS 18/18** in exact room `lobby`.
* Two-instance real-Redis `runScaleCheck` integration: **PASS 8/8**, including
  offer, answer and valid ICE candidate relay.

**NOT VERIFIED here:**

* MongoDB could not be provisioned. The remaining 32 skips are MongoDB suites;
  a MongoDB+Redis zero-skip run was not achieved. Real `npm run audit` was
  attempted and exited 1 with `ECONNREFUSED 127.0.0.1:27017`, producing no audit
  result. Mongo geospatial performance, seed and normal Mongo-backed server/CLI
  runs remain unverified. External harnesses use in-memory presence backing.
* No live two-browser microphone/hearing, audible attenuation, Safari interruption
  or speaker-output check ran. The demo is a presenter script, not a completed
  live-demo claim.

**Scope boundary:** no dependency, TypeScript, deployment, SFU/TURN, Express
static hosting, stereo panning, obstacle occlusion, room persistence or new UI
feature beyond the paused-audio hint. Week 4 room persistence/obstacles, stereo
panning and 60 FPS work remain not started.


## Day 14b — 2026-10-24 — stale-edge fencing, sweep validation, verification

**Base and implementation commits:** commit `b8a6bcf` (merged in `c3f927c`), delivering
QA credential redaction, race regressions, store revisions, graph/socket fencing,
bounded sweep validation, and the body-parser lockfile patch. The subsequent documentation
commit is visible in `git log`. Every listed short hash was checked with `git cat-file -t`
and resolves to a commit.

**Test-first race evidence and fix:**

* Before the fix, all five new regression tests failed with real Redis: the
  deterministic gated read left a 460 px edge on Memory and Redis, all 200/200
  seeded interleavings on each store left an out-of-range edge, and two real
  Socket.io instances emitted a 460 px `peer:connect`. After the fix, the expanded
  file passes 8/8 with zero quiescent violations.
* Accepted moves write MongoDB presence, then bump a monotonic per-user position
  revision, then sync. Neighbor reads carry revisions; Memory checks both expected
  revisions synchronously and Redis checks them in the existing create Lua script.
  A stale result triggers exactly one complete bounded re-sync, never a loop.
* The Mongo-write/revision-bump window is documented and tested: an old-revision
  create before the bump is handled by the mover's post-bump sync; a create after
  the bump is rejected. This is a quiescent invariant, not a cross-store
  transaction claim.
* The existing SCAN-based sweep validates at most 100 live edges per rotating
  batch against stored positions. Atomic winners remove beyond-drop edges and
  emit normal `peer:disconnect`; exactly-at-drop edges remain. `mesh-check` now
  prints `staleRejections` and `validationRemovals`; `/health` gained no I/O.
* Redis revision keys use validated per-user names, `INCR` + `EXPIRE`, and
  `removeUser` cleanup. A controlled unchanged-edge move measured 8 application
  Redis commands before and 12 after; top-level round trips rose from 2 to 4
  (one revision `EVAL` and one batched `MGET`). Measurement-only `CONFIG
  RESETSTAT` is excluded.

**Dependency and documentation corrections:**

* Only `server/package-lock.json` changed for the advisory: transitive
  `body-parser` 1.20.8 → 1.20.9 within the existing Express 4.22.3 range. No new
  package or major upgrade was added. Server and client audits report zero total
  vulnerabilities after fresh installs.
* Corrected radius/reconcile overclaims, historical instance-ID defaults, the
  Room obstacle comment (no occlusion calculation exists), current verification
  counts, and the former dependency-advisory limitation.

**Measured verification in this environment:**

* Fresh server/client `npm ci`: passed (130 and 74 packages). Client build:
  passed with Vite 6.4.4 and 80 modules. Server/client `npm audit`: 0 high, 0
  critical, 0 total each.
* Without services: server **206 tests, 143 passed, 63 skipped**; client **165/165**.
  With real Redis 7.2.5: server **206 tests, 174 passed, 32 skipped**; client
  **165/165**. Every remaining skip is MongoDB-dependent and is not a pass.
* Real scale-check **8/8**; embedded capped/unlimited mesh-check **37/37** with
  1,759/1,759 signals; external mesh-check **18/18** with 299/299 signals.
  Embedded counters were `staleRejections=5` and `4`, `validationRemovals=0`.
* Independent random-layout probe: 24 random 50-user layouts plus one identical
  layout on each store, zero mismatches and zero backward-mode mismatches.
  Existing 200-concurrent-create cap tests passed on both stores; signal-burst
  tests passed 2/2 (160 signals fit, flood guard still drops excess).
* Three separate 180-second, 60-user, two-instance real-Redis soaks passed. Each
  had 20 settled samples with zero violations/errors at every sample and zero
  Redis keys, edges, presence rows, sockets, rooms, names, and pending syncs after
  cleanup. Measured resources:

| Soak | Baseline RSS MB | First joined RSS MB | Last RSS MB | Post-cleanup RSS MB | Peak Redis keys |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 108.19 | 125.84 | 161.78 | 161.49 | 1,761 |
| 2 | 100.13 | 118.46 | 164.55 | 162.53 | 1,783 |
| 3 | 109.39 | 126.71 | 165.29 | 163.32 | 1,799 |

Post-cleanup RSS remained above baseline; these observations are not a “no leak”
claim. Exact failing/passing logs and command measurements were kept outside Git.

**NOT VERIFIED here:** MongoDB could not be provisioned, so the 32 MongoDB test
skips, zero-skip MongoDB+Redis run, real spatial audit, seed/index/explain and
normal Mongo-backed server/CLI runs remain unverified. No live browser microphone,
hearing, attenuation, Safari-interruption or speaker-output test ran. External
harnesses and soaks used real Socket.io/Redis with in-memory presence backing.

**Scope boundary:** no new feature/library/dependency, TypeScript, deployment,
SFU/TURN, Express static hosting, Week 4 panning/occlusion/room persistence, or
new UI work. Unlimited mode and drop-radius-equals-connect-radius behavior remain
covered and unchanged.

---

## Week 3 (Day 15) — 2026-10-26 — room layout persistence and live sync (Company Plan Week 4)

*Commits: `d83289d`, `2be63a1`, `40055b7`, `2d31aea`, `775d9a0`, `6f8ef65`, `f5adde8`, `aa04e53`*

**Added**

* Shared layout validator (`server/src/validators/roomLayout.js`) enforcing strict boundary checks (`[0, width]`, `[0, height]`), obstacle limits (`ROOM_LAYOUT_MAX_OBSTACLES`, default 200), unique obstacle IDs, allowed obstacle types (`wall`, `desk`, `plant`, `pillar`, `screen`), boolean `blocksAudio`, transmission `attenuation` in `[0.0, 1.0]`, mass-assignment prevention (unknown fields rejected), and path-specific error messages.
* `layoutRevision` field on `Room` model (positive integer >= 1) with safe, atomic backfill routine `backfillLegacyRoomRevisions()` for legacy unversioned documents. Documented obstacle `attenuation` semantics as acoustic transmission coefficient (fraction of sound amplitude surviving obstacle traversal).
* Atomic layout save mechanism (`saveLayout` in `server/src/services/roomService.js`) using atomic MongoDB `findOneAndUpdate` with expected revision filter, incrementing `layoutRevision` on success and returning HTTP 409 `RevisionConflictError` on stale revision concurrency races. Room dimensions (`width`, `height`) are strictly immutable.
* REST API endpoints:
  - `GET /api/rooms` — public room summary list (`roomId`, `name`, `layoutRevision`).
  - `GET /api/rooms/:roomId` — public single-room details (dimensions, `layoutRevision`, `obstacles`, `spawnPoints`).
  - `PUT /api/rooms/:roomId/layout` — admin token-guarded layout mutation with `x-room-admin-token` header, constant-time `crypto.timingSafeEqual` comparison against `ROOM_ADMIN_TOKEN`, HTTP 403 `editing_disabled` when token is unset, HTTP 401 on missing/invalid token, 64 KB payload cap (HTTP 413), and in-memory IP rate limiter (HTTP 429). Admin tokens are strictly redacted from logs, error messages, and responses.
* Real-time live sync:
  - Broadcasts `room:layout` with `{ roomId, layoutRevision, obstacles }` to active sockets in the room on layout save.
  - Sibling instances in clustered Redis deployments receive `room:cache:invalidate` via `io.serverSideEmit`, evicting local room caches.
  - Initial `joined` snapshot event delivers the active `layoutRevision` and obstacle list to newly connecting clients.
* Developer CLI tooling (`server/scripts/room-layout.js`):
  - `npm run room:show -- --room <id>` for viewing room layouts and revisions.
  - `npm run room:save -- --room <id> --file <path> [--dry-run]` for schema validation and layout persistence.
  - Sample blueprints added under `server/layouts/` (`valid-office.json`, `quiet-zone.json`).
  - Seed script (`server/scripts/seed.js`) made idempotent, guaranteeing custom room layouts and revisions are never overwritten on re-runs.
* Client-side live layout updates:
  - `useSocket.js` handles `room:layout` events and updates mutable world ref via `updateRoomLayout`.
  - Zero React component re-renders per layout update; canvas render loop reflects obstacle updates on the next animation frame.
  - Drops out-of-order or stale events (`layoutRevision <= currentRev`) and ensures clean listener teardown without duplicate handlers across reconnections.
* Test coverage:
  - Layout validator unit tests covering valid schemas, boundary limits, and malformed inputs (`server/test/roomLayout.validation.test.js`).
  - API integration tests covering public reads, constant-time token verification, 401/403/404/409/413/429 status flows, and credential redaction (`server/test/roomLayout.api.test.js`).
  - Real Socket.io tests for same-room broadcasts, room isolation, late joiners, and multi-instance Redis adapter broadcast & cache eviction (`server/test/roomLayout.socket.test.js`).
  - CLI tests for argument parsing, dry-run mode, exit codes, and credential redaction (`server/test/roomLayout.cli.test.js`).
  - Real MongoDB integration tests covering atomic revision increments, 50-client concurrency races (exactly 1 winner, 49 conflicts), unknown room 404, dimension immutability, legacy backfills, reconnect survival, and seed idempotency (`server/test/roomPersistence.mongo.test.js`).
  - Client tests for revision ordering, obstacle replacement, room scoping, and listener cleanup (`client/test/worldState.layout.test.js`).
* Architecture documentation in `docs/ROOM_PERSISTENCE.md`.

---

## Week 3 (Day 16) — 2026-10-27 — sound-blocking obstacles in the audio path

*Commits: `35642cc`, `fd2fbd1`, `afb9df3`, `faeff7c`, `424af75` (this documentation commit follows them)*

**Added**

* Pure, zero-allocation 2D acoustic occlusion geometry (`client/src/audio/occlusion.js`):
  - `segmentIntersectsRect(ax, ay, bx, by, rect)` implementing closed-segment versus closed-rectangle Liang-Barsky clipping with endpoint canonicalization (exact symmetry under endpoint swap), fast closed bounding-box rejection, division-free handling for horizontal/vertical/zero-length segments, and 4-ULP relative parametric tolerance (`PARAM_EPSILON = 4 * Number.EPSILON`).
  - `prepareObstacles(obstacles, layoutRevision)` and per-mixer `createObstacleCache()` normalizing valid blocking obstacles (`blocksAudio === true`, finite coordinates, `w > 0`, `h > 0`, `attenuation` clamped to `[0, 1]`, deduplicated by reference and `id`) and caching by `(roomId, layoutRevision)`.
  - `transmissionBetween(listener, speaker, prepared)` computing multiplicative transmission `T` in `[0, 1]` with a 4-comparison bounding-box pre-check before exact clipping.
  - Pure overlay helpers `formatPeerVolume` and `derivePeerVolume` formatting output volume and transmission percentage (e.g. `volume 4% (blocked 12%)` when occluded, `volume 39% (100%)` when unobstructed).
* Audio mixer & live layout integration (`client/src/audio/audioMixer.js`, `client/src/hooks/useSocket.js`):
  - Per-peer target gain is now `gainForDistance(d) * transmissionBetween(localPos, remotePos, prepared)` using local predicted and remote interpolated positions from `worldRef.current`.
  - Uses `OCCLUSION_TIME_CONSTANT = 0.08` s via `setTargetAtTime` while occluded or transitioning out of occlusion so crossing wall edges never clicks, while preserving `TARGET_TIME_CONSTANT = 0.05` s in unobstructed space (identical behavior when no obstacles exist).
  - Live `room:layout` events update `world.room.layoutRevision` and `world.room.obstacles` in place and take acoustic effect on the very next mixer tick (at most 20 Hz) without re-joining or React re-renders.
* Read-only overlay update (`client/src/components/AudioStatus.jsx`, `client/src/styles.css`):
  - Per-peer row displays transmission percentage alongside volume at <= 1 Hz with no new UI controls and no per-frame React state.
* Test coverage, benchmark, and documentation (`client/test/audio.occlusion.test.js`, `client/scripts/occlusion-bench.js`, `docs/OCCLUSION.md`):
  - Deterministic geometry edge cases, **20,000**-case random cross-check against an independent 4-edge + point-in-rectangle reference (**0 disagreements**), transmission monotonicity property test, `layoutRevision` caching, seeded lobby geometries (`70 px` open `0.39359` vs across `0.12` wall `0.04723`), live `room:layout` updates, 50-cycle node teardown, 20 Hz throttle, Web Audio fallback, and pure overlay derivation.
  - Added `"Delivered in calendar week"` column and Week 3 (Day 16) evidence to `docs/REQUIREMENTS_TRACE.md`.

**Measured (`node client/scripts/occlusion-bench.js`, 8 peers × 200 obstacles per tick)**

* Spread 1920×1080 room (`1,600` checks/tick, **99.69%** rejected by bounding-box pre-check): `p50 = 11.04 µs` (`0.0110 ms`), `p95 = 12.41 µs` (`0.0124 ms`), `max = 145.92 µs` (`0.1459 ms`).
* Dense overlap worst-case (all `1,600` pairs run full Liang-Barsky): `p50 = 16.11 µs` (`0.0161 ms`), `p95 = 22.13 µs` (`0.0221 ms`), `max = 205.21 µs` (`0.2052 ms`).
* Full `audioMixer.updateGains` tick (`prepareObstacles` ran **1** time across `6,000` ticks): `p50 = 11.21 µs` (`0.0112 ms`), `p95 = 13.67 µs` (`0.0137 ms`), `max = 363.65 µs` (`0.3637 ms`).

**Verified in this environment (2026-10-27)**

* Fresh `npm ci --prefix server` and `npm ci --prefix client` installs succeeded; `npm run build --prefix client` succeeded (Vite 6.4.4, 81 modules); `npm audit` for both packages reported **0 high, 0 critical, 0 total vulnerabilities**.
* Without `REDIS_URL_TEST`: server **191 passed / 0 failed / 77 skipped** (268 tests); client **179 passed / 0 failed / 0 skipped**.
* With real `redis-server` 7.2.5 (`REDIS_URL_TEST="redis://127.0.0.1:6379"`): server **228 passed / 0 failed / 40 skipped** (268 tests); client **179 passed / 0 failed / 0 skipped**.
* `server/`, `client/src/audio/attenuation.js`, `client/src/movement/`, and all pre-existing test files are completely unchanged.

**NOT VERIFIED here**

* MongoDB could not be installed in this sandbox (`deb.debian.org` and `fastdl.mongodb.org` unreachable under sandbox egress allowlist), so the 40 MongoDB-backed server tests remain skipped (`NOT VERIFIED`).
* No browser binary is installed in this sandbox, so live two-window audible volume drop across obstacles and live CLI wall-removal hearing recovery remain **NOT VERIFIED** here; manual steps are in `docs/OCCLUSION.md`.

**Scope boundary**

* Client-only occlusion gain calculation. Server code untouched (peer edges still depend only on Euclidean radius and cap; blocked peers keep their WebRTC connection). No new library, no movement collision, no low-pass/reverb, no stereo panning, and no 60 FPS work (stereo panning is the next planned task).



## Week 3 (Day 17) — 2026-10-28 — stereo panning in the audio mixer (Company Plan Week 4)

*Commits: `65c2b0e`, `291811c`, `a5a1ba8`, `2f620d4` (this documentation commit follows them and is not self-listed)*

**Added**

* Pure stereo pan law (`client/src/audio/panning.js`): `panForPositions(listener, speaker)` returns `pan = MAX_PAN * dx / max(dist, PAN_INNER_PX)` with `MAX_PAN = 0.85` and `PAN_INNER_PX = 30`. It is continuous (including at zero distance), antisymmetric, bounded to `[-0.85, 0.85]`, has no dead zone, and returns `0` for invalid input without throwing. Screen axes: larger `x` is heard in the right ear. Avatar facing is not used.
* Stereo panner in each peer's audio chain (`client/src/audio/audioMixer.js`): `MediaStreamAudioSourceNode -> StereoPannerNode -> GainNode -> destination`. The first connection sets the pan with `setValueAtTime`; later ticks glide with `setTargetAtTime(target, currentTime, PAN_TIME_CONSTANT)` where `PAN_TIME_CONSTANT = 0.05` s. Without `createStereoPanner` the chain is `source -> gain -> destination` and one warning is logged.
* Overlay (`client/src/components/AudioStatus.jsx`, `client/src/hooks/useSocket.js`): each peer row shows `pan R 62%`, `pan L 40%` or `pan C`, from the same pure function, at the existing once-per-second poll. `pan n/a` when there is no panner.
* Tests (`client/test/audio.panning.test.js`, `client/test/audio.panningMixer.test.js`): worked values, 100,000-pair property checks, continuity sweeps, invalid input, overlay text, chain order, `setValueAtTime` then `setTargetAtTime` with no `pan.value` writes, blocked peers keeping their side, missing panner, 50-cycle cleanup with zero leftovers, 20 Hz throttle, Web Audio fallback, and `room:layout` changing gain but not pan.
* `client/scripts/panning-report.js`: the worked table, an 8-peer x 200-obstacle tick benchmark and a heap check (`node --expose-gc client/scripts/panning-report.js`).
* `docs/PANNING.md`: semantics, formula, figure, worked table, smoothing constant, chain diagram, measurements, manual test and limitations.

**Changed**

* `docs/REQUIREMENTS_TRACE.md`: stereo panning is marked DONE in code and Node tests (audible browser check NOT VERIFIED); 60 FPS stays MISSING.
* `README.md`: current verification and documentation list.

**Note on the expected value**

* The planning note listed `0.60098` for `(dx=70, dy=70)`. The formula gives `0.6010408`, so the test asserts `0.60104`. The formula is unchanged.

**Measured (`node --expose-gc client/scripts/panning-report.js`, Node v22.22.3, shared Linux VM)**

* Full `updateGains` tick, 8 peers x 200 obstacles (occlusion + gain + pan, Web Audio replaced by a counting fake): `p50 = 12.87 µs`, `p95 = 15.07 µs`, `max = 1175 µs`.
* Panning alone (8 `panForPositions` per tick): `p50 = 0.57 µs`, `p95 = 0.8 µs`.
* Before/after on the same benchmark (`112ff8c` tree): `p50 = 17.21 µs` and `11.06 µs` on two runs; with panning `11.83 µs` and `10.85 µs`. Difference inside run-to-run noise.
* Heap over 50,000 ticks after forced GC: `-61,352 B` (no growth).

**Verified in this environment (2026-10-28)**

* Fresh `npm ci --prefix server` and `npm ci --prefix client` succeeded; `npm run build --prefix client` succeeded.
* `npm audit`: client 0 vulnerabilities; server 1 moderate (`qs` DoS, transitive), 0 high, 0 critical. The server lockfile was not changed, because the server is out of scope for this task.
* Without `REDIS_URL_TEST`: server **191 passed / 77 skipped** (268); client **201 passed / 0 skipped**.
* With real `redis-server` 6.2.14 (`REDIS_URL_TEST=redis://127.0.0.1:6379`): server **228 passed / 40 skipped** (268); client **201 passed / 0 skipped**. The 40 skips are MongoDB-only.

**NOT VERIFIED here**

* MongoDB could not be installed (no `mongod` on the allowed registries), so the 40 MongoDB-backed server tests remain skipped.
* No browser or audio output is available, so the audible left/right result, the absence of clicks while walking, and the headphone check are NOT VERIFIED. The manual steps are in `docs/PANNING.md`.

**Scope boundary**

* Client-only. No server files, protocol messages, or environment variables changed. `client/src/audio/attenuation.js`, `client/src/audio/occlusion.js` and `server/` are unchanged. No HRTF, elevation, head orientation, reverb, or 60 FPS work (60 FPS rendering is the next planned task).



## Week 3 (Day 18) — 2026-10-29 — steady 60 FPS Canvas rendering pipeline (Company Plan Week 4)

*Commits: `bdad57b`, `9c92896`, `8c04f3e`, `b36feef`, `cccdac2`, `7656ef8`, `7c5544e`, `0a0ce6d`, `6eac3e3`, `085e705`, `df00b49`, `a776b21` (this documentation commit follows them and is not self-listed)*

**Added**

* Pure rolling frame-statistics ring buffer (`client/src/perf/frameStats.js`): preallocated `Float64Array(240)` buffers (`DEFAULT_RING_CAPACITY = 240`) for frame `intervalMs` and callback `workMs`, nearest-rank `p50` / `p95` / `max` (`ceil(q * n) - 1`, matching `server/src/services/spatialAudit.js`), `DROPPED_FRAME_MS = 25` (`strict >`), first-frame sentinel (`EXCLUDED_INTERVAL_MS = -1`), post-hidden exclusion (`markHidden()`), and `MAX_VALID_INTERVAL_MS = 1000`.
* Offscreen static room canvas cache (`client/src/canvas/staticLayer.js`): `createStaticLayer` caches the letterbox backdrop, room floor, grid, border, obstacles, and obstacle type labels on an offscreen `<canvas>`, rebuilding ONLY when backing dimensions, effective DPR, `room.roomId`, or `room.layoutRevision` changes (`MAX_BACKING_PIXELS = 16,000,000` budget; `destroy()` releases backing memory via `width = 0; height = 0`).
* Lifecycle-managed Canvas 2D frame loop (`client/src/canvas/frameLoop.js`): single `requestAnimationFrame` subscription, timestamp-driven `dt` clamped to `MAX_FRAME_DT_MS = 50` ms, `document.hidden` draw skipping + `visibilitychange` time-base reset, coalesced `resize` handling (at most one rebuild per frame), a re-arming `matchMedia('(resolution: <dpr>dppx)')` watcher across monitors, and `try/catch/finally` callback isolation so a thrown exception cannot kill the rAF loop.
* Opt-in `?perf=1` performance readout (`client/src/perf/perfReadout.js`, `WorldCanvas.jsx`, `styles.css`): read-only line `fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0` written via `perfElement.textContent` at `<= 1 Hz` with zero React state; completely disabled and unsampled when `?perf=1` is absent.
* Tests (`client/test/frameStats.test.js`, `client/test/staticLayer.test.js`, `client/test/renderEquivalence.test.js`, `client/test/frameLoop.test.js`): ring wrap-around, percentiles, `25.0` vs `25.1 ms` dropped boundary, `--expose-gc` 100k `record()` check, `1,000`-frame static cache hit, single rebuild per invalidation trigger, `MAX_BACKING_PIXELS` checks on `3840x2160@3` / `390x844@3` / `1440x900@2` + 10k-pair off-by-one sweep, exact 2D operation-list equivalence on seeded `lobby` + 200 obstacles and `1 / 10 / 60` avatars, 50 join/leave label-cache pruning + rename updates, 50 mount/unmount zero-leak cycle check, 100-event resize burst coalescing, 5s hidden-tab clamp, 60 Hz vs 144 Hz movement equivalence, `?perf=1` gating, and rAF callback throw recovery.
* Reproducible report (`client/scripts/render-report.js`) and full pipeline documentation (`docs/RENDERING.md`, preserving the Step 0 pre-optimization baseline intact).

**Changed**

* `client/src/canvas/renderer.js` and `client/src/canvas/coords.js`: split `drawStatic` and `drawDynamic`, added `drawFrame` (`1 × drawImage` + `drawDynamic`) and `createLabelCache()` (per-user cached colour, initial, truncated label, and optional `measureText` width with `O(1)` steady-state pruning), kept `centreX`/`centreY` in stack locals to avoid V8 `HeapNumber` boxing, added zero-allocation `updateCanvasSize` / `updateViewport` / `screenToWorldInto` with strict `<= MAX_BACKING_PIXELS` rounding clamp, and preserved compatible `drawRoom`, `drawAvatars`, and `drawWorld` exports.
* `client/src/components/WorldCanvas.jsx` and `client/src/App.jsx`: switched `<WorldCanvas>` to `createCanvasLoop` on the cached `drawFrame` pipeline with zero per-frame React state.
* `docs/LIMITATIONS.md`, `docs/REQUIREMENTS_TRACE.md`, and `README.md`: synced Week 3 (Day 18) status, explicit `Company plan week` + `Delivered in calendar week` columns, panning/rendering limitations, and verification records.

**Fixed**

* `client/src/canvas/frameLoop.js`: isolated `updateFrame` and `renderFrame` inside `try/catch/finally` so an uncaught callback exception cannot skip `scheduleNextFrame()` and halt the loop (`085e705`).
* `client/src/canvas/coords.js`, `client/src/canvas/staticLayer.js`: prevented `Math.round` off-by-one overflow above `MAX_BACKING_PIXELS = 16,000,000` on capped viewports (`df00b49`).
* `client/src/perf/perfReadout.js`, `client/src/perf/frameStats.js`, `client/src/canvas/frameLoop.js`, `client/src/canvas/staticLayer.js`, `client/src/canvas/renderer.js`: removed unreferenced Day 18 exports (`a776b21`).

**Measured (`node --expose-gc client/scripts/render-report.js`, Node v22.22.3, Linux x64)**

* Per-frame 2D context operations (`1440×900` CSS px, `1920×1080` room): reduced from `62..662` (`1` avatar), `125..725` (`10` avatars), and `475..1,075` (`60` avatars) across `{0, 10, 100, 200}` obstacles down to a constant **`11 / 74 / 424`** (`-651` calls/frame, `-60.6%` at `60` avatars × `200` obstacles).
* JS callback benchmark (`60` avatars × `200` obstacles, `5,000` frames, counting fake 2D context — JavaScript cost only, not GPU/compositing): `p50 = 8.52 µs` / `p95 = 9.90 µs` before → **`p50 = 3.12 µs` / `p95 = 3.42 µs`** after (`static builds = 1`).
* Heap & allocation checks (`--expose-gc` + V8 `HeapProfiler` at 32 B sampling interval): `100,000` `frameStats.record` calls sampled `9,496 B` (`0.095 B/call`); `50,000` `drawFrame` calls (`60` avatars, `200` obstacles) had `retainedDelta = +272 B` (**`0.0054 B/frame`**) and `sampledAlloc = 4,928 B` (**`0.099 B/frame`**), with 50-frame pre-scavenge young-gen burst reduced from `1,300,664 B` (`26,013.28 B/frame`) to `96,000 B` (`1,920.00 B/frame`).

**Verified in this environment (2026-10-29)**

* Fresh `npm ci --prefix server` and `npm ci --prefix client` succeeded; `npm run build --prefix client` succeeded (Vite 6.4.4, 86 modules).
* `npm audit`: client 0 vulnerabilities; server 1 moderate (`qs` DoS, transitive), 0 high, 0 critical (server lockfile untouched, out of scope).
* Without `REDIS_URL_TEST`: server **191 passed / 77 skipped** (268); client **224 passed / 0 skipped**.
* With real `redis-server` 6.2.14 (`REDIS_URL_TEST=redis://127.0.0.1:6379`): server **228 passed / 40 skipped** (268); client **224 passed / 0 skipped**. All 40 skips are MongoDB-only.

**NOT VERIFIED here**

* MongoDB could not be installed (`deb.debian.org` and `fastdl.mongodb.org` outside sandbox egress allowlist), so the 40 MongoDB-backed server tests remain skipped (`NOT VERIFIED`).
* No browser binary is installed and `cdn.playwright.dev` / `deb.debian.org` are unreachable under sandbox egress rules, so a live 60-second hardware-composited browser FPS run (`200` obstacles, `20` moving avatars, `?perf=1`) is **NOT VERIFIED** here; manual verification steps are in `docs/RENDERING.md`.

**Scope boundary**

* Client Canvas render path only. `server/`, `client/src/audio/`, WebRTC modules, Socket.io protocol, and environment variables are completely untouched. No new dependencies, no WebGL/OffscreenCanvas workers, no dirty-flag frame skipping, and no visual look changes.



## 2026-10-31 — Single-Origin Production Serving, Deployment Preparation, Hardening, and Final Documentation

*Commits: `b50c235`, `13e7fdf`, `4feb253`, `a7371c8`, `dae4910`, `8b16239`, `7fff589`, `a04cb33` (this documentation commit follows them and is not self-listed)*

**Added**

* Single-origin static bundle serving and SPA fallback in `server/src/app.js` (`b50c235`):
  - Serves `client/dist/` (`DEFAULT_CLIENT_DIST`, configurable via `clientDistDir`/`staticDir`/`distDir` in tests) from the Express process.
  - Sends `Cache-Control: public, max-age=31536000, immutable` for Vite hashed assets under `/assets/*` and `Cache-Control: no-cache` for `index.html`.
  - Registers a `GET`/`HEAD` SPA fallback *after* `/health` and `/api/*` routes that never swallows `/api/*`, `/health`, `/socket.io`, or dotfile/extension asset paths (unknown `/api/*` paths continue returning JSON `404`).
  - Blocks raw and URL-encoded path traversal (`..`, `%2e%2e`, backslashes, NUL bytes) before touching `express.static` or `sendFile`.
  - Logs one concise warning when `client/dist/index.html` is absent while keeping `/health`, `/api/*`, and Socket.io fully operational.
* Root build orchestration and Railway deployment config (`13e7fdf`):
  - Updated root `npm run build` (`npm run install:all && npm --prefix client run build`) so a clean clone builds in one command, adding `npm run build:client` for client-only rebuilds.
  - Added minimal `railway.json` (`buildCommand: "npm run build"`, `startCommand: "npm start"`, `healthcheckPath: "/health"`, `restartPolicyType: "ON_FAILURE"`).
* Static-serving and SPA fallback test coverage in `server/test/app.test.js` (`4feb253`):
  - Added tests covering `GET /` (`index.html` + `no-cache`), hashed asset immutable headers, deep-link SPA fallback (`/rooms/lobby/deep-link`), `HEAD` requests on `/` and deep links, `/api/unknown` JSON `404` preservation, `/socket.io` WebSocket handshake on the shared port, path traversal blocking, and missing-`dist` fallback + single warning log.
* Deployment & final review documentation (`a7371c8` and this commit):
  - `docs/DEPLOY.md`: step-by-step free-tier deployment guide (MongoDB Atlas `M0`, GitHub push, Railway service, required/optional env vars, local `npm run seed` against Atlas, `/health`, local production mode, HTTPS requirement for `getUserMedia`, free-tier sleep/cost notes, single-instance vs. Redis/sticky sessions, STUN-only NAT limits, rollback, and troubleshooting table).
  - `docs/DEMO_FINAL.md`: 10-minute Final Project Review live demonstration script mapped to both final review targets.
  - `docs/INDEX.md`: complete documentation index.

**Changed & Fixed (Hardening)**

* Dependency audit remediation (`dae4910`): ran `npm audit fix` (without `--force`) in `server/` and `client/`, updating transitive `qs` (`6.16.0 -> 6.16.2`) and `vite` (`6.4.4 -> 6.4.5`); both `npm audit --prefix server` and `npm audit --prefix client` now report `0` vulnerabilities.
* Concise Mongoose `Room.obstacles` validation errors (`8b16239`): replaced `{VALUE}` in `server/src/models/Room.js` custom validator with `this?._obstaclesValidationMessage || 'Room obstacles failed validation'` so validation errors report the exact offending field without dumping the entire obstacle array (`server/test/roomLayout.validation.test.js`).
* Redis-outage move log severity (`7fff589`): lowered the server log level for a failed `move` / peer sync during a Redis outage in `server/src/sockets/index.js` from `ERROR` to `WARN` while keeping sockets connected and preserving the client `error` (`server_error`) event (`server/test/redis.failure.test.js`).
* Dead-code and unused-export cleanup (`a04cb33`): removed 18 unused internal exports across `server/src/` and `client/src/` and 2 unused script imports after verifying no module or test referenced them.
* Rewrote `README.md` as one coherent reference document and synced `docs/LIMITATIONS.md` and `docs/REQUIREMENTS_TRACE.md`.

**Verified in this environment (2026-10-31)**

* `npm run build` (`npm run install:all && npm --prefix client run build`) succeeded cleanly (Vite `6.4.5`, 86 modules).
* `npm audit --prefix server` and `npm audit --prefix client`: **0 vulnerabilities** in both packages.
* Without external services: server **197 passed / 77 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests).
* With real `redis-server` `6.2.14` (`REDIS_URL_TEST="redis://127.0.0.1:6399"`): server **234 passed / 40 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests); embedded two-instance Redis `mesh-check` **37/37 passed**.
* Single-origin production-mode smoke test (`NODE_ENV=production CLIENT_URL=` bound to `0.0.0.0`): verified `GET /` (`200 text/html`, `no-cache`), `GET /assets/index-*.js` (`200`, `immutable`), `GET /health` (`200 application/json`), `GET /api/unknown` (`404 application/json`), and real `socket.io-client` connection on the same port.

**NOT VERIFIED here**

* MongoDB (`mongod`) is unavailable under sandbox egress rules, so the `40` MongoDB-backed server tests, `npm run seed`, `npm run audit`, and MongoDB-backed `npm start` remain **NOT VERIFIED** here.
* No browser binary or audio hardware is available in this sandbox, so two-browser audible WebRTC playback, wall occlusion hearing checks, stereo headphone separation, and 60-second GPU 60 FPS frame pacing remain **NOT VERIFIED** here.


