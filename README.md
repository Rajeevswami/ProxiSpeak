# ProxiSpeak — Geospatial Proximity Audio Ecosystem

ProxiSpeak is a stateful, physics-aware 2D spatial voice communication platform. Each participant moves an avatar on a shared HTML5 Canvas floor plan, a MongoDB `2dsphere` geospatial engine and stateful Socket.io signaling gateway manage proximity peer-to-peer WebRTC edges with hysteresis and degree caps, and a browser Web Audio API pipeline (`MediaStreamAudioSourceNode -> StereoPannerNode -> GainNode -> destination`) shapes each remote voice by Euclidean distance, line-of-sight obstacle occlusion, and left/right stereo panning. **Proximity and room geometry are the volume and stereo controls.**

---

## Overview

ProxiSpeak addresses two core architectural targets:

1. **Scalable, Stateful Geospatial Server & P2P Routing Engine**:
   - Projects the 2D pixel room (`1920 × 1080` default, `1 px = 0.1 m`) onto a tangent-plane patch indexed by a MongoDB `2dsphere` index on `UserPresence.location`.
   - Evaluates `$near` / `$geoWithin` spatial queries and whole-room spatial grid clustering (`< 20 ms` p95 budget).
   - Maintains an undirected peer graph (`PeerGraph`) that creates WebRTC signaling edges only within `PROXIMITY_RADIUS_PX` (`100 px`), holds existing edges until `PEER_DISCONNECT_RADIUS_PX` (`115 px` hysteresis), enforces a symmetric `MAX_PEERS_PER_USER` (`8`) degree cap with nearest-first refill, fences concurrent moves with per-user position revisions, and scales horizontally across Node.js instances via `@socket.io/redis-adapter` and an atomic Lua-backed `RedisEdgeStore`.
   - Persists room layouts and acoustic obstacles in MongoDB with optimistic concurrency (`layoutRevision`), token-guarded REST/CLI updates, and live `room:layout` broadcasts.
2. **Immersive, Physics-Aware Browser Audio & Steady 60 FPS Canvas Pipeline**:
   - Captures microphone audio via `getUserMedia` (with automatic `Listen only` fallback) and negotiates direct P2P `RTCPeerConnection` audio streams per active graph edge.
   - Routes each peer's remote stream through `MediaStreamAudioSourceNode -> StereoPannerNode -> GainNode -> AudioContext.destination`:
     - **Distance attenuation**: Full gain (`1.0`) inside `30 px`, smoothstep rolloff to `0.0` at `100 px`, silent in the `[100, 115] px` hysteresis band.
     - **Obstacle occlusion**: Exact Liang-Barsky closed-segment vs. closed-rectangle intersection multiplies line-of-sight transmission `T` (`attenuation` in `[0, 1]`) into target gain (`gainForDistance(d) * T`) with `0.08 s` exponential smoothing.
     - **Stereo panning**: Continuous equal-power left/right separation (`pan = 0.85 * dx / max(dist, 30)`) with `0.05 s` exponential smoothing.
   - Renders the 2D world via a two-layer Canvas pipeline (`createStaticLayer` offscreen room cache + zero-allocation `drawDynamic` avatar pass, `MAX_BACKING_PIXELS = 16,000,000`, coalesced resize, `matchMedia` DPR watcher, and opt-in `?perf=1` telemetry).
   - Serves the built React SPA (`client/dist/`), REST API (`/api/*`, `/health`), and Socket.io gateway from a single Node.js process on the same origin in production.

---

## Architecture

```text
+---------------------------------------------------------------------------------------------------+
|                                      BROWSER CLIENTS (A, B, ...)                                  |
|                                                                                                   |
|  +----------------------------------+    +-----------------------------------------------------+  |
|  | HTML5 Canvas 2D Engine           |    | WebRTC P2P Mesh + Web Audio API Pipeline            |  |
|  |  - Offscreen StaticLayer cache   |    |  - getUserMedia (mic or listen-only recvonly)       |  |
|  |    (floor, grid, obstacles)      |    |  - RTCPeerConnection per PeerGraph edge (gen-fenced)|  |
|  |  - Dynamic avatar pass (0 alloc) |    |  - MediaStreamAudioSourceNode                       |  |
|  |  - Label cache + ?perf=1 HUD     |    |      -> StereoPannerNode (dx / max(d, 30) * 0.85)   |  |
|  |  - 60 Hz/native rAF movement     |    |      -> GainNode (gainForDistance(d) * occlusion T) |  |
|  +----------------------------------+    |      -> AudioContext.destination                    |  |
|                   |                      +-----------------------------------------------------+  |
|                   +-----------------------------------+----------------------------------------+  |
|                                                       |                                           |
|                     Direct P2P SRTP Audio (STUN ICE)  |  Socket.io (join, move, signal,           |
|                     <================================>|  peer:connect/disconnect, room:layout)    |
+-------------------------------------------------------|-------------------------------------------+
                                                        |
                                                        v
+---------------------------------------------------------------------------------------------------+
|                        NODE.JS + EXPRESS + SOCKET.IO SERVER INSTANCE(S)                           |
|                                                                                                   |
|  +---------------------------+  +-------------------------------+  +---------------------------+  |
|  | Express HTTP Surface      |  | Socket.io Gateway & PeerGraph |  | Background Maintenance    |  |
|  |  - GET /health            |  |  - Token-bucket rate limiters |  |  - Stale presence sweep   |  |
|  |  - GET /api/rooms(/:id)   |  |  - Connect <=100px, Drop >115 |  |  - Orphan & distance      |  |
|  |  - PUT /api/rooms/:id/... |  |  - Cap MAX_PEERS_PER_USER=8   |  |    edge sweep (<=100/pass)|  |
|  |  - GET /api/spatial-audit |  |  - Nearest-first slot refill  |  |  - Redis outage/recovery  |  |
|  |  - Static client/dist SPA |  |  - Position-revision fencing  |  |    local reconciliation   |  |
|  +---------------------------+  +-------------------------------+  +---------------------------+  |
+-----------------------|-------------------------------------------------------|-------------------+
                        |                                                       |
                        | Mongoose (GeoJSON Point)                              | ioredis (optional)
                        v                                                       v
+-----------------------------------------------+     +---------------------------------------------+
|            MONGODB GEOSPATIAL ENGINE          |     |       REDIS PUB/SUB + SHARED EDGESTORE      |
|  - UserPresence: 2dsphere index on `location` |     |  - @socket.io/redis-adapter fan-out         |
|  - Tangent-plane projection (1 px = 0.1 m)    |     |  - RedisEdgeStore atomic Lua scripts:       |
|  - $near, $geoWithin ($centerSphere),         |     |    createEdge (cap + revision fence),       |
|    and O(N) spatial-grid cluster engine       |     |    removeEdge, removeUser, generation floor |
|  - Room: obstacles, spawnPoints,              |     |  - Cross-instance room:cache:invalidate     |
|    monotonic `layoutRevision`                 |     |  - Graceful single-instance fallback        |
+-----------------------------------------------+     +---------------------------------------------+
```

---

## Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| **Runtime** | Node.js `>= 18.17` (ESM) | Server runtime, CLI scripts, and built-in `node:test` test runner |
| **HTTP & Static Hosting** | Express `4.x`, `cors` | `/health`, `/api/rooms`, `/api/spatial-audit`, and single-origin `client/dist/` static + SPA serving |
| **Realtime & Signaling** | Socket.io `4.8` (`socket.io`, `socket.io-client`) | Avatar presence, `10 Hz` movement broadcast, fenced WebRTC signaling relay, and live `room:layout` sync |
| **Geospatial & Persistence** | MongoDB + Mongoose `8.x` | `UserPresence` (`2dsphere` GeoJSON index) and `Room` (`layoutRevision`, obstacles, spawnPoints) |
| **Multi-Instance Scaling** | Redis + `ioredis` `6.x` + `@socket.io/redis-adapter` | Cross-instance Socket.io broadcast and Lua-scripted `RedisEdgeStore` |
| **Frontend UI & World** | React `18.3`, Vite `6.x`, HTML5 2D `<canvas>` | Join screen, HUD overlays, offscreen static room layer, and dynamic avatar renderer |
| **Browser Media & Audio** | WebRTC (`RTCPeerConnection`, `getUserMedia`) + Web Audio API | P2P audio transport, `StereoPannerNode` panning, and `GainNode` distance + obstacle attenuation |

---

## Folder Structure

```text
ProxiSpeak/
├── .env.example                  # Documented server & test environment variable template
├── CHANGELOG.md                  # Chronological and feature-level commit history
├── README.md                     # Project overview, architecture, setup, and reference
├── package.json                  # Root orchestration scripts (build, start, test, seed, CLI)
├── railway.json                  # Railway Nixpacks build, start, and /health configuration
├── scripts/
│   └── run-tests.mjs             # Root test runner sequencing server then client suites
├── server/
│   ├── package.json              # Server dependencies and scripts
│   ├── layouts/                  # Example room layout JSON blueprints (valid-office, quiet-zone)
│   ├── scripts/
│   │   ├── seed.js               # Idempotent room & 2dsphere index seeder
│   │   ├── audit.js              # Spatial audit CLI ($near, $geoWithin, clustering vs brute force)
│   │   ├── room-layout.js        # Room layout inspection & save CLI (show, save, --dry-run)
│   │   ├── scale-check.js        # Two-instance Redis Socket.io scaling verification CLI
│   │   └── mesh-check.js         # Embedded & external WebRTC mesh optimization checker
│   ├── src/
│   │   ├── index.js              # Server boot sequence and graceful shutdown
│   │   ├── app.js                # Express routes, CORS, error handler, and client/dist serving
│   │   ├── config/               # Central env parser (index.js) and ICE_SERVERS parser
│   │   ├── db/                   # MongoDB (mongo.js) and optional Redis (redis.js) connectors
│   │   ├── models/               # Mongoose schemas: UserPresence (2dsphere) and Room
│   │   ├── services/             # peerGraph, edgeStore, redisEdgeStore, proximityService,
│   │   │                         # roomService, spatialAudit, presenceStore/Cleanup, edgeSweep
│   │   ├── sockets/              # Socket.io gateway, payload validation, and Redis adapter
│   │   ├── utils/                # Tangent-plane geo transform, logger, origin, rateLimiter, errors
│   │   └── validators/           # Shared room layout and obstacle validator (roomLayout.js)
│   └── test/                     # 28 server unit and integration test files (node:test)
├── client/
│   ├── .env.example              # Documented client VITE_* variable template
│   ├── package.json              # Client dependencies and scripts
│   ├── vite.config.js            # Vite config with /socket.io and /api dev proxy
│   ├── scripts/                  # Reproducible benchmarks: occlusion-bench, panning-report, render-report
│   ├── src/
│   │   ├── main.jsx / App.jsx    # React entry and top-level state transitions
│   │   ├── config.js             # Single source of truth for SERVER_URL resolution
│   │   ├── audio/                # attenuation.js, occlusion.js, panning.js, audioMixer.js, audioPausedHint.js
│   │   ├── canvas/               # coords.js, staticLayer.js, renderer.js, frameLoop.js
│   │   ├── components/           # JoinScreen.jsx, WorldCanvas.jsx, AudioStatus.jsx
│   │   ├── hooks/                # useSocket.js and useMovement.js
│   │   ├── movement/             # Pure movement maths, keyboard/pointer input, 10 Hz throttle
│   │   ├── perf/                 # Preallocated frameStats.js ring buffer and ?perf=1 readout
│   │   ├── realtime/             # Mutable worldState.js, connectionStatus, sessionRecovery, meshIndicator
│   │   └── webrtc/               # localMedia.js, peerManager.js, remoteAudio.js, rtcStats.js
│   └── test/                     # 22 client unit test files (node:test)
└── docs/                         # Architecture guides, demo scripts, limitations, and requirements trace
```

---

## Quick Start

### 1. Single Instance (Development Mode)

Requires Node.js `>= 18.17` and a running MongoDB instance (`mongodb://127.0.0.1:27017/proxispeak` by default):

```bash
npm run install:all
cp .env.example .env
npm run seed
npm start
```

In a second terminal, start the Vite development server:

```bash
npm run dev:client
```

Open `http://localhost:5173` in two browser windows, join `lobby`, and allow microphone access (or choose **Listen only**).

### 2. Two Instances with Redis (Clustered Mode)

Start MongoDB and Redis (`redis://127.0.0.1:6379`), seed once, and start two server instances on ports `4000` and `4001`:

```bash
npm run seed
PORT=4000 INSTANCE_ID=node-1 REDIS_URL="redis://127.0.0.1:6379" npm start
PORT=4001 INSTANCE_ID=node-2 REDIS_URL="redis://127.0.0.1:6379" npm start
```

Verify cross-instance presence, edge synchronization, and WebRTC signaling relay:

```bash
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
```

To run the self-contained two-instance mesh benchmark with real Redis and in-memory presence (no MongoDB required):

```bash
REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check
```

### 3. Production Mode (Single Origin)

In production mode, one Node process serves the built React app (`client/dist/`), the REST API, and Socket.io on the same port with same-origin CORS:

```bash
npm run build
npm run seed
NODE_ENV=production CLIENT_URL= PORT=4000 npm start
```

Open `http://localhost:4000` (and `http://localhost:4000/health`). No separate frontend server or `VITE_SERVER_URL` is needed. For cloud deployment on Railway + MongoDB Atlas over HTTPS, see [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## All Scripts

| Script | Command | Description | External Services Required |
| --- | --- | --- | --- |
| `npm run build` | `npm run install:all && npm --prefix client run build` | Install both `server/` and `client/` packages and build `client/dist/` from a clean clone | npm registry (first install) |
| `npm run build:client` | `npm --prefix client run build` | Build the Vite production bundle into `client/dist/` | None |
| `npm start` | `node server/src/index.js` | Start the Express + Socket.io server (serves `client/dist/` when built) | MongoDB (optional Redis) |
| `npm run dev:server` | `npm --prefix server run dev` | Start the server in `--watch` mode | MongoDB (optional Redis) |
| `npm run dev:client` | `npm --prefix client run dev` | Start the Vite dev server on port `5173` | None |
| `npm run install:all` | `npm run install:server && npm run install:client` | Install dependencies for both `server/` and `client/` | npm registry |
| `npm run install:server` | `npm install --prefix server` | Install server dependencies | npm registry |
| `npm run install:client` | `npm install --prefix client` | Install client dependencies | npm registry |
| `npm run seed` | `npm --prefix server run seed` | Idempotently ensure `2dsphere` indexes and seed `lobby`, `studio`, and `lounge` | MongoDB |
| `npm test` | `node scripts/run-tests.mjs` | Run the full server test suite followed by the client test suite | None (service suites skip loudly unless env vars set) |
| `npm run test:server` | `npm --prefix server test` | Run server `node --test` suites only | None (optional MongoDB/Redis) |
| `npm run test:client` | `npm --prefix client test` | Run client `node --test` suites only | None |
| `npm run audit -- ...` | `npm --prefix server run audit --` | Run the spatial audit (`--users=50 --samples=25 --seed=1`) | MongoDB |
| `npm run room:show -- ...` | `node server/scripts/room-layout.js show` | Print persisted room layout JSON (`--room <id>`) | MongoDB |
| `npm run room:save -- ...` | `node server/scripts/room-layout.js save` | Validate or atomically save room layout JSON (`--room <id> --file <path> [--dry-run]`) | MongoDB (unless `--dry-run`) |
| `npm run scale-check -- ...` | `npm --prefix server run scale-check --` | Verify two running instances sharing Redis (`--urlA=... --urlB=... --room=lobby`) | Two servers, MongoDB, Redis |
| `npm run mesh-check` | `npm --prefix server run mesh-check --` | Verify WebRTC mesh hysteresis, cap, and churn (embedded with `REDIS_URL`, or external with `--urlA/--urlB`) | Redis (plus two servers & MongoDB for external mode) |

---

## Environment Variables

Every server tunable is parsed and validated in `server/src/config/index.js` (`server/.env` takes precedence over root `.env`). Every client build/dev variable is read in `client/src/config.js` or `client/vite.config.js` (`client/.env`). Bidirectional drift between code and `.env.example` / `client/.env.example` is guarded by `server/test/configDrift.test.js`.

### Server Configuration (`server/src/config/index.js`)

| Variable | Config Path | Default | Validation / Constraint | Description |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `config.nodeEnv`, `config.isProduction` | `development` | String | Runtime mode (`production` sets empty-`CLIENT_URL` HTTP CORS to same-origin and defaults `AUDIT_ENABLED` to `false`) |
| `LOG_LEVEL` | `config.logLevel` | `info` | `debug`, `info`, `warn`, `error` | Minimum logger severity |
| `PORT` | `config.server.port` | `4000` | Integer `1..65535` | TCP port for Express and Socket.io |
| `HOST` | `config.server.host` | `0.0.0.0` | String | Network interface to bind (`0.0.0.0` for containers/PaaS) |
| `CLIENT_URL` | `config.server.clientOrigins` | `""` (`.env.example`: `http://localhost:5173`) | Comma-separated `http(s)://` origins, `*`, or empty | Browser CORS allow-list; empty means same-origin in production |
| `INSTANCE_ID` | `config.server.instanceId` | `node-<12-hex>` | `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` | Unique server process identifier reported in `/health` and presence rows |
| `ICE_SERVERS` | `config.iceServers` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array of STUN/STUNS objects (invalid JSON logs one warning and falls back) | ICE server list delivered in `joined` and `peer:connect` |
| `MONGO_URI` | `config.mongo.uri` | `mongodb://127.0.0.1:27017/proxispeak` | `mongodb://` or `mongodb+srv://` URL | MongoDB connection string (always redacted in logs) |
| `MONGO_TIMEOUT_MS` | `config.mongo.serverSelectionTimeoutMS` | `8000` | Integer `500..2147483647` | MongoDB server selection timeout in milliseconds |
| `REDIS_URL` | `config.redis.url` | `""` | `redis://`, `rediss://`, or empty | Optional Redis URL for multi-instance Socket.io adapter and `RedisEdgeStore` |
| `REDIS_KEY_PREFIX` | `config.redis.keyPrefix` | `proxispeak` | `/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/` | Redis key namespace prefix |
| `EDGE_SWEEP_INTERVAL_MS` | `config.redis.edgeSweepIntervalMs` | `30000` | Integer `1..2147483647` | Orphan and distance edge sweep interval in milliseconds |
| `REDIS_CONNECT_TIMEOUT_MS` | `config.redis.connectTimeoutMs` | `3000` | Integer `100..60000` | Boot connection timeout for Redis before single-instance fallback |
| `REDIS_EDGE_TTL_SECONDS` | `config.redis.edgeTtlSeconds` | `3600` | Integer `60..604800` | Safety TTL in seconds on Redis edge keys |
| `WORLD_WIDTH` | `config.world.width` | `1920` | Number `>= 200` | Default room width in pixels |
| `WORLD_HEIGHT` | `config.world.height` | `1080` | Number `>= 200` | Default room height in pixels |
| `WORLD_CENTER_LAT` | `config.world.centerLat` | `37.7749` | Number `-90..90` | Tangent-plane projection center latitude |
| `WORLD_CENTER_LON` | `config.world.centerLon` | `-122.4194` | Number `-180..180` | Tangent-plane projection center longitude |
| `PIXELS_PER_METER` | `config.world.pixelsPerMeter` | `10` | Number `0.0001..1000000` | Geodetic projection scale (`10 px = 1 m`) |
| `PROXIMITY_RADIUS_PX` | `config.proximity.radiusPx` | `100` | Number `0..hypot(width,height)` | Maximum distance in pixels to create a new peer edge |
| `PEER_DISCONNECT_RADIUS_PX` | `config.proximity.peerDisconnectRadiusPx` | `115` | Number in `[PROXIMITY_RADIUS_PX, 3 * PROXIMITY_RADIUS_PX]` | Hysteresis distance in pixels beyond which an existing edge drops |
| `MAX_PEERS_PER_USER` | `config.proximity.maxPeersPerUser` | `8` | Integer `0..100000` (`0` = unlimited) | Symmetric maximum concurrent WebRTC peers per user |
| `PRESENCE_CLEANUP_INTERVAL_MS` | `config.presence.cleanupIntervalMs` | `30000` | Integer `1..2147483647` | Stale-presence sweep interval in milliseconds |
| `PRESENCE_TIMEOUT_MS` | `config.presence.timeoutMs` | `60000` | Integer `1..2147483647` | Presence inactivity threshold in milliseconds |
| `SOCKET_MOVE_EPS` | `config.socket.moveEventsPerSec` | `30` | Number `1..1000` | Per-socket `move` token-bucket rate (events/s) |
| `SOCKET_MAX_STEP_PX` | `config.socket.maxStepPx` | `120` | Number `1..100000` | Maximum pixel step per accepted `move` event |
| `SOCKET_SIGNAL_EPS` | `config.socket.signalEventsPerSec` | `30` | Number `1..1000` | Per-socket `signal` token-bucket refill rate (events/s) |
| `SOCKET_SIGNAL_BURST` | `config.socket.signalBurst` | `200` | Integer `1..10000` | Per-socket `signal` token-bucket burst capacity |
| `AUDIT_ENABLED` | `config.audit.enabled` | `true` in non-prod, `false` in prod | Boolean (`1/0`, `true/false`, `yes/no`) | Enables `GET /api/spatial-audit` |
| `AUDIT_TARGET_MS` | `config.audit.targetMs` | `20` | Number `0.001..60000` | Spatial audit p95 latency gate in milliseconds |
| `SCALE_CHECK_URL_1` / `SCALE_CHECK_URL_A` | `config.scaleCheck.url1` / `urlA` | `http://127.0.0.1:4000` | `http(s)://` URL | First server base URL for `scale-check` |
| `SCALE_CHECK_URL_2` / `SCALE_CHECK_URL_B` | `config.scaleCheck.url2` / `urlB` | `http://127.0.0.1:4001` | `http(s)://` URL | Second server base URL for `scale-check` |
| `SCALE_CHECK_ROOM` | `config.scaleCheck.roomId` | `lobby` | String | Target room id for `scale-check` |
| `ROOM_ADMIN_TOKEN` | `config.room.adminToken` | `""` | String (empty disables `PUT /api/rooms/:roomId/layout` with `403`) | Shared secret verified in constant time against `x-room-admin-token` |
| `ROOM_LAYOUT_MAX_OBSTACLES` | `config.room.maxObstacles` | `200` | Integer `1..10000` | Maximum obstacle count accepted in a room layout |

### Test & Client Environment Variables

| Variable | Location | Default | Description |
| --- | --- | --- | --- |
| `MONGO_URI_TEST` | `.env.example` (test suites) | `mongodb://127.0.0.1:27017/proxispeak` | Base MongoDB URI for isolated test databases (`proxispeak_*_test_*`) |
| `REDIS_URL_TEST` | `.env.example` (test suites) | `redis://127.0.0.1:6379` | Redis URL enabling Redis contract, TLS, outage, and two-instance integration suites |
| `VITE_SERVER_URL` | `client/.env.example` (`client/src/config.js`) | `http://localhost:4000` (dev), `""` (prod) | Optional explicit Socket.io server origin override |
| `VITE_DEV_ALLOWED_HOSTS` | `client/.env.example` (`client/vite.config.js`) | `.localhost` | Optional comma-separated extra hostnames allowed by Vite's dev server |

---

## Running Tests in Three Configurations

The test suite uses Node's built-in `node:test` runner (`scripts/run-tests.mjs` runs `server` then `client`). Integration tests that require Redis or MongoDB skip loudly with an explicit `NOT VERIFIED` banner when their service is absent—never silently passing.

1. **Pure Unit & In-Memory Suite (No External Services)**:
   ```bash
   npm test
   ```
   Runs all pure server tests (`197` passing, `77` skipped service tests out of `274`) and all client tests (`224/224` passing).

2. **With Real Redis (`REDIS_URL_TEST`)**:
   ```bash
   REDIS_URL_TEST="redis://127.0.0.1:6379" npm test
   ```
   Enables `RedisEdgeStore` Lua contract tests, TLS `rediss://` tunnel tests, mid-run Redis kill/recovery and `FLUSHALL` self-healing tests, two-instance Socket.io adapter + mesh tests, and live `room:layout` Redis invalidation tests (`234` server tests passing, `40` MongoDB tests skipped out of `274`; `224/224` client tests passing).

3. **Full Service-Backed Suite (Real MongoDB + Real Redis)**:
   ```bash
   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" \
   REDIS_URL_TEST="redis://127.0.0.1:6379" \
   npm test
   ```
   Runs all `274` server tests and `224` client tests with **zero skips** (each MongoDB suite creates and drops its own isolated `proxispeak_*_test_<pid>_<ts>` database).

---

## Controls & Overlays

- **Move avatar**: `WASD` or `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` (`300 px/s`, frame-rate-independent), or **click anywhere on the room floor** to walk to that coordinate.
- **Microphone mode**: Choose microphone capture or **Listen only** on the Join screen (if microphone permission is denied or unavailable, the session continues in Listen only mode with a notice).
- **Audio & Mesh HUD**: Polled at most once per second (zero per-frame React state). Shows connected peer count vs. cap (`connected N / max`), per-peer Euclidean distance (`px`), gain percentage, obstacle transmission (`volume 4% (blocked 12%)` or `volume 39% (100%)`), stereo pan (`pan R 62%`, `pan L 40%`, `pan C`), WebRTC `connectionState`, and inbound audio `bytesReceived`.
- **Paused-audio recovery**: If browser autoplay policy suspends or interrupts `AudioContext` while peers are connected, the overlay displays `Audio is paused by the browser. Click anywhere on the page.` and automatically calls `resume()` on the next pointer gesture or tab visibility restore.
- **Performance readout (`?perf=1`)**: Appending `?perf=1` to the URL enables a read-only telemetry line (`fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0`) updated at most once per second via `textContent`. When `?perf=1` is absent, zero frame sampling runs.

---

## Documentation Index

See [`docs/INDEX.md`](docs/INDEX.md) for the complete documentation index:

- **Deployment & Operations**:
  - [`docs/DEPLOY.md`](docs/DEPLOY.md) — Single-origin production serving, local production mode, MongoDB Atlas `M0` + Railway HTTPS setup, rollback, and troubleshooting
  - [`docs/DEMO_FINAL.md`](docs/DEMO_FINAL.md) — 10-minute Final Project Review live demonstration script
  - [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — Known technical, network, and verification limitations
  - [`docs/REQUIREMENTS_TRACE.md`](docs/REQUIREMENTS_TRACE.md) — Traceability matrix mapping every company plan requirement to implementation files, tests, commands, and verification status
  - [`CHANGELOG.md`](CHANGELOG.md) — Full commit-verified project changelog
- **Feature & Subsystem Deep-Dives**:
  - [`docs/RENDERING.md`](docs/RENDERING.md) — Steady 60 FPS Canvas 2D pipeline, baseline operation counts, `staticLayer`, `frameStats`, and allocation measurements
  - [`docs/PANNING.md`](docs/PANNING.md) — Stereo panning law, `StereoPannerNode` audio chain, smoothing constants, and benchmarks
  - [`docs/OCCLUSION.md`](docs/OCCLUSION.md) — 2D Liang-Barsky obstacle sound occlusion, transmission math, and benchmarks
  - [`docs/ROOM_PERSISTENCE.md`](docs/ROOM_PERSISTENCE.md) — Room layout persistence, `layoutRevision` concurrency, guarded REST API, live `room:layout` broadcast, and CLI
  - [`docs/MESH_OPTIMIZATION.md`](docs/MESH_OPTIMIZATION.md) — WebRTC mesh cap, hysteresis, nearest-first selection, and revision fencing
  - [`docs/REDIS_SCALING.md`](docs/REDIS_SCALING.md) — Multi-instance Socket.io Redis Pub/Sub adapter and atomic Lua `RedisEdgeStore`
- **Earlier Milestone Notes & Demos**:
  - [`docs/WEEK1.md`](docs/WEEK1.md), [`docs/WEEK2.md`](docs/WEEK2.md), [`docs/WEEK3.md`](docs/WEEK3.md) — Milestone implementation notes
  - [`docs/DAY7.md`](docs/DAY7.md), [`docs/DAY8.md`](docs/DAY8.md), [`docs/DAY9.md`](docs/DAY9.md), [`docs/DAY11.md`](docs/DAY11.md) — Subsystem design records
  - [`docs/DEMO_WEEK1.md`](docs/DEMO_WEEK1.md), [`docs/DEMO_MIDREVIEW.md`](docs/DEMO_MIDREVIEW.md), [`docs/DEMO_WEEK3.md`](docs/DEMO_WEEK3.md) — Earlier milestone demo scripts
