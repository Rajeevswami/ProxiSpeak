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

* **Backend** — Node.js, Express, Socket.io, MongoDB (`$near` / `$geoWithin` /
  `$geoNear`, `2dsphere`), Redis Pub/Sub (`@socket.io/redis-adapter` + a
  domain-event channel).
* **Frontend** — React, HTML5 Canvas API, WebRTC (`getUserMedia`), Web Audio API.

No other libraries. No TURN. No UI kit, no state-management library, no extra
database.

## Key modules

| Module | What it does | Status |
| --- | --- | --- |
| `server/` — Express app | Health endpoint, JSON API surface, config + logger | **Day 1 — done** |
| Geospatial engine | MongoDB `2dsphere` queries (`$near`, `$geoWithin`) mapped onto the 2D world plane | Week 1–2 |
| Presence & signaling | Socket.io gateway, presence lifecycle, Redis Pub/Sub for multi-instance scaling | Week 2 |
| Voice mesh | WebRTC peer connections with mesh hygiene (renegotiation, ICE restarts) | Week 3 |
| Spatial audio | Web Audio API crossfade, proximity gain and wall occlusion | Week 3 |
| Client | React + Canvas live map, avatar movement, audio UI | Week 3–4 |

## Week-wise plan

| Week | Focus | Deliverables | Review |
| --- | --- | --- | --- |
| **Week 1** | Foundations & data layer | Project setup (Day 1), MongoDB connection, `UserPresence` / `Room` schemas with `2dsphere` index, seed script, health endpoint | Week 1 review: server boots green, geo data seeds and queries |
| **Week 2** | Real-time presence & proximity | Socket.io gateway, Redis Pub/Sub adapter, presence lifecycle, earshot queries on the world plane | Week 2 review: presence flows, proximity queries stay inside the latency budget |
| **Week 3** | Voice mesh & spatial audio | WebRTC signaling, peer graph hygiene, Web Audio proximity crossfade and occlusion | Week 3 review: audio opens/closes by distance, mute/occlusion works |
| **Week 4** | Client & hardening | Full React/Canvas client, movement + audio UX, load testing, production hardening | Final review: end-to-end multi-user demo |

## Week 1 — what is done (Day 1–6)

A complete two-user slice of ProxiSpeak with **no audio yet**: you join a room
from the browser, see the room and everyone in it on a canvas map, walk around
with the keyboard or the mouse, and every other tab sees your avatar move.

### Tech stack (Week 1)

| Layer | Used in Week 1 | Later weeks |
| --- | --- | --- |
| Backend | Node.js, Express (health + JSON API), Socket.io, MongoDB via Mongoose (`2dsphere`) | Redis Pub/Sub adapter (Week 2) |
| Frontend | React 18 + Vite, HTML5 Canvas 2D, `socket.io-client` | WebRTC (`getUserMedia`), Web Audio API (Week 3) |
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

### Known limitations / coming in Week 2–4

* **No audio yet.** WebRTC, `getUserMedia` and the Web Audio proximity crossfade
  are Week 3; nothing asks for microphone permission in Week 1.
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
* **Single instance.** Redis Pub/Sub and multi-instance rooms are Week 2; rooms
  live in one process.
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
| `joined` | S→C | `{ selfId, room: { roomId, name, width, height, obstacles[] }, users: [{ id, name, x, y }] }` | Reply to the joining socket only. `users` is the room as it currently stands, **including** the newcomer (identified by `selfId`). `obstacles` are data only (`id`, `type`, `x`, `y`, `w`, `h`, `blocksAudio`, `attenuation`) — Day 3 ships no collision or occlusion logic. |
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

