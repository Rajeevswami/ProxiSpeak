# ProxiSpeak — Geospatial Proximity Audio Ecosystem

A virtual space where **proximity is the volume knob**. You see a live 2D map, move your avatar, and the moment you walk inside somebody's earshot circle a WebRTC audio connection opens and crossfades in; walk away and it closes.

## Problem statement

Voice chat today is flat: everyone in a call is equally loud no matter where they "are", so large calls turn into either chaos or muted silence, and there is no sense of place, distance or serendipity. ProxiSpeak treats conversation as something you *walk into* — participants live on a geolocated 2D map, rooms are anchored to coordinates, and the server continuously computes who is within earshot of whom. Moving closer makes a voice louder and clearer; moving away fades it out and eventually tears the audio connection down.

The result is a persistent audio world for events, campuses, offices and communities: no hand-raising, no lobby moderation — you simply walk up to people and talk.

## Tech stack

* **Backend** — Node.js, Express, Socket.io, MongoDB (`$near` / `$geoWithin`, `2dsphere`), optional Redis Pub/Sub + Lua edge state (`@socket.io/redis-adapter`, `ioredis`).
* **Frontend** — React, HTML5 Canvas API, WebRTC (`getUserMedia`), Web Audio API (distance attenuation via GainNode).

No other libraries. No TURN. No UI kit, no state-management library, no extra database.

## Key modules

| Module | What it does |
| --- | --- |
| `server/src/config/index.js` | Every tunable from `.env`; validation with clear one-line errors |
| `server/src/app.js` | Express surface: `/health`, spatial audit, CORS aligned with Socket.io |
| `server/src/sockets/index.js` | Socket.io gateway: `join`/`move`/`signal`, presence, peer graph orchestration |
| `server/src/services/peerGraph.js` | Bounded mesh: symmetric cap, hysteresis, nearest-first, slot reclaim |
| `server/src/services/edgeStore.js` | `MemoryEdgeStore` (single-instance) + `RedisEdgeStore` (multi-instance via Lua) |
| `server/src/services/edgeSweep.js` | Orphan edge cleanup after `kill -9` via cursor `SCAN` |
| `server/src/db/redis.js` | Optional Redis: boot fallback, mid-run degradation, recovery reconcile |
| `client/src/audio/audioMixer.js` | Web Audio distance attenuation (GainNode per peer, smoothstep curve) |
| `client/src/webrtc/peerManager.js` | WebRTC mesh: offer/answer, ICE trickling, stats |
| `client/src/canvas/renderer.js` | Letterboxed room, grid, obstacles, avatars on HTML5 Canvas |

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React + Canvas)                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ WorldCanvas  │  │ AudioStatus  │  │ WebRTC PeerManager   │  │
│  │ (rAF render) │  │ (overlay)    │  │ (offer/answer/ICE)   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         │          ┌──────┴───────┐              │              │
│         │          │ AudioMixer   │◄─────────────┘              │
│         │          │ (GainNode)   │  remote MediaStream         │
│         │          └──────────────┘                             │
│         │                                                       │
│  ┌──────┴───────────────────────────────────────────────────┐   │
│  │ Socket.io Client                                         │   │
│  │ join / move / signal                                     │   │
│  └──────────────────────┬───────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────┘
                          │ WebSocket
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node.js Server (1..N instances)                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Express      │  │ Socket.io    │  │ PeerGraph            │  │
│  │ /health      │  │ gateway      │  │ (bounded mesh)       │  │
│  │ /api/audit   │  │ join/move/   │  │ sync/reclaim/leave   │  │
│  └──────────────┘  │ signal       │  └──────────┬───────────┘  │
│                    └──────┬───────┘              │              │
│                           │                      │              │
│                    ┌──────┴──────────────────────┴───────────┐  │
│                    │ EdgeStore (Memory or Redis via Lua)     │  │
│                    │ atomic create/remove, generation, cap   │  │
│                    └─────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ MongoDB      │  │ Redis        │  │ @socket.io/          │  │
│  │ UserPresence │  │ edge state   │  │ redis-adapter        │  │
│  │ Room         │  │ pub/sub      │  │ (room fan-out)       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Folder structure

```text
ProxiSpeak/
├── package.json              # root scripts (install, dev, test, seed, build)
├── scripts/run-tests.mjs     # runs server suite, then client suite
├── .env.example              # every env var with placeholder + comment
├── docs/                     # WEEK1, WEEK2, demo scripts, trace, limitations
├── server/
│   ├── package.json
│   ├── scripts/
│   │   ├── seed.js           # idempotent: 2dsphere index + default rooms
│   │   ├── audit.js          # spatial audit (p95 ≤ 20 ms target)
│   │   ├── scale-check.js    # two-instance presence + signaling check
│   │   └── mesh-check.js     # bounded mesh policy check
│   ├── src/
│   │   ├── index.js          # boot: MongoDB → Redis → HTTP → Socket.io → sweeps
│   │   ├── app.js            # Express surface + CORS
│   │   ├── config/index.js   # every tunable, validated
│   │   ├── db/               # mongo.js, redis.js
│   │   ├── models/           # UserPresence (2dsphere), Room
│   │   ├── services/         # peerGraph, edgeStore, edgeSweep, presence*, proximity*, spatialAudit
│   │   ├── sockets/          # gateway, validation, redisAdapter
│   │   └── utils/            # geo, logger, errors, rateLimiter, origin, validate
│   └── test/                 # node:test (unit + integration, 178 tests)
└── client/
    ├── package.json
    ├── vite.config.js        # dev proxy to :4000
    ├── src/
    │   ├── audio/            # attenuation, audioMixer, audioPausedHint
    │   ├── canvas/           # coords, renderer
    │   ├── components/       # JoinScreen, WorldCanvas, AudioStatus
    │   ├── hooks/            # useSocket, useMovement
    │   ├── join/             # joinForm validation
    │   ├── movement/         # controller, input, throttle
    │   ├── realtime/         # worldState, connectionStatus, meshIndicator, sessionRecovery
    │   └── webrtc/           # localMedia, peerManager, remoteAudio, rtcStats
    └── test/                 # node:test (159 tests, no browser needed)
```

## Quick start

### Prerequisites

* **Node.js ≥ 18.17**
* **MongoDB** (local or Atlas)
* **Redis** (optional, only for multi-instance scaling)

### Single instance (default)

```bash
# 1. Install dependencies
npm run install:all

# 2. Configure (edit .env if needed; defaults work for local MongoDB)
cp .env.example .env

# 3. Seed the database (idempotent: creates index + lobby/studio/lounge rooms)
npm run seed

# 4. Start the server
npm start
# → HTTP + WebSocket on http://localhost:4000

# 5. In another terminal, start the Vite dev server
npm run dev:client
# → Client on http://localhost:5173
```

Open two browser windows, join the same room with different names, allow mic access (or choose Listen only), and walk within 100 px to hear each other.

### Two instances with Redis

```bash
# 1. Start Redis (local or cloud)
# 2. Start two server instances on different ports
PORT=4000 REDIS_URL="redis://127.0.0.1:6379" npm start
PORT=4001 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-2 npm start

# 3. Verify cross-instance scaling
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001

# 4. Verify bounded mesh policy
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001
```

Leave `REDIS_URL` empty to run single-instance in memory with zero Redis dependencies.

## Root scripts

| Script | What it does | Requires |
| --- | --- | --- |
| `npm run install:all` | Install server + client dependencies | — |
| `npm start` | Start server (HTTP + WebSocket) | MongoDB |
| `npm run dev:server` | Start server with `--watch` (auto-reload) | MongoDB |
| `npm run dev:client` | Start Vite dev server for client | — |
| `npm run seed` | Create 2dsphere index + default rooms (idempotent) | MongoDB |
| `npm test` | Run both server and client test suites | — (MongoDB/Redis optional) |
| `npm run test:server` | Run server test suite only | — |
| `npm run test:client` | Run client test suite only | — |
| `npm run build` | Production build into `client/dist/` | — |
| `npm run audit` | Spatial audit: p95 ≤ 20 ms target | MongoDB |
| `npm run scale-check` | Verify two-instance presence + signaling | MongoDB + Redis + 2 servers |
| `npm run mesh-check` | Verify bounded mesh policy (cap, hysteresis, reclaim) | MongoDB + Redis + 2 servers |

## Tests

```bash
npm test                    # both suites: server first, then client
npm run test:server         # server only
npm run test:client         # client only

# With Redis (enables Redis-specific test suites):
REDIS_URL_TEST="redis://127.0.0.1:6379" npm test
```

Server suite: 178 tests (121 pass, 57 skipped without MongoDB/Redis).
Client suite: 159 tests (all pass, no browser needed).

Tests cover: config validation, CORS policy, geospatial projection, rate limiting, edge store contract (Memory + Redis), peer graph (unit + integration + mesh), presence cleanup, socket integration/validation/race, signal rate limiting, spatial audit, audio attenuation, audio mixer, audio paused hint, connection status, coords, join form, mesh indicator, movement, renderer, session recovery, WebRTC (localMedia, peerManager, remoteAudio, rtcStats), world state.

## Controls

* **WASD / Arrow keys** — walk around the map
* **Click on the floor** — walk to that position
* **Join screen** — enter your name and choose a room (lobby / studio / lounge)
* **Mic choice** — "mic on" (speak + listen) or "listen only" (listen only)
* **Audio overlay** — shows connected peers, distance, volume %, inbound bytes, mesh cap

## Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full list. Key items:

* **No peer eviction when capped** — existing edges are never dropped for a closer newcomer
* **STUN only (no TURN)** — symmetric NATs may block peer connections
* **Per-instance rate limiters** — not shared across instances
* **Sticky sessions needed** — behind a load balancer, configure session affinity
* **Edges not preserved across full Redis wipe** — except through reconcile on recovery
* **Audio quality not measured** — browser-to-browser latency and bitrate vary

## History

Days 1–13 are documented in [CHANGELOG.md](CHANGELOG.md) with real commit hashes and dates. Day 14 (this week) is the Week 2 wrap-up: hardening, polish, documentation, and demo readiness.

Week 1 (Days 1–6): server, MongoDB, Socket.io, React client, movement.
Week 2 (Days 7–10): proximity queries, WebRTC signaling, audio, spatial audit.
Week 3 (Days 11–13): distance attenuation, Redis scaling, mesh optimization.

See [docs/WEEK1.md](docs/WEEK1.md) and [docs/WEEK2.md](docs/WEEK2.md) for detailed deliverables.
