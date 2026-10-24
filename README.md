# ProxiSpeak

ProxiSpeak is a browser-based spatial voice chat prototype: each person moves an avatar on a 2D map, WebRTC connects nearby participants, and a Web Audio `GainNode` makes remote voice fade with distance. **Proximity is the volume knob.**

The current scope is the end of Week 3 (Day 14b): proximity audio, optional Redis-backed multi-instance signaling, a bounded peer mesh, and hardening. It is not a deployed or production-hardened service.

## How it works

```text
Browser A / Browser B
  React + Canvas + WebRTC + Web Audio
              │ Socket.io (join, move, signal)
              ▼
Node.js + Express + Socket.io
  ├─ MongoDB: room definitions, presence, geospatial queries
  ├─ PeerGraph: radius, hysteresis, cap, nearest-first refill
  └─ EdgeStore: in-memory, or Redis Lua for multiple instances
                         │
                         └─ Redis Pub/Sub fans out Socket.io events
```

- The server creates an edge only at or inside `PROXIMITY_RADIUS_PX` (default `100` px).
- An existing edge remains until `PEER_DISCONNECT_RADIUS_PX` (default `115` px), preventing boundary flapping.
- Accepted moves persist position, then bump a shared per-user revision; edge creation checks both endpoint revisions and retries a stale read once. A bounded sweep validates stored edge distances as a safety net.
- `MAX_PEERS_PER_USER` (default `8`) is enforced symmetrically; `0` means unlimited.
- Remote audio is full volume through `30` px, follows a smoothstep curve to silence at the connect radius, and remains silent until the edge drops.
- The audio overlay is sampled separately from the render loop; avatar positions do not create per-frame React state.

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
- **Audio overlay:** connected peers, mesh cap, distance, volume, connection state, and inbound audio bytes.
- **Browser-paused audio:** when peers exist and the context is `suspended` or `interrupted`, one line says `Audio is paused by the browser. Click anywhere on the page.` A page pointer gesture and visible-tab resume path attempt recovery.

## Current verification

On 2026-10-24, after clean lockfile installs:

- Without services: server **143 passed / 63 skipped** (206 tests), client **165 passed / 0 skipped**.
- With real Redis: server **174 passed / 32 skipped** (206 tests), client **165 passed / 0 skipped**. All remaining skips require MongoDB.
- `npm run build`: passed (Vite, 80 modules). Server and client `npm audit`: **0 high/critical** (0 total vulnerabilities each).
- Embedded real-Redis `mesh-check`: **37/37**; external two-instance harness: **18/18**. Two-instance `scale-check`: **8/8**.
- Random-layout probe: 24 random 50-user layouts plus one identical-position layout on Memory and Redis, zero mismatches. Signal-burst tests: **2/2**.
- Three separate **180-second, 60-user, two-instance** soaks: **20 settled samples each, zero violations at every sample**, with all tracked runtime state and Redis keys at zero after disconnect. See `docs/LIMITATIONS.md` for measured RSS figures; no “no leak” claim is made.

MongoDB was unavailable in the verification sandbox, so a zero-skip MongoDB+Redis run, the real Mongo spatial audit, and normal Mongo-backed server commands are **NOT VERIFIED** here. No live two-browser microphone/hearing test was performed. See `docs/WEEK3.md` for earlier evidence and `CHANGELOG.md` for the Day 14b record.

## Documentation

- `docs/WEEK1.md`, `docs/WEEK2.md`, `docs/WEEK3.md` — weekly implementation notes
- `docs/DEMO_WEEK3.md` — approximately eight-minute, two-instance demo
- `docs/LIMITATIONS.md` — known technical and verification limits
- `docs/REQUIREMENTS_TRACE.md` — requirement-to-code/test mapping
- `CHANGELOG.md` — dated history and commit hashes

## Known limits and next scope

The peer cap does not evict an existing peer for a closer newcomer, the default ICE configuration is STUN-only, rate limits are instance-local, and live audible quality is unmeasured. Obstacles do not occlude audio, stereo panning is absent, custom room-layout persistence is absent, and 60 FPS at high occupancy is unverified. Read `docs/LIMITATIONS.md` before treating the prototype as more than a demo.

Week 4 remains **room persistence/obstacles, stereo panning, and 60 FPS work**. It has not been started in this wrap-up.
