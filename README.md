# ProxiSpeak — Geospatial Proximity Audio Ecosystem

A virtual space where **proximity is the volume knob**. You see a live 2D map, you move
your avatar, and the moment you walk inside somebody's earshot circle a WebRTC audio
connection opens and crossfades in; walk away and it closes. Walls between you muffle
the voice.

## Problem statement

Voice chat today is flat: everyone in a call is equally loud no matter where they
"are", so large calls turn into either chaos or muted silence, and there is no sense
of place, distance or serendipity. ProxiSpeak treats conversation as something you
*walk into* — participants live on a geolocated 2D map, rooms are anchored to
coordinates, and the server continuously computes who is within earshot of whom.
Moving closer makes a voice louder and clearer; moving away fades it out and
eventually tears the audio connection down.

The result is a persistent audio world for events, campuses, offices and
communities: no hand-raising, no lobby moderation — you simply walk up to people
and talk.

## Tech stack

* **Backend** — Node.js, Express, Socket.io, MongoDB (`$near` / `$geoWithin`,
  `2dsphere`), optional Redis Pub/Sub + Lua edge state (`@socket.io/redis-adapter`,
  `ioredis` — Day 12).
* **Frontend** — React, HTML5 Canvas API, WebRTC (`getUserMedia`), Web Audio API
  (Day 11 distance attenuation; panning/occlusion remain Week 4).

No other libraries. No TURN. No UI kit, no state-management library, no extra
database.

## Key modules

| Module | What it does | Status |
| --- | --- | --- |
| `server/` — Express app | Health endpoint (`instanceId`, `scaleMode`), JSON API surface, config + logger | **Day 1 & Day 12 — done** |
| Geospatial engine | MongoDB `2dsphere` queries (`$near`, `$geoWithin`) mapped onto the 2D world plane | Week 1–2 |
| Presence & signaling | Socket.io gateway, atomic presence sweeps, `EdgeStore` (`MemoryEdgeStore` + Lua `RedisEdgeStore`), `@socket.io/redis-adapter`, `SCAN` orphan sweep | **Week 2 & Day 12 — done** |
| Voice mesh | WebRTC peer connections; bounded mesh (symmetric cap, hysteresis, nearest-first) | **Week 2 & Day 13 — done** |
| Spatial audio | Web Audio API distance attenuation (GainNode) | Day 11 done; panning and wall occlusion are Week 4 |
| Client | React + Canvas live map, avatar movement, WebRTC audio and read-only audio status | Week 1–3 slices done |

## Week-wise plan

| Week | Focus | Deliverables | Review |
| --- | --- | --- | --- |
| **Week 1** | Foundations & data layer | Project setup (Day 1), MongoDB connection, `UserPresence` / `Room` schemas with `2dsphere` index, seed script, health endpoint | Week 1 review: server boots green, geo data seeds and queries |
| **Week 2** | Real-time presence, proximity & P2P audio | Socket.io gateway, presence lifecycle, `$near` queries, in-process peer graph and WebRTC signaling/audio | Week 2 review: presence and proximity behavior |
| **Week 3** | Frontend attenuation, Redis scaling & mesh optimization (Days 11–13 done) | Day 11 Web Audio distance gain, Day 12 multi-instance Redis Pub/Sub + shared edge state, and Day 13 mesh optimization are done | Review gain curve, two-instance `npm run scale-check`, and `npm run mesh-check` |
| **Week 4** | Spatial audio and hardening | Stereo panning, obstacle occlusion, load testing and production hardening | Final review: end-to-end multi-user demo |

## Week 1 — what is done (Day 1–6)

A complete two-user slice of ProxiSpeak with **no audio yet**: you join a room
from the browser, see the room and everyone in it on a canvas map, walk around
with the keyboard or the mouse, and every other tab sees your avatar move.

### Tech stack (Week 1)

| Layer | Used in Week 1 | Later weeks |
| --- | --- | --- |
| Backend | Node.js, Express (health + JSON API), Socket.io, MongoDB via Mongoose (`2dsphere`) | Redis Pub/Sub adapter (planned Day 12, Week 3; not installed yet) |
| Frontend | React 18 + Vite, HTML5 Canvas 2D, `socket.io-client` | WebRTC (`getUserMedia`); Web Audio attenuation (Day 11), panning/occlusion (Week 4) |
| Tooling | Node's built-in test runner (`node --test`), no test framework, no UI kit, no state library | — |

### Key modules

| Module | File(s) | What it does |
| --- | --- | --- |
| Boot & config | `server/src/index.js`, `server/src/config/index.js`, `server/src/utils/httpServer.js` | Config from `.env`, connect MongoDB, ensure indexes, one HTTP+WebSocket port, graceful shutdown, one-line listen errors |
| HTTP surface | `server/src/app.js` | `GET /health`, JSON 404, error handler, CORS from `CLIENT_URL` |
| Data layer | `server/src/db/mongo.js`, `server/src/models/UserPresence.js`, `server/src/models/Room.js` | Connection lifecycle, `2dsphere` index on `UserPresence.location`, room blueprints |
| Projection | `server/src/utils/geo.js` | Pixel plane ⇄ GeoJSON (1 px = 0.1 m) for `$near` / `$geoWithin` on the day they arrive |
| Realtime gateway | `server/src/sockets/index.js`, `server/src/sockets/validation.js` | `join` / `move` / disconnect, payload validation, bounds + step caps, rate limit, room-scoped fan-out |
| Presence store | `server/src/services/presenceStore.js`, `server/src/services/roomService.js` | Upsert/delete presence documents, room lookup with an in-process cache |
| World state | `client/src/realtime/worldState.js`, `client/src/realtime/connectionStatus.js` | What the server said (room + avatars, pure and unit-tested) and the connection status rules |
| Socket hook | `client/src/hooks/useSocket.js` | Owns the connection; keeps the world in a ref so avatar updates never re-render React |
| Movement | `client/src/movement/*.js`, `client/src/hooks/useMovement.js` | Keyboard/click-to-move maths, 10 Hz broadcast throttle, remote-avatar interpolation |
| Rendering | `client/src/canvas/renderer.js`, `client/src/canvas/coords.js`, `client/src/components/WorldCanvas.jsx` | Letterboxed room, grid, obstacles, avatars; canvas sizing that survives tiny and huge windows |
| Join screen | `client/src/components/JoinScreen.jsx`, `client/src/join/joinForm.js` | Name/room validation and the sentences shown for server and connection errors |

### Folder structure

```
ProxiSpeak/
├── package.json            # root scripts (install, dev, test, seed, build)
├── scripts/run-tests.mjs   # runs the server suite, then the client suite
├── .env.example            # PORT, MONGO_URI, CLIENT_URL, socket limits
├── docs/
│   ├── WEEK1.md            # Week 1 deliverables, events, data model, architecture
│   └── DEMO_WEEK1.md       # 5-minute demo script + troubleshooting
├── server/
│   ├── package.json
│   ├── scripts/seed.js     # creates the 2dsphere index + lobby/studio/lounge
│   ├── src/
│   │   ├── index.js        # boot: MongoDB -> HTTP -> Socket.io -> shutdown
│   │   ├── app.js          # Express surface
│   │   ├── config/index.js # every tunable, from .env
│   │   ├── db/mongo.js     # connect / disconnect / ensureIndexes
│   │   ├── models/         # UserPresence (2dsphere), Room (layout + obstacles)
│   │   ├── services/       # presenceStore, roomService
│   │   ├── sockets/        # gateway + payload validation
│   │   └── utils/          # geo projection, logger, errors, rate limiter, listen helper
│   └── test/               # node:test suites (unit + Socket.io integration)
└── client/
    ├── package.json
    ├── vite.config.js      # dev proxy to :4000, optional extra dev hosts
    ├── index.html
    ├── src/
    │   ├── main.jsx, App.jsx, styles.css
    │   ├── canvas/         # coords + renderer
    │   ├── components/     # JoinScreen, WorldCanvas
    │   ├── hooks/          # useSocket, useMovement
    │   ├── join/           # join-form rules and error sentences
    │   ├── movement/       # movement maths, controller, throttle, input rules
    │   └── realtime/       # world state + connection status
    └── test/               # node:test suites (no browser needed)
```

### Setup

Prerequisites: **Node.js ≥ 18.17** and a MongoDB (local or Atlas). No other
service, no Redis, no Docker.

```bash
cp .env.example .env          # MONGO_URI + CLIENT_URL (defaults work locally)
npm run install:all           # installs server/ and client/
```

* **Local MongoDB** — start `mongod --dbpath ./data` (or your service) and keep
  the default `MONGO_URI=mongodb://127.0.0.1:27017/proxispeak`.
* **Atlas** — set `MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/proxispeak?retryWrites=true&w=majority`
  and allow your IP under *Network Access*. Details in [Day 2](#day-2-mongodb-setup).
* `CLIENT_URL=http://localhost:5173` is the browser origin allowed to open the
  socket; without it the websocket is same-origin only.

### Run

```bash
npm run seed        # idempotent: 2dsphere index + lobby / studio / lounge
npm start           # one process: HTTP + WebSocket on http://localhost:4000
npm run dev:client  # Vite dev server on http://localhost:5173 (second terminal)
```

Root scripts:

| Script | What it does |
| --- | --- |
| `npm run install:all` | `install:server` + `install:client` |
| `npm start` / `npm run dev:server` | Server (once / with `node --watch`) |
| `npm run dev:client` | Vite dev server for the client |
| `npm run seed` | Creates the index and the default rooms (re-running is safe) |
| `npm run audit` | Runs the Day 10 geospatial latency & accuracy audit |
| `npm run scale-check` | Verifies cross-instance presence, single edge creation, WebRTC signaling, and disconnects across two running server instances |
| `npm test` | **Both** suites: server first, then client; fails if either fails |
| `npm run test:server` / `npm run test:client` | One suite on its own |
| `npm run build` (alias `build:client`) | Production build into `client/dist/` |

### Test

```bash
npm test
```

* Server suite — unit tests (projection, validation, rate limiter, CORS policy,
  connection bookkeeping) plus Socket.io integration tests that run against
  their own throwaway database. **Without a reachable MongoDB those tests report
  themselves as skipped with a `NOT VERIFIED` banner instead of pretending to
  pass** — so a green run is only complete when `skipped 0`.
* Client suite — movement, canvas maths, renderer, world state, connection
  status, join form, config. No browser and no DOM needed.
* `MONGO_URI_TEST` overrides the database used by the integration tests.

### Controls

| Input | Effect |
| --- | --- |
| `W` `A` `S` `D` / arrow keys | Walk (diagonals are not faster) |
| Click the floor | Walk to that point and stop |
| Any movement key | Cancels a pending click target |
| Typing in a field | Movement keys are ignored |
| Window loses focus | Every held key is released |

More detail: [Day 5 — Movement and broadcasting](#day-5-movement-and-broadcasting).

### Known limitations at the end of Week 1 (historical snapshot)

* **No audio yet at this point in the project.** WebRTC and `getUserMedia` were
  added in Week 2; distance-based Web Audio attenuation arrived on Day 11.
* **No proximity logic.** Earshot, `$near` / `$geoWithin`, and the peer graph are
  Week 2. The projection (1 px = 0.1 m) and the `2dsphere` index they need are
  already in place.
* **Obstacles are visual only** — no collision or occlusion.
* **A client that drops keeps its server-side presence row until the server
  notices** (engine.io ping timeout, up to ~20 s), so peers can briefly see a
  frozen avatar. The reconnecting client itself never draws its own ghost; the
  presence lifecycle that removes the row immediately is Week 2.
* **A reconnect respawns you at a free spawn point** (the server does not resume
  your previous position) and you cannot switch rooms without reloading.
* **Single instance.** Rooms and the peer graph are process-local. Redis Pub/Sub
  multi-instance support is planned for Week 3 Day 12 and is not implemented.
* No rate limiting on joins, no auth, no persistence of movement history.

## Day 2: MongoDB setup

Day 2 adds the data layer: the MongoDB connection lifecycle, the `UserPresence`
and `Room` schemas, the `2dsphere` index on `UserPresence.location`, the
pixel ⇄ GeoJSON projection the schema depends on (1 px = 0.1 m), a position
persistence helper and a seed script.

### 1. Point the server at a MongoDB

Copy `.env.example` to `.env` (repo root) and set `MONGO_URI`.

* **Local MongoDB** — start `mongod --dbpath ./data` (or your usual service)
  and keep the default:
  ```bash
  MONGO_URI=mongodb://127.0.0.1:27017/proxispeak
  ```
* **Atlas (or any remote MongoDB)** — create a cluster + database user, allow
  your IP in *Network Access*, then paste the driver connection string:
  ```bash
  MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/proxispeak?retryWrites=true&w=majority
  ```

`MONGO_URI` is never printed verbatim: the server boot and the seed script
redact credentials before anything reaches the logs.

### 2. Install and seed

```bash
npm install --prefix server     # Day 2 adds mongoose
npm run seed                    # creates the 2dsphere index + default rooms
```

`npm run seed` works against any reachable `MONGO_URI` (local or Atlas) and is
idempotent — existing rooms are left untouched, indexes are re-checked. It ends
by printing the resulting index list:

```
indexes ensured (UserPresence.location = 2dsphere)
room "lobby" created
room "studio" created
room "lounge" created
UserPresence indexes: {"_id":1}, {"sessionId":1}, {"roomId":1}, {"location":"2dsphere"}, {"sessionId":1,"roomId":1}, {"roomId":1,"lastSeen":-1}
done
```

### 3. Verify the 2dsphere index

`ensureIndexes()` also runs on every server boot, so the index exists even if
you never seed. To inspect it directly:

```bash
mongosh "mongodb://127.0.0.1:27017/proxispeak" --eval 'printjson(db.userpresences.getIndexes())'
```

Expected (trimmed):

```js
[
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { location: '2dsphere' }, name: 'location_2dsphere', '2dsphereIndexVersion': 3 },
  { v: 2, key: { sessionId: 1, roomId: 1 }, name: 'sessionId_1_roomId_1', unique: true },
  { v: 2, key: { roomId: 1, lastSeen: -1 }, name: 'roomId_1_lastSeen_-1' }
]
```

In **Compass**: `proxispeak` → `userpresences` → *Indexes* → `location_2dsphere`.
The rooms are visible in `proxispeak` → `rooms` (`lobby`, `studio`, `lounge`,
each with `width`/`height` and its obstacle layout).

### 4. Run

```bash
npm start        # connects to MongoDB, ensures indexes, then listens on :4000
curl http://localhost:4000/health
# {"status":"ok","service":"proxispeak","uptimeSeconds":1,"time":"…"}
```

`/health` stays pure liveness — it never touches MongoDB, so a blip in the
database can never mark a healthy process as dead. `SIGINT` / `SIGTERM` close
the HTTP server, disconnect from MongoDB and exit.

Run the geo projection unit tests with `npm test` (wired to `node --test`).

## Day 3: Socket.io events

Day 3 adds the realtime channel. Socket.io is attached to the **same HTTP server**
— and therefore the same port — that Express already owns, so `GET /health` and
the websocket can never drift apart. A client joins a room, reports movement and
leaves; every payload is validated on the server, every position is written
through the Day 2 presence store, and room-scoped broadcasts only ever reach the
room they belong to.

### 1. Configure and run

| Variable | Default | What it does |
| --- | --- | --- |
| `CLIENT_URL` | *(empty)* | Allowed browser origins for the websocket. Empty = **same-origin only**: no wildcard and no origin reflection, so a page served from another origin cannot open the socket. Comma-separated list (`http://localhost:5173`) = allow-list. `*` = explicit opt-in to every origin. |
| `SOCKET_MOVE_EPS` | `30` | Accepted `move` events per socket per second (token bucket; a burst up to this value is allowed). |
| `SOCKET_MAX_STEP_PX` | `120` | Largest distance one accepted `move` may travel. |
| `MONGO_URI` | local default | Rooms and presence live in MongoDB (Day 2). |
| `INSTANCE_ID` | `node-<pid>` | Recorded in each presence document. |

Rooms are **data, not code**: `npm run seed` creates `lobby`, `studio` and
`lounge`, and the server logs which rooms exist on boot. A `join` for a room that
was never created is answered with `room_not_found`, so presence is never written
into a room that does not exist.

```bash
npm install --prefix server   # Day 3 adds socket.io (socket.io-client is dev-only)
npm run seed                  # rooms + the 2dsphere index
npm start                     # HTTP + websocket on the same port
```

### 2. Event reference

Every client event is validated server-side. `C→S` is client to server, `S→C` is
server to client; nobody ever receives an event from a room they are not in.

| Event | Direction | Payload | Notes |
| --- | --- | --- | --- |
| `join` | C→S | `{ roomId: string, name: string }` | `roomId` 1–48 chars (`a-z`, `0-9`, `-`, `_`; lowercased), `name` 1–24 chars, trimmed, control characters refused. |
| `joined` | S→C | `{ selfId, room: { roomId, name, width, height, obstacles[] }, users: [{ id, name, x, y }], iceServers, proximityRadiusPx, maxPeers, peerDisconnectRadiusPx }` | Reply to the joining socket only. `users` is the room as it currently stands, **including** the newcomer (identified by `selfId`). `proximityRadiusPx` is the server's configured `PROXIMITY_RADIUS_PX` (fallback: 100 for older servers). `maxPeers` is `MAX_PEERS_PER_USER` (0 = unlimited) and `peerDisconnectRadiusPx` is `PEER_DISCONNECT_RADIUS_PX` (default 115) — both are the client's source of truth for the overlay `connected N / max` and hysteresis. `obstacles` are data only (`id`, `type`, `x`, `y`, `w`, `h`, `blocksAudio`, `attenuation`) — no collision or occlusion logic. |
| `user:joined` | S→C | `{ id, name, x, y }` | The other sockets in the same room, once per successful join. |
| `move` | C→S | `{ x: number, y: number }` | Finite numbers only; the position is clamped into the room and the step is capped. |
| `user:moved` | S→C | `{ id, x, y }` | The same room only, excluding the mover. |
| `user:left` | S→C | `{ id }` | The same room only, after the socket dropped and its presence document was deleted. |
| `error` | S→C | `{ code, message, field? }` | Sent when an event is rejected; the connection stays open. |

`error` codes:

| Code | Meaning |
| --- | --- |
| `invalid_payload` | Malformed payload (`field` names the offending property). |
| `room_not_found` | `join` for a room that does not exist — run `npm run seed`. |
| `not_joined` | `move` before a successful join. |
| `already_joined` | A socket is bound to one room; a second room needs a reconnect. |
| `server_error` | Unexpected failure. The cause is logged server-side, never disclosed. |

### 3. What the server enforces

* **`join`** — validate → confirm the room exists → write presence through the
  Day 2 store (`UserPresence` upsert, 2dsphere GeoJSON point included) → join the
  Socket.io room channel → `user:joined` to the room → `joined` to the newcomer.
  Presence is written *before* anybody is told about it, so no ghost is broadcast.
  A duplicate join from the same socket re-serves the snapshot but creates no
  second document and no second `user:joined`.
* **`move`** — rejected with `not_joined` before a successful join and with
  `invalid_payload` for non-finite/absurd coordinates. Out-of-bounds coordinates
  are clamped into the room (the server owns the position, so an avatar can never
  leave the floor plan), and a step longer than `SOCKET_MAX_STEP_PX` is shortened
  along the requested direction — a single event can never teleport. Events above
  `SOCKET_MOVE_EPS` are dropped silently: answering a flood with an error per
  event would only amplify it. Accepted moves are persisted through the Day 2
  helper and broadcast as `user:moved` to the same room, never back to the mover.
* **Spawning** — a newcomer spawns on the spawn point furthest away from the
  users already inside the room, so two clients never stack on one pixel.
* **`disconnect`** — `user:left` to the room, leave the channel, then delete this
  socket's own presence document. The teardown is scoped to the socket id, so the
  fresh document of a reconnected socket is never removed by the old connection,
  and a socket that never joined (or whose document is already gone) is a no-op.
* **Payload hygiene** — events carry ids, names and pixels only: never a
  connection string, a document `_id`, a session detail or any other database
  artifact. `MONGO_URI` stays redacted in the logs and payloads are never logged.
* Shutdown stays a single routine: `SIGINT`/`SIGTERM` close the websocket, wait
  for the presence deletes those disconnects started (`io.drainSessions()`, so a
  graceful stop never leaves ghost documents behind), then close the HTTP server
  and finally MongoDB — no duplicate handlers, and a second signal during a slow
  drain is a no-op.

### 4. Manual test with two clients

```bash
mongod --dbpath ./data &          # or your usual MongoDB service
cp .env.example .env              # MONGO_URI=mongodb://127.0.0.1:27017/proxispeak
npm install --prefix server
npm run seed                      # creates lobby / studio / lounge
npm start                         # logs the rooms it found, then listens on :4000
```

In a second terminal, create a **temporary** script (not a committed file) and
run it — two real clients joining `lobby`, one moving, one disconnecting:

```bash
cat > server/tmp-two-clients.mjs <<'EOF'
import { io } from 'socket.io-client';

const url = process.env.SOCKET_URL ?? 'http://localhost:4000';
const roomId = process.env.ROOM_ID ?? 'lobby';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (label) =>
  new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'] });
    socket.on('connect', () => { console.log(`[${label}] connected ${socket.id}`); resolve(socket); });
    socket.on('connect_error', reject);
    socket.on('error', (err) => console.log(`[${label}] error event`, err));
  });

const join = (socket, name) =>
  new Promise((resolve) => { socket.once('joined', resolve); socket.emit('join', { roomId, name }); });

const ada = await connect('ada');
const bob = await connect('bob');

ada.on('user:joined', (u) => console.log('[ada] user:joined', u));
bob.on('user:joined', (u) => console.log('[bob] user:joined', u));
bob.on('user:moved', (u) => console.log('[bob] user:moved', u));
bob.on('user:left', (u) => console.log('[bob] user:left', u));

const adaJoined = await join(ada, 'Ada');
await sleep(200);
const bobJoined = await join(bob, 'Bob');

console.log('room:', adaJoined.room.roomId, `${adaJoined.room.width}x${adaJoined.room.height}`, `${adaJoined.room.obstacles.length} obstacles`);
console.log('ada sees users:', adaJoined.users.map((u) => u.id));
console.log('bob sees users:', bobJoined.users.map((u) => u.id));

const self = adaJoined.users.find((u) => u.id === ada.id);
ada.emit('move', { x: self.x + 40, y: self.y + 20 });   // a legal step (<= 120 px)
ada.emit('move', { x: 99999, y: 99999 });               // clamped into the room
ada.emit('move', { x: Number.NaN, y: 10 });             // rejected: "error" event
ada.emit('move', { x: self.x + 5000, y: self.y });      // capped: no teleporting
await sleep(400);

ada.close();                                            // presence document is deleted
await sleep(400);
process.exit(0);
EOF
node server/tmp-two-clients.mjs
rm server/tmp-two-clients.mjs        # temporary by design: never commit it
```

Expected shape of the output (ids and the interleaving of the two clients vary
between runs):

```
[ada] connected <ada-id>
[bob] connected <bob-id>
[ada] user:joined { id: '<bob-id>', name: 'Bob', x: 1670, y: 778 }  # broadcast to the room
room: lobby 1920x1080 10 obstacles
ada sees users: [ '<ada-id>' ]
bob sees users: [ '<ada-id>', '<bob-id>' ]
[bob] user:moved { id: '<ada-id>', x: 270, y: 150 }                 # the legal step
[bob] user:moved { id: '<ada-id>', x: 374.54, y: 208.92 }           # 99999 clamped + capped
[ada] error event {
  code: 'invalid_payload',
  message: '"x" must be a finite number',
  field: 'x'
}
[bob] user:moved { id: '<ada-id>', x: 494.38, y: 202.8 }            # +5000 px capped again
[bob] user:left { id: '<ada-id>' }                                  # presence deleted
```

While the script runs, watch the documents appear and disappear:

```bash
mongosh "mongodb://127.0.0.1:27017/proxispeak" --eval 'db.userpresences.find({ roomId: "lobby" }, { sessionId: 1, name: 1, x: 1, y: 1, location: 1 }).pretty()'
```

One document per socket: created on `join`, updated on `move` (the GeoJSON
`location` always agrees with `x`/`y`), deleted on disconnect. `/health` keeps
answering `200` on the same port throughout:

```bash
curl -i http://localhost:4000/health
```

## Status

* **Day 1 status: setup done** — repo structure, `.gitignore`, `.env.example`,
  root scripts, Express server skeleton (config, logger, CORS, JSON parsing,
  trust proxy) and `GET /health`.
* **Day 2 status: MongoDB + geospatial schema done** — connection lifecycle
  (`connectMongo` / `disconnectMongo` / `ensureIndexes`), `UserPresence`
  (GeoJSON `location` + `2dsphere`), `Room` (pixel dimensions + obstacle
  layout), geo projection utility with unit tests, position persistence helper
  and the `lobby` / `studio` / `lounge` seed.
* **Day 3 status: Socket.io presence done** — the realtime channel on the
  existing HTTP server (`server/src/sockets/`), `join` / `joined` /
  `user:joined`, `move` / `user:moved` with bounds + step + rate-limit guards,
  disconnect cleanup with `user:left`, room-scoped broadcasts only, a documented
  `error` event, and integration + validation tests.
* **Day 4 status: React client + canvas world done** — Vite + React client in
  `client/` (join screen, Socket.io world-state hook, DPR-aware canvas with
  floor/grid/obstacle/avatar rendering, coordinate-helper unit tests). No
  movement input yet (Day 5).
* **Day 5 status: movement and broadcasting done** — delta-time WASD/arrow
  and click-to-move walking at a constant 300 px/s with normalised
  diagonals and room-bounds clamping, client-side prediction with zero
  React renders per frame, `move` broadcasting throttled to 10 Hz
  (changed positions only, plus the exact resting position after a stop),
  and smooth frame-rate-independent interpolation of remote avatars with a
  reconnect snap. No server change was needed (see the limit check below).
* **Day 6 status: Week 1 polish done** — `README_backup.md` and the dead code
  around it removed, root `npm test` runs both suites, the Week 1 bug hunt
  (canvas sizing on tiny/huge windows, join-snapshot race, move-after-reconnect,
  the reconnecting client's own ghost avatar, duplicated MongoDB listeners, the
  busy-port stack trace) with tests, connection-lost/reconnect messaging on the
  client, and the Week 1 documentation (`docs/WEEK1.md`, `docs/DEMO_WEEK1.md`,
  `CHANGELOG.md`).
* **Day 8 status: peer graph and signaling done (backend)** — an in-memory,
  per-room peer graph (`server/src/services/peerGraph.js`) derived from the
  Day 7 `findNearby` query, `peer:connect` / `peer:disconnect` events, and a
  `signal` relay restricted to live edges and matching generations. No browser
  audio, WebRTC client, Redis, TURN or new library is included.
* Redis, WebRTC, the proximity queries (`$near` / `$geoWithin` / `$geoNear`),
  audio and collision/occlusion are intentionally **not** part of Days 1–6;
  they land with their own days/weeks above.

## Day 4: Client and world rendering

Day 4 adds the first browser client: a Vite + React scaffold in `client/`,
a Socket.io hook that keeps the whole world in a ref (so realtime avatar
updates never re-render React), a validated join screen, and an HTML5
Canvas world that paints the room the server describes — floor, light
grid, obstacles and every avatar in it. There is deliberately **no
movement input yet**: you see the position the server gave you in
`joined`; keyboard/mouse movement and throttled `move` broadcasting are
Day 5.

The client talks only to the Day 3 contract (`join` / `joined` /
`user:joined` / `user:moved` / `user:left` / `error`). No server code
changed on Day 4. The only dependencies are `react`, `react-dom` and
`socket.io-client`, with Vite + `@vitejs/plugin-react` as build tooling.

### Run server + client in dev

You need a local (or remote) MongoDB, as on Day 2 — the server stores
rooms and presence there.

```bash
# terminal 1 — server (repo root)
cp .env.example .env            # CLIENT_URL already allows http://localhost:5173
npm install --prefix server
npm run seed                    # creates lobby / studio / lounge
npm start                       # HTTP + websocket on :4000

# terminal 2 — client (repo root)
npm run install:client          # same as: npm install --prefix client
npm run dev:client              # Vite on http://localhost:5173
```

The server URL is resolved in exactly one place, `client/src/config.js`:
`VITE_SERVER_URL` (see `client/.env.example`) wins, otherwise
`http://localhost:4000` in dev and same-origin in a production build.
No other module hardcodes a server URL. In dev the Vite server also
proxies `/socket.io` (websocket) and `/api` to `http://localhost:4000`
(see `client/vite.config.js`).

Production build (serving it from Express is a later day):

```bash
npm run build:client            # same as: npm run build --prefix client
```

### What you should see

1. Open `http://localhost:5173`: a join screen with a name input and a
   room selector defaulting to **lobby**. Empty/over-long names are
   refused on the spot; server rejections are shown in place —
   `room_not_found` (run `npm run seed`), invalid payloads, and
   connection failures (server down or origin not in `CLIENT_URL`).
2. Join **lobby** in two browser tabs with different names. Each tab
   shows the same room: a letterboxed 1920x1080 floor with a light
   grid and the server's obstacles, coloured per type — grey `wall`,
   amber `desk`, blue `screen`, purple `pillar`, green `plant`.
3. Both tabs show **both avatars** as labelled circles. Your own avatar
   is highlighted (bright fill, ring, "(you)"). Avatars appear on
   `user:joined`, follow `user:moved` and vanish on `user:left` —
   closing one tab removes its avatar from the other. Nobody moves yet:
   avatars sit at the spawn position the server assigned.
4. Resizing the window re-fits the room (letterboxed, never stretched,
   sharp on retina displays via devicePixelRatio-aware sizing).

World state (room size, obstacles, users by id, `selfId`) lives in a
mutable ref owned by `client/src/hooks/useSocket.js`; the canvas
(`client/src/components/WorldCanvas.jsx`) reads it inside a single
`requestAnimationFrame` loop started on mount and cancelled on
unmount, when it also removes its resize listener. The socket
disconnects when the hook unmounts, so a closed tab leaves no presence
behind server-side either.

### Tests

The world-to-screen maths lives in pure helpers
(`client/src/canvas/coords.js` — `computeViewport`, `worldToScreen`,
`screenToWorld`), unit-tested with Node's built-in test runner, no new
framework:

```bash
npm test --prefix client        # node --test: letterboxing, inverse mapping, validation
```

## Day 5: Movement and broadcasting

Day 5 makes the world walkable. The local avatar moves the moment you
touch a key (client-side prediction), the position lives in the world
ref — never in React state — and the single Day 4 `requestAnimationFrame`
loop advances the world before painting it, so movement costs **zero
React renders per frame**. The server hears about movement at most 10
times a second; remote avatars glide between the reports.

### Controls

| Input | Effect |
| --- | --- |
| `W` `A` `S` `D` | Walk up / left / down / right (world pixels). |
| Arrow keys | Same as WASD. |
| Any diagonal (e.g. `W`+`D`) | Walks diagonally at the **same** speed — the direction vector is normalised, so diagonals are never faster. |
| Click on the floor | Walks to the clicked point (screen→world with the Day 4 helpers) and stops exactly on it. |
| Any movement key | Cancels a pending click target. |
| Typing | Ignored: while the join screen or any text input has focus, movement keys do nothing. |
| Window loses focus | Every held key is cleared, so a key cannot stay "stuck down" while you are away. |

`Ctrl`/`Meta`/`Alt` + key combinations are left to the browser —
shortcuts stay shortcuts.

### Movement model

* **Speed** — a constant **300 world px per second** (the lobby is
  1920×1080, so ~6.4 s to cross it). Speed is measured in world pixels,
  so it looks identical on every window size; the canvas scale only
  affects how large it appears.
* **Delta time** — every frame advances `speed × elapsedSeconds`.
  Movement is identical on a 60 Hz and a 144 Hz display; the unit tests
  prove 60 Hz and 144 Hz cover the same distance in the same time.
* **Bounds** — positions are clamped into the room on every step, the
  same clamp the server applies, so prediction and authority agree.
* **Frame cap** — one frame's delta time is capped at 100 ms, so a tab
  resuming after being hidden advances at most 30 px instead of
  teleporting (and can never outrun the server's step cap).
* Obstacles are still **visual only** — collision/occlusion is a later
  day, by design.

### Broadcasting

The avatar moves every frame, but `move { x, y }` is emitted through a
throttle (`client/src/movement/throttle.js`):

* **At most 10 Hz** — one emit per 100 ms at most, at any frame rate.
* **Only when changed** — an emit happens only if the position actually
  moved since the last one; a resting avatar sends nothing (a fresh
  `joined` snapshot rebases the throttle on the server-provided
  position, so joining alone never emits).
* **Exact resting position** — when movement stops, the next tick sends
  the final position (≤ 100 ms later), so peers see precisely where the
  avatar came to rest.

At 300 px/s and 10 Hz, one event travels **30 px** — a quarter of the
server's 120 px step cap — and 10 events/s is a third of the 30 events/s
rate limit, so a legitimate client is never dropped or corrected.

### Server limit check (no change needed)

The two server guards from Day 3, and how the Day 5 client relates to
them:

* **`SOCKET_MOVE_EPS` = 30** — a token bucket per socket: at most 30
  accepted `move` events per second (bursts up to 30, then refill at
  30/s). Above it, events are **dropped silently**.
* **`SOCKET_MAX_STEP_PX` = 120** — the largest distance one accepted
  `move` may travel; longer steps are **shortened along the requested
  direction** (never a teleport), and out-of-bounds coordinates are
  clamped into the room.

A legitimate Day 5 client (300 px/s, 10 Hz) was simulated for 10
seconds against both:

| Simulation | Sent | Accepted | Dropped | Step-capped / clamped |
| --- | --- | --- | --- | --- |
| Deterministic walk through the real limiter + validator (exact 100 ms ticks) | 100 | 100 | **0 (0.0%)** | **0 (0.0%)** |
| End-to-end: real Socket.io server + two `socket.io-client` peers, the mover driven by the actual client controller at 60 fps | 88 | 88 | **0 (0.0%)** | **0 (0.0%)** |

The end-to-end run also confirmed a maximum delivered step of 34.5 px
(cap 120), a maximum gap of 115 ms between emits, a final resting
position matching the broadcast within 0.004 px, and `user:left` on
close. 0% ≪ the ~5% threshold, so **`server/` was not changed** — the
existing limits already accept a legitimate 10 Hz client with room to
spare.

### Remote avatars

`user:moved` only moves a remote avatar's *target* (`tx`/`ty`); the
render loop glides the drawn position toward it every frame with the
exponential step `1 − exp(−12·dt)` — frame-rate independent, so the
glide is identical at any refresh rate and converges on the exact
reported position. A remote avatar more than 200 px from its target
(a reconnect, or a re-served `joined` snapshot) **snaps** instead of
sweeping across the floor. Server `error` events never break the
client, and positions the server provides (the `joined` snapshot) are
always accepted as the baseline.

### How to test with two tabs

1. Start MongoDB, the server and the client as on Day 4
   (`npm run seed`, `npm start`, `npm run dev:client`).
2. Open `http://localhost:5173` in **two tabs**, join the lobby with
   different names.
3. In tab A, hold `D`: your avatar moves immediately and smoothly; in
   tab B the same avatar **glides** — no snapping between updates.
4. Walk diagonally (`W`+`D`): the speed matches the straight-line speed.
5. Click a spot on the floor in tab A: the avatar walks there and stops
   exactly on it; press any key mid-walk to cancel.
6. Stop moving: within a tenth of a second tab B shows your **exact**
   resting position (compare both avatars — they match within a pixel).
7. Close tab A: its avatar disappears from tab B immediately.

### Tests

The pure movement maths (`client/src/movement/movement.js`), the
throttle and the framework-free controller are unit-tested with Node's
built-in runner — no new framework, no React, no DOM:

```bash
npm test --prefix client        # 37 movement tests: keys, speed, diagonals, clamping,
                                # click arrival (incl. zero-duration frames),
                                # 60-vs-144 Hz, throttle ≤ 10 Hz,
                                # final resting emit, interpolation, snap, epoch reset
                                # (99 tests in the whole client suite)
```


## Week 2 — Day 7: Proximity engine

Backend-only MongoDB service in `server/src/services/proximityService.js`:

- `findNearby(roomId, sessionId, radiusPx?)`: live same-room neighbors, excluding
  self, sorted by pixel distance; returns `{ id, distancePx }` entries. Uses
  `$near` with an exact stored-x/y boundary check.
- `countWithin(roomId, { x, y }, radiusPx?)`: live users inside the pixel circle,
  using `$geoWithin` / `$centerSphere` followed by exact pixel filtering.
- `computeClusters(roomId, radiusPx?)`: connected components using DB neighbor
  queries (chains count as one conversation; isolated users form singletons).

Default units: **100 px = 10 m**. Existing geo helpers handle metres/radians;
MongoDB candidate queries allow projection/numeric slack before exact pixel
filtering. Each service call logs elapsed `performance.now()` time at debug level.

Config: `PROXIMITY_RADIUS_PX=100`, `PRESENCE_CLEANUP_INTERVAL_MS=30000`,
`PRESENCE_TIMEOUT_MS=60000`. Set a unique, restart-stable `INSTANCE_ID` per
server (single-process default now `node-local`, replacing the PID fallback).
Boot deletes only that instance's old rows. Accepted moves and existing
Engine.IO pong heartbeats refresh `lastSeen`; reads exclude stale rows immediately.
Periodic instance-owned cleanup atomically rechecks age and broadcasts `user:left`
to each deleted row's room. Its interval is cleared and drained on shutdown.
No new HTTP route, client event, library, audio or signaling is introduced.

See [Day 7 implementation and verification](docs/DAY7.md) for API semantics,
config caveats, test commands and the explicit **NOT VERIFIED** MongoDB status.
Day 8 (peer graph and WebRTC signaling) builds directly on this service; see the
[Day 8 section](#week-2--day-8-peer-graph-and-signaling) below.

Expired presence closes the owning socket's transport so Socket.IO automatically
reconnects and sends a fresh `join`; moves never upsert and return
`error { code: "session_expired" }` if their room/instance-owned row is missing.
The client handles `session_expired` by reconnecting through its existing
connect/join/snapshot path, without adding listeners or duplicate avatars.

Clusters are computed from one roster snapshot, so they are internally
consistent for that snapshot; concurrent moves after the read are reflected on
the next call.


## Week 2 — Day 8: Peer graph and signaling

Backend-only slice: the server decides which users are within earshot and
orchestrates the WebRTC handshake, but it only relays signaling messages — it
never touches audio. Implementation: `server/src/services/peerGraph.js`,
`server/src/sockets/index.js`, `server/src/config/iceServers.js`. Full details,
test matrix and verification: [docs/DAY8.md](docs/DAY8.md).

### Events

| Event | Direction | Payload | When |
| --- | --- | --- | --- |
| `joined` | S → C | `{ selfId, room, users, iceServers }` | Join accepted; the existing snapshot now also carries the ICE list. |
| `peer:connect` | S → C | `{ peerId, name, initiator, generation, iceServers }` | A new edge; sent to both endpoints. Exactly one side has `initiator: true`. |
| `peer:disconnect` | S → C | `{ peerId, generation }` | The edge this user knew about was removed; sent to both endpoints. |
| `signal` | C → S | `{ to, generation, data }` | `data` is `{ type: "offer"\|"answer", sdp }` or `{ type: "candidate", candidate }`. |
| `signal` | S → C | `{ from, generation, data }` | Relayed only when a live edge exists in the sender's room and the generation matches. |
| `error` | S → C | `{ code, message, field? }` | `no_peer_edge`, `stale_generation`, `invalid_payload`, `not_joined`, `session_expired`. |

`data` is capped at 16 KB, SDP must be a string, and candidate objects are
whitelisted to `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment`.
Throttled signals are dropped silently; the socket stays connected.

### Edge, generation and initiator rules

- One edge per unordered pair, keyed by the two ids sorted; a pair can never
  have a duplicate edge.
- On join, accepted `move`, disconnect and presence expiry, only **that user's**
  neighbors are re-queried with the existing `findNearby` (`$near` + exact
  pixel check, radius `PROXIMITY_RADIUS_PX`, default 100 px). The result is
  diffed against the current edges; unchanged edges emit nothing, new neighbors
  add an edge, neighbors that left the radius remove one.
- Every edge gets a monotonically increasing process-wide `generation`. A
  removed-and-recreated edge has a larger generation, so delayed signaling for
  the old edge is refused.
- The lexicographically smaller user id is the initiator, so both peers can
  never send offers at the same time.
- Distance 0 is a valid edge; nobody connects to themselves; different rooms
  never share edges.
- Disconnect, expiry and a killed client remove all of that user's edges and
  emit one `peer:disconnect` per edge to the remaining peers. A reconnect gets a
  new socket/user id and fresh edges; the old id keeps nothing.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array for `RTCPeerConnection`; STUN/STUNS only (no TURN on Day 8). Malformed values fall back to the default with one warning line at boot. |
| `SOCKET_SIGNAL_EPS` | `30` | Sustained `signal` events per socket per second. |
| `SOCKET_SIGNAL_BURST` | `200` | Burst capacity for trickled ICE candidates (Day 10: a ~20-user mutually-near cluster sends ~20×(1 SDP+7 candidates)=160 signals per socket; 200 covers it, refill adds 15 more in 500 ms). |
| `MAX_PEERS_PER_USER` | `8` | Day 13 symmetric degree cap for both endpoints of a new edge; `0` = unlimited (Day 12 behaviour). |
| `PEER_DISCONNECT_RADIUS_PX` | `radius + 15` (`115`) | Day 13 drop radius (hysteresis). Valid `radius … 3 × radius`; equal to the radius = Day 12 behaviour. |

### Tests

`node --test server/test/peerGraph.unit.test.js server/test/peerGraph.integration.test.js server/test/signal.validation.test.js server/test/iceServers.test.js`
(real Socket.IO clients and a real isolated MongoDB database for the
integration file). The root `npm test` runs these with both existing suites.
The integration tests cover 99/100/101 px, duplicate-free range changes,
offer/answer/candidate relay and every refusal path, disconnect/expiry/kill,
reconnect, the A–B–C chain, and a 50-user random-movement stress run whose
p50/p95 recompute timing is printed.

**Not included:** client WebRTC/audio (`getUserMedia`, `RTCPeerConnection`, Web
Audio), Redis/multi-instance sharing, TURN, obstacle occlusion, the spatial
audit endpoint, Express serving `client/dist`, Docker and any new library.

## Week 2 — Day 9: WebRTC audio

Client-only slice: two browsers in the same room establish a standard WebRTC
**audio** connection through the Day 8 signaling server, with browser built-ins
only — `getUserMedia`, `RTCPeerConnection`, `HTMLAudioElement`. No Web Audio, no
TURN, no new library, and **no server change**. Implementation:
`client/src/webrtc/`, `client/src/hooks/useSocket.js`, `JoinScreen.jsx`,
`AudioStatus.jsx`. Full details, test matrix and verification:
[docs/DAY9.md](docs/DAY9.md).

### Client event flow

```
Join click (user gesture)
  └─ getUserMedia({ audio: {echoCancellation, noiseSuppression, autoGainControl},
                    video: false })          → mic on  |  typed failure → listen only
  └─ emit join { roomId, name }
       └─ joined { selfId, room, users, iceServers }   ← fallback ICE list

server edge: peer:connect { peerId, name, initiator, generation, iceServers }
  └─ create RTCPeerConnection({ iceServers: event.iceServers ?? joined.iceServers })
       ├─ mic on        → pc.addTrack(localAudioTrack)
       │  listen only   → pc.addTransceiver('audio', { direction: 'recvonly' })
       ├─ initiator     → createOffer → setLocalDescription
       │                   → emit signal { to, generation, data: { type: 'offer', sdp } }
       └─ !initiator    → wait for the offer

signal { from, generation, data }
  ├─ offer     → setRemoteDescription → flush queued candidates
  │              → createAnswer → setLocalDescription
  │              → emit signal { to, generation, data: { type: 'answer', sdp } }
  ├─ answer    → setRemoteDescription → flush queued candidates
  └─ candidate → before the remote SDP: queue (flushed in arrival order after it)
                 after:  pc.addIceCandidate
  local ICE    → pc.onicecandidate → emit signal { to, generation, candidate } (trickled)

pc.ontrack → one <audio autoplay playsinline> per peer in the hidden
             .remote-audio container (plain playback — no Web Audio on Day 9)

teardown (peer:disconnect | connection failed/closed | socket disconnect |
          reconnect | session_expired | re-join | unmount)
  └─ close pc → remove the audio element → drop the registry entry
     → stop stats timers → stop every local track (closeAll leaves nothing behind)
```

Every edge is keyed by `peerId` **and** its `generation`: stale signals and
stale `peer:disconnect` events are ignored, a newer `generation` closes the old
connection first (never two connections for one peer), ICE candidates that beat
the remote description are queued and replayed in order, and a failed
connection is cleaned up with **no auto-retry** — the server re-creates edges
through `peer:connect`.

### Modules

| File | What it does |
| --- | --- |
| `client/src/webrtc/localMedia.js` | `getUserMedia` with the mandated constraints; typed failures (`permission_denied`, `no_device`, `insecure_context`); `release()` stops every track. |
| `client/src/webrtc/peerManager.js` | One `RTCPeerConnection` per edge; offer/answer, ICE trickle + queueing, generation rules, cleanup. Dependency-injected (pc factory, socket, logger, media, audio sink, stats) and unit-tested with fakes. |
| `client/src/webrtc/remoteAudio.js` | One `<audio autoplay playsinline>` per remote stream in a hidden container; removed on close. No gain, no panning (Week 3–4). |
| `client/src/webrtc/rtcStats.js` | ~1 s `getStats()` poll per peer: `connectionState` + inbound audio `bytesReceived` — the proof that audio flows. |
| `client/src/components/AudioStatus.jsx` | Read-only overlay: mic on/off/listen-only, and per peer the name, connection state and received bytes, refreshed at most once per second. |

The Join button (a user gesture) asks for the microphone **before** emitting
`join`; a denial or a missing device shows a clear message and the join
continues in **listen only** mode (still hearing others). The choice itself is
one dropdown on the Join screen: *Join with mic / Listen only*.

### Testing with two browser windows (headphones mandatory)

1. `npm run seed` once (rooms `lobby`/`studio`/`lounge`), `npm run dev:server`,
   then `npm run dev:client` — open the printed URL in **two** windows.
2. **Put on headphones.** Two open microphones next to each other create a
   feedback howl that has nothing to do with the code.
3. Join the same room with different names, one as *Join with mic*, the other
   as *Listen only* or also with mic.
4. Walk the two avatars within the earshot radius (default 100 px). Within a
   second or two the overlay row appears: `connected`, and `bytesReceived`
   starts **climbing** — that climb is the Audio Check. Walk apart again and
   the row disappears (the server removed the edge).
5. Repeat with both windows on mic: each side should hear the other (check the
   OS volume mixer if not).

### Testing without microphones (Chrome fake devices)

Chrome flags replace the hardware and the permission prompt entirely:

```
google-chrome --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
```

Open two windows of the dev client (or two different browser profiles).
`getUserMedia` then "succeeds" with a fake tone, so the whole offer/answer/ICE
path runs exactly as with real hardware — the overlay shows `connected` and
climbing `bytesReceived` in both windows.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Microphone permission was denied…" | The browser blocked the mic: open the padlock → Site settings → Microphone → Allow, and join again. Until then you are in listen-only mode and still hear others. |
| Overlay stuck on `connecting`, no bytes | The ICE handshake did not finish — see the STUN-only note below, and check that both tabs really are in the same room. |
| No audio, but bytes climb | The connection works and the *playback* is muted: check the tab/OS volume, and remember one side must have joined **with mic** — listen-only rows can still climb on their side. |
| Bytes climb but silence | Click the page once (browser autoplay policy) — browsers block audio playback until a user gesture; then check tab/OS volume. |
| "The microphone needs a secure page…" | `getUserMedia` needs https or `localhost`. Off localhost, serve the client over https (or a tunnel) — plain http on a LAN IP can never get a mic. |
| Connected on localhost, fails across networks | The default is STUN-only (`stun:stun.l.google.com:19302`). Strict NATs/firewalls need a TURN relay, which is a later deployment concern — on one machine/LAN, STUN is enough. |
| Two laptops + open speakers → howl | Use headphones. Echo cancellation helps, but open mics beside open speakers will always feed back eventually. |

### Signal rate limit (server, unchanged)

Day 9 raised no server limit (100 covered 10 peers). **Day 10** raises the
default to `SOCKET_SIGNAL_BURST=200` (refill unchanged at
`SOCKET_SIGNAL_EPS=30`/s): a cluster of ~20 mutually-near users sends, per
socket, ~20 edges × (1 SDP + 7 candidates) = 160 signals in a pessimistic
count (real browsers send 3–5 per edge), which now fits inside the burst
capacity alone; with refill the 500 ms budget is 200 + 15 = 215.
`server/test/signal.ratelimit.headroom.test.js` replays that 20-peer burst
(0 dropped) and re-proves the flood guard still bites.

**Day 9 scope snapshot (before later days):** Web Audio of any kind (GainNode
proximity attenuation, StereoPanner, volume drop-off), mute buttons or other
extra UI, TURN servers, Redis, obstacle occlusion, the spatial-audit endpoint,
Express serving `client/dist`, Docker, TypeScript, any new library, and changes
to existing server behavior were not included in Day 9.

## Day 10 — Mid-Project Review readiness

- **Fast clustering:** `computeClusters` = one lean roster query + in-memory
  spatial grid (cell = radius) + exact pixel check + union-find. The old
  `$near`-per-user algorithm is `computeClustersViaNear`, a test/audit
  cross-check only. Design note: see the Day 7 section above.
- **Spatial Audit:** `npm run audit` or
  `curl "http://localhost:4000/api/spatial-audit?users=50&samples=25&seed=1"`
  (guarded by `AUDIT_ENABLED` — default on outside production, off in
  production; users ≤ 500, samples ≤ 100, one run at a time, no caller roomId).
  Synthetic throwaway `audit-*` room, planted 99/100/101 px edge cases,
  brute-force comparison, `performance.now()` p50/p95/max, 2dsphere explain
  check, `finally` cleanup, PASS only on 0 mismatches and p95 ≤
  `AUDIT_TARGET_MS` (default 20). Timings are reported exactly as measured.
- **Signal burst:** `SOCKET_SIGNAL_BURST` default raised 100 → 200 (see the
  Day 9 signal section above for the 20-peer arithmetic).
- Docs: [docs/REQUIREMENTS_TRACE.md](docs/REQUIREMENTS_TRACE.md) ·
  [docs/DEMO_MIDREVIEW.md](docs/DEMO_MIDREVIEW.md) ·
  [docs/DAY7.md](docs/DAY7.md) · [docs/DAY8.md](docs/DAY8.md) ·
  [docs/DAY9.md](docs/DAY9.md) · [docs/WEEK1.md](docs/WEEK1.md) ·
  [docs/DEMO_WEEK1.md](docs/DEMO_WEEK1.md)

**Day 10 scope snapshot (before Day 11):** Distance attenuation had not yet
been implemented; Day 11 adds GainNode attenuation. Stereo panning and obstacle
occlusion remain Week 4; Redis Pub/Sub and mesh optimization are planned for
Days 12 and 13 and are not started. TURN, deployment configs, Express serving
`client/dist`, TypeScript and new dependencies remain out of scope.

## Day 11: Dynamic attenuation

Remote WebRTC tracks now pass through the browser's Web Audio API. The server
includes `proximityRadiusPx` in `joined` from its configured
`PROXIMITY_RADIUS_PX` (default 100 px); the client uses it as the silence radius
and falls back to 100 px only when talking to an older server. Full volume is
maintained through 30 px, then smoothstep fades to zero at the outer radius.
For the default radius, the curve is:

```text
Distance (px) | Gain
--------------+------
           0  | 100%
          30  | 100%
        47.5  |  84%
          65  |  50%
        82.5  |  16%
         100  |   0%
         >100 |   0%
```

The gain is `1 - (3t² - 2t³)`, `t=(distance-30)/(outer-30)` between the two
radii; the zero slope at both ends avoids an audible step.

```text
remote MediaStream ──┬── muted hidden <audio autoplay playsinline> (Chrome quirk)
                     └── MediaStreamAudioSourceNode → GainNode → destination
                                                               ↑
                                                distance-derived target gain
```

Chrome may not deliver remote WebRTC audio through Web Audio unless the same
stream is also attached to an `HTMLMediaElement`. That hidden element remains
attached but `muted = true`, so only the Web Audio chain is audible (no double
playback). One `AudioContext` is shared; each peer starts with a zero-gain node.
The Join click creates/resumes the context as a user gesture; a suspended context
is retried on Join and when the tab becomes visible. Gains are smoothed with
`setTargetAtTime(..., 0.05)`, updated at most 20 Hz from the existing canvas
render loop. No extra animation loop or per-frame React updates were added.

**Two-window check:** Start MongoDB, seed the existing room data, then start
the server and client using the Day 4 setup above. Open two browser windows, join
the same room with different names, allow mic access or choose Listen only, and
use headphones. Walk within 30 px for full volume; walk away and confirm the
status overlay's distance (px) and gain (%) update while the sound fades
smoothly to silence at the displayed server radius; walk closer and confirm it
returns. For Chrome without physical microphones, launch two profiles with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (use
`--user-data-dir=/tmp/proxispeak-a` and `/tmp/proxispeak-b` respectively).
The optional `--autoplay-policy=no-user-gesture-required` is only for isolating
autoplay problems; omit it for the normal Join gesture test.

**Troubleshooting:** If inbound bytes climb but there is silence, the hidden
element being muted is expected: check its remote `srcObject`, the AudioContext
`running` state, the overlay gain, and that the GainNode has connected to the
destination after its first position update. If the context is suspended, click
Join and return the tab to the foreground; browser autoplay policy may still
require a user gesture. If audio is too loud outside the expected radius, check
`joined.proximityRadiusPx` against server `PROXIMITY_RADIUS_PX`.

Implementation and exact manual steps: [docs/DAY11.md](docs/DAY11.md). Unit
coverage: `node --test client/test/audio.attenuation.test.js client/test/audio.audioMixer.test.js`.
Real two-browser audio is not verifiable by Node tests. Stereo panning and
left/right ear logic, plus obstacle occlusion, are Week 4—not Day 11.

## Day 12: Multi-instance Redis scaling

Backend-only horizontal scaling slice (`client/` untouched): when `REDIS_URL`
(`redis://` or `rediss://`) is set, multiple ProxiSpeak Node.js instances attach
`@socket.io/redis-adapter` for room/socket event fan-out and share active peer
edges through `RedisEdgeStore` (atomic Lua `createEdge`, `removeEdge`, and
`removeUser` with monotonic per-pair `INCR` generations). Leaving `REDIS_URL`
empty keeps single-instance `MemoryEdgeStore` behavior with zero network
round-trips; an unreachable `REDIS_URL` at boot logs one redacted warning and
falls back cleanly to `scaleMode: "single"`.

- **Health surface:** `GET /health` adds `instanceId` and `scaleMode`
  (`"single" | "redis" | "redis-degraded"`) from cached state with zero DB or
  Redis I/O.
- **Sweeps & crash recovery:** Periodic `cleanupStale` claims expired rows
  atomically across instances and closes remote sockets' raw transports via
  `io.serverSideEmit` so client auto-reconnect + session recovery trigger cleanly;
  `sweepOrphanEdges` uses cursor `SCAN` (never `KEYS`) on boot and every
  `EDGE_SWEEP_INTERVAL_MS` to purge `kill -9` orphans; mid-run Redis recovery
  runs `PeerGraph.reconcileLocalUsers()`.
- **Verification & docs:** Architecture diagram, full Redis key table, failure
  modes, sticky-session notes, local two-instance commands, and measured 50-user
  latency benchmarks are in [docs/REDIS_SCALING.md](docs/REDIS_SCALING.md). Run
  `REDIS_URL_TEST="redis://127.0.0.1:6379" npm test` and
  `npm run scale-check -- --urlA=http://127.0.0.1:3001 --urlB=http://127.0.0.1:3002`.
  **Mesh optimization is Day 13 scope — see the Day 13 section below.**


## Day 13: Mesh optimization

The WebRTC mesh is now bounded and stable. `MAX_PEERS_PER_USER` (default `8`,
`0` = unlimited) caps the degree of **both** endpoints of every new edge; the
check runs inside the store's atomic create (two `Set.size` reads in
`MemoryEdgeStore`, two `SCARD`s inside the existing `CREATE_EDGE_LUA` for
`RedisEdgeStore`), so two instances can never both take a hub's last slot and a
refused pair reports `capped` and stays silent. `PROXIMITY_RADIUS_PX` remains the
**connect** radius (offers/answers are still only initiated at ≤ 100 px), while
the new `PEER_DISCONNECT_RADIUS_PX` (default `115`, valid `radius … 3 × radius`)
is the **drop** radius: an existing edge survives until the distance exceeds it.
That 100–115 px band is silent anyway because the Day 11 gain curve reaches 0 at
100 px.

Candidates are processed nearest-first with user-id tie-breaking, so results are
reproducible; existing edges are never evicted for a closer newcomer (documented
limitation), and a removal triggers at most one extra sync per endpoint so freed
slots are refilled without cascades. The client overlay now shows
`connected N / max` and, when applicable, `M nearby, not connected (cap)` — both
fed by the `joined` payload's new `maxPeers` / `peerDisconnectRadiusPx` fields and
the existing world positions (still no extra protocol or React state).

```bash
# self-contained run: two throwaway instances + real Redis, no MongoDB needed
REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check
# against running servers instead:
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
```

Measured on a tight 50-user cluster: **1225 edges before → 190 after** (−84.5%),
worst browser **49 → 8** connections, and **0** connect/disconnect churn for 100
boundary crossings with hysteresis (versus 100 disconnects with the drop radius
equal to the connect radius). The full policy, numbers, failure modes and the
four-window manual test are in
[docs/MESH_OPTIMIZATION.md](docs/MESH_OPTIMIZATION.md). Redis key space is
unchanged (degree comes from the existing `user-edges` sets); see
[docs/REDIS_SCALING.md](docs/REDIS_SCALING.md).

**Not in Day 13:** stereo panning, obstacle occlusion, room persistence, an
SFU/MCU or any media server, TURN, Express serving `client/dist`, deploy configs,
TypeScript and any new dependency.
