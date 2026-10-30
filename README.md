# ProxiSpeak

ProxiSpeak is a browser-based spatial voice chat prototype: each person moves an avatar on a 2D map, WebRTC connects nearby participants, and a Web Audio `GainNode` makes remote voice fade with distance. **Proximity is the volume knob.**

The current scope includes room layout persistence (`layoutRevision`, guarded REST/CLI saves, live `room:layout` broadcast), **Week 3 (Day 16)** client-side sound-blocking obstacles in the Web Audio path (`gainForDistance(d) × T`), **Week 3 (Day 17)** left/right stereo panning from each peer's relative position on the 2D map, and **Week 3 (Day 18)** a two-layer Canvas 2D rendering pipeline (cached offscreen static room layer, zero-allocation dynamic avatar loop, coalesced resize & `matchMedia` DPR watcher, and opt-in `?perf=1` frame telemetry). It is not a deployed or production-hardened service.

## How it works

```text
Browser A / Browser B
  React + Canvas + WebRTC + Web Audio
              │ Socket.io (join, move, signal, layout)
              ▼
Node.js + Express + Socket.io
  ├─ MongoDB: room definitions, layout revisions, presence, geospatial queries
  ├─ PeerGraph: radius, hysteresis, cap, nearest-first refill
  ├─ EdgeStore: in-memory, or Redis Lua for multiple instances
  └─ RoomService: atomic layout saves, revision conflict detection, cache invalidation
                         │
                         └─ Redis Pub/Sub fans out Socket.io events and cache eviction
```

- The server creates an edge only at or inside `PROXIMITY_RADIUS_PX` (default `100` px).
- An existing edge remains until `PEER_DISCONNECT_RADIUS_PX` (default `115` px), preventing boundary flapping.
- Accepted moves persist position, then bump a shared per-user revision; edge creation checks both endpoint revisions and retries a stale read once. A bounded sweep validates stored edge distances as a safety net.
- `MAX_PEERS_PER_USER` (default `8`) is enforced symmetrically; `0` means unlimited.
- Remote audio is full volume through `30` px, follows a smoothstep curve to silence at the connect radius, and remains silent until the edge drops.
- Blocking room obstacles (`blocksAudio === true`) multiply line-of-sight transmission `T` (`attenuation` in `[0, 1]`) into each peer's target gain (`gainForDistance(d) × T`) on the client with `0.08` s `setTargetAtTime` smoothing across obstacle edges (`docs/OCCLUSION.md`).
- Each remote peer is panned left/right by its position on the screen (larger `x` is heard in the right ear; `pan = 0.85 · dx / max(dist, 30)`). The chain is `source → StereoPannerNode → GainNode → destination`, and panning is smoothed with a `0.05` s time constant. Facing is not used, and this is not HRTF or 3D audio (`docs/PANNING.md`).
- The audio overlay is sampled separately from the render loop (at most once per second) and shows per-peer distance, output volume, obstacle transmission percentage, and stereo side and strength (`pan R 62%`, `pan C`); avatar positions do not create per-frame React state.
- Canvas rendering splits the static room (letterbox backdrop, floor, grid, border, obstacles) onto a cached offscreen `<canvas>` rebuilt only when backing size, effective DPR, `roomId`, or `layoutRevision` changes (`MAX_BACKING_PIXELS = 16,000,000`), blits it with a single `drawImage` per frame, and draws moving avatars with cached labels/colours and zero React state (`docs/RENDERING.md`).
- Room layouts are versioned with monotonic `layoutRevision` integers. Edits use atomic revision conflict detection (HTTP 409), broadcast `room:layout` to active clients (taking acoustic effect on the very next mixer tick without re-join), and invalidate caches across clustered instances via Redis.

## Requirements

- Node.js **18.17 or newer**
- MongoDB for the normal server, seed script, and spatial audit
- Redis only for multi-instance mode and Redis integration checks
- A microphone-capable browser for audible peer-to-peer checks; browser audio requires the usual secure-context/autoplay rules

## Quick start: one server

```bash
npm run install:all
cp .env.example .env
npm run seed
npm start
```

In another terminal:

```bash
npm run dev:client
```

Open `http://localhost:5173` in two browser windows, join the same seeded room (`lobby`, `studio`, or `lounge`), and allow microphone access. The HTTP server and Socket.io listen on port `4000` by default; Vite listens on `5173`.

Use headphones for a two-window microphone test. “Listen only” is available when microphone capture is unwanted or unavailable.

## Quick start: two servers with Redis

Start MongoDB and Redis, seed once, then run two servers with distinct ids:

```bash
PORT=4000 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-1 npm start
PORT=4001 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-2 npm start
```

Verify the running instances with real Socket.io clients:

```bash
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
```

The external `mesh-check` uses the exact existing room and checks only the running servers' current configuration. It does not invent a second configuration or append room-name suffixes. Use an empty seeded room for checks.

For a self-contained mesh run with two embedded Socket.io instances and real Redis (no MongoDB required):

```bash
REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check
```

Embedded mode runs current and baseline configurations and reports the before/after comparison. See `docs/DEMO_WEEK3.md` for the two-browser, two-instance walkthrough.

## Configuration and CORS

Copy `.env.example` to `.env`; `server/.env` takes precedence if both exist. Client overrides belong in `client/.env` (see `client/.env.example`). Examples contain placeholders and local defaults only—never commit credentials.

`CLIENT_URL` is a comma-separated list of allowed browser origins, `*`, or empty:

| Setting | HTTP CORS | Socket.io |
| --- | --- | --- |
| Explicit origin list | Allow only those origins | Allow only those origins |
| `*` | Reflect any origin | Reflect any origin (explicit opt-in) |
| Empty, production | Same-origin only; no cross-origin reflection | Same-origin only |
| Empty, non-production | Reflect any origin for development (unchanged default) | Same-origin only |

Requests without an `Origin` header, such as health probes and curl, are not browser-CORS requests. CORS is not authentication.

Invalid validated numeric, boolean, and base-URL settings fail at startup with one concise error naming the variable; values and credentials are not echoed. The bidirectional drift tests require every server environment key and every client `VITE_*` key to have a commented example entry.

## Room Persistence & Layout API

**Week 3 (Day 15, Company Plan Week 4)** introduces transactional layout management and persistence for room obstacles:

- **Data Model**: Rooms store dimensions, metadata, obstacles, and an atomic `layoutRevision` (integer >= 1). Obstacles define rectangular barriers (`type`, `x`, `y`, `w`, `h`, `blocksAudio`, `attenuation`). Attenuation represents the fraction of sound amplitude that survives crossing the barrier (`0.0` = opaque, `1.0` = transparent), consumed client-side in **Week 3 (Day 16)** line-of-sight occlusion (`client/src/audio/occlusion.js`, `docs/OCCLUSION.md`). Avatars have no movement collision with obstacles.
- **Public Endpoints**:
  - `GET /api/rooms` — lists persisted room summaries (`roomId`, `name`, `layoutRevision`).
  - `GET /api/rooms/:roomId` — fetches full room details (dimensions, `layoutRevision`, `obstacles`, `spawnPoints`).
- **Admin Guarded Endpoint**:
  - `PUT /api/rooms/:roomId/layout` — updates obstacles and metadata. Guarded by the `x-room-admin-token` header matching `ROOM_ADMIN_TOKEN` via constant-time comparison. Unset token disables edits server-wide (`403 Forbidden`). Requests require an `expectedRevision` and reject stale updates with `409 Conflict`. Rate-limited to 10 requests/min/IP with a 64 KB payload cap.
- **Live Sync**: Successful layout saves emit `room:layout` to active participants in the room, evict local caches, and broadcast `room:cache:invalidate` across Redis nodes. Clients apply changes in-place without component re-renders.
- **Developer CLI**:
  - `npm run room:show -- --room lobby`
  - `npm run room:save -- --room lobby --file server/layouts/valid-office.json [--dry-run]`
  - See `docs/ROOM_PERSISTENCE.md` for full architecture and threat model details.

## Commands

| Command | Purpose | External requirements |
| --- | --- | --- |
| `npm run install:all` | Install locked server and client packages | npm registry |
| `npm start` | Start the Node server | MongoDB |
| `npm run dev:server` | Start Node with `--watch` | MongoDB |
| `npm run dev:client` | Start Vite | None |
| `npm run seed` | Idempotently seed rooms and indexes | MongoDB |
| `npm test` | Run server tests, then client tests | None; service tests skip loudly |
| `npm run test:server` / `npm run test:client` | Run one suite | Same rule |
| `npm run build` | Build the client into `client/dist/` | None |
| `npm run audit -- --users=50 --samples=25 --seed=1` | Compare spatial queries with brute force and measure latency | MongoDB |
| `npm run room:show -- --room <id>` | Inspect room layout, dimensions, and `layoutRevision` | MongoDB |
| `npm run room:save -- --room <id> --file <path> [--dry-run]` | Validate or persist room layout JSON with revision conflict check | MongoDB (unless `--dry-run`) |
| `npm run scale-check -- --urlA=… --urlB=… --room=lobby` | Check two running instances, including offer/answer/ICE relay | Two servers, MongoDB, Redis |
| `npm run mesh-check` | Run embedded two-instance mesh checks | Redis |
| `npm run mesh-check -- --urlA=… --urlB=… --room=lobby` | Check the current configuration of two running servers | Two servers, MongoDB, Redis |

To enable MongoDB and Redis integration tests when both services are local:

```bash
MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" \
REDIS_URL_TEST="redis://127.0.0.1:6379" \
npm test
```

The Mongo suites create and drop isolated databases derived from the test base URI. Redis failure/recovery tests also require `redis-server` on `PATH`. A complete service-backed run should have zero skips; do not interpret a skipped test as a pass.

## Controls

- **WASD / arrow keys:** move.
- **Click the floor:** walk toward that position.
- **Audio overlay:** connected peers, mesh cap, distance, volume + obstacle transmission percentage (for example `volume 4% (blocked 12%)`), connection state, and inbound audio bytes.
- **Browser-paused audio:** when peers exist and the context is `suspended` or `interrupted`, one line says `Audio is paused by the browser. Click anywhere on the page.` A page pointer gesture and visible-tab resume path attempt recovery.
- **Opt-in render readout (`?perf=1`):** opening the client with `?perf=1` displays a read-only line (`fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0`) updated at most once per second via direct `textContent` write; omitted without `?perf=1`.

## Current verification

On 2026-10-29 (**Week 3 (Day 18)**), after clean lockfile installs:

- Without services: server **191 passed / 77 skipped** (268 tests), client **224 passed / 0 skipped**.
- With real Redis (`redis-server` 6.2.14): server **228 passed / 40 skipped** (268 tests), client **224 passed / 0 skipped**. All remaining skips require MongoDB.
- `npm run build`: passed (86 modules). `npm audit`: client 0 vulnerabilities; server 1 moderate (transitive `qs`), 0 high/critical.
- Render report (`node --expose-gc client/scripts/render-report.js`, 60 avatars × 200 obstacles, fake 2D context — JS cost only, not GPU/compositing): per-frame 2D ops reduced from `1,075` to `424` (constant across `0..200` obstacles after 1 static build); JS work `p50 = 3.12 µs` / `p95 = 3.42 µs` (vs `8.52 µs` / `9.90 µs` before); retained heap delta over 50,000 frames `+272 B` (`0.0054 B/frame`).
- Panning report (`node --expose-gc client/scripts/panning-report.js`, 8 peers × 200 obstacles per tick): full mixer tick `p50 = 12.87 µs` / `p95 = 15.07 µs`; panning alone `p50 = 0.57 µs`; heap delta over 50,000 ticks `-61,352 B`.
- Occlusion benchmark (`node client/scripts/occlusion-bench.js`, 8 peers × 200 obstacles per tick): spread room `p50 = 11.04 µs` / `p95 = 12.41 µs` (**99.69%** rejected by bounding-box pre-check), full mixer tick `p50 = 11.21 µs` / `p95 = 13.67 µs`, `20,000`-case 4-edge geometry cross-check with **0 disagreements**.

MongoDB was unavailable in the verification sandbox (`deb.debian.org` and `fastdl.mongodb.org` unreachable under sandbox egress rules), so a zero-skip MongoDB+Redis run, the real Mongo spatial audit, and normal Mongo-backed server/CLI commands are **NOT VERIFIED** here. No browser is installed in this sandbox (`cdn.playwright.dev` and `deb.debian.org` unreachable), so live two-browser microphone/hearing, audible occlusion, audible left/right panning, and real-browser 60 FPS GPU compositing checks are **NOT VERIFIED** here. See `docs/RENDERING.md`, `docs/PANNING.md`, `docs/OCCLUSION.md`, `docs/WEEK3.md`, and `CHANGELOG.md` for full records.

## Documentation

- `docs/WEEK1.md`, `docs/WEEK2.md`, `docs/WEEK3.md` — weekly implementation notes
- `docs/ROOM_PERSISTENCE.md` — room layout persistence, revision concurrency, REST API, live sync, and CLI
- `docs/OCCLUSION.md` — Week 3 (Day 16) sound-blocking obstacle geometry, smoothing, worked table, and benchmark
- `docs/PANNING.md` — Week 3 (Day 17) stereo panning semantics, pan law, chain, measurements, manual test and limitations
- `docs/RENDERING.md` — Week 3 (Day 18) Canvas 2D baseline, static/dynamic split, `MAX_BACKING_PIXELS` budget, allocation checks, and manual 60 FPS verification
- `docs/DEMO_WEEK3.md` — approximately eight-minute, two-instance demo
- `docs/LIMITATIONS.md` — known technical and verification limits
- `docs/REQUIREMENTS_TRACE.md` — requirement-to-code/test mapping with company plan weeks and delivered calendar weeks
- `CHANGELOG.md` — dated history and commit hashes
