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
