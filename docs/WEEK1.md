# ProxiSpeak — Week 1 reference

Week 1 builds the foundation every later week stands on: one Node process that
owns the MongoDB geospatial schema, one realtime channel that broadcasts avatar
pixels, and one browser client that draws the room and lets you walk around in
it. **No audio, no proximity queries, no Redis yet** — those are Weeks 2–4.

---

## 1. Deliverables mapped to files

### Backend — WebSocket server that broadcasts avatar X/Y

| Deliverable (Week 1 brief) | Where it lives | How it works |
| --- | --- | --- |
| WebSocket server | `server/src/sockets/index.js`, attached in `server/src/index.js` | Socket.io is attached to the **same** `http.Server` Express uses, so there is one port (4000) for HTTP and the websocket |
| Join a room | `join` handler (`sockets/index.js`) + `services/roomService.js` | Payload validated, room looked up in MongoDB (rooms are never created implicitly), spawn chosen, presence written, socket joins the room channel, snapshot returned |
| Broadcast avatar X/Y | `move` handler → `socket.to(roomId).emit('user:moved', { id, x, y })` | Room-scoped fan-out, never back to the mover, never into another room |
| Leave / disconnect | `releaseSession()` + `disconnect` handler | `user:left` to the room, leave the channel, delete **this socket's own** presence row |
| Payload validation | `server/src/sockets/validation.js`, `server/src/utils/validate.js` | Pure functions: types, ranges, name/room patterns, bounds clamp, per-event step cap |
| Rate limiting | `server/src/utils/rateLimiter.js` | One token bucket per socket (`SOCKET_MOVE_EPS`, default 30 events/s); over the limit moves are dropped silently, never amplified with an error |
| Boot / shutdown | `server/src/index.js`, `server/src/utils/httpServer.js` | Connect MongoDB → ensure indexes → listen → on `SIGINT`/`SIGTERM`: close socket, drain in-flight presence cleanups, close HTTP, disconnect MongoDB |

### Backend — basic MongoDB geospatial schema

| Deliverable | Where it lives | How it works |
| --- | --- | --- |
| Presence documents | `server/src/models/UserPresence.js` | One row per connected avatar: pixels **and** the projected GeoJSON point |
| `2dsphere` index | `UserPresence.location` (`ensureIndexes()` in `server/src/db/mongo.js`) | Created on boot and by `npm run seed`; it is what `$near` / `$geoWithin` will use in Week 2 |
| Room blueprints | `server/src/models/Room.js`, `server/src/services/roomService.js` | Pixel dimensions, obstacles (`blocksAudio`, `attenuation`) and spawn points as data |
| Projection (1 px = 0.1 m) | `server/src/utils/geo.js` | Pixel plane ⇄ `[longitude, latitude]`, plus `$centerSphere` / `$maxDistance` helpers for Week 2 |
| Position writes | `server/src/services/presenceStore.js` | `upsertPosition()` (filter = unique `sessionId + roomId`), `removeUser()`, `listPresenceByRoom()` |
| Seed | `server/scripts/seed.js` | Idempotent: index + `lobby`, `studio`, `lounge` |
| Health | `server/src/app.js` | `GET /health` — deliberately dependency-free |

### Frontend — React Canvas world, movement, broadcasting

| Deliverable | Where it lives | How it works |
| --- | --- | --- |
| React client | `client/src/main.jsx`, `client/src/App.jsx`, `client/vite.config.js` | Vite + React 18, dev proxy for `/socket.io` and `/api`, server URL resolved in `client/src/config.js` only |
| Canvas world rendering | `client/src/canvas/renderer.js`, `client/src/components/WorldCanvas.jsx`, `client/src/canvas/coords.js` | Letterboxed 1920×1080 floor, grid, obstacles coloured by type, avatars with names; one `requestAnimationFrame` loop, devicePixelRatio-aware, re-fitted on resize |
| World state (no re-renders per frame) | `client/src/realtime/worldState.js`, `client/src/hooks/useSocket.js` | Room + avatars live in a mutable ref the render loop reads directly; React state only for connection status, errors and the join summary |
| Smooth keyboard movement | `client/src/movement/movement.js`, `client/src/movement/controller.js`, `client/src/hooks/useMovement.js` | Delta-time steps (300 px/s), normalised diagonals, bounds clamp, frame-delta cap for hidden tabs, held keys cleared on window blur |
| Mouse movement (click-to-move) | `client/src/movement/controller.js` (`handleWorldClick`), `client/src/components/WorldCanvas.jsx` | Screen → world via `coords.js`, target clamped into the room, arrival lands exactly on the point, any key press cancels |
| Coordinate broadcasting | `client/src/movement/throttle.js`, `client/src/hooks/useSocket.js` | `move { x, y }` at most 10 ×/s, only when the position changed, plus the exact resting position after a stop |
| Remote avatar smoothing | `client/src/movement/movement.js` (`interpolateToward`) | `1 − exp(−12·dt)` glide toward the last reported position, snap beyond 200 px (reconnect) |
| Join screen + messages | `client/src/components/JoinScreen.jsx`, `client/src/join/joinForm.js` | Local validation before any round trip; server and connection errors rendered as sentences |
| Connection UX | `client/src/realtime/connectionStatus.js`, `client/src/App.jsx` | `idle → connecting → joined`, `disconnected` (Socket.io reconnecting) and `error` states; HUD reports a lost connection and server rejections |

---

## 2. Socket.io event table

Every inbound payload is validated server-side before any database work. `C→S`
is client to server, `S→C` is server to client. Nobody receives an event from a
room they are not in.

| Event | Dir | Payload | Notes |
| --- | --- | --- | --- |
| `join` | C→S | `{ roomId: string, name: string }` | `roomId` 1–48 chars of `a-z 0-9 - _` (lowercased); `name` 1–24 chars, trimmed, control characters refused |
| `joined` | S→C | `{ selfId, room: { roomId, name, width, height, obstacles[] }, users: [{ id, name, x, y }] }` | Reply to the joining socket only. `users` is the room as it stands, including the newcomer (`selfId`). `obstacles` are data only (Week 1 has no collision/occlusion) |
| `user:joined` | S→C | `{ id, name, x, y }` | To the rest of the room, once per successful join |
| `move` | C→S | `{ x: number, y: number }` | Finite numbers only; coordinates are clamped into the room and one event may travel at most `SOCKET_MAX_STEP_PX` (120 px) |
| `user:moved` | S→C | `{ id, x, y }` | Same room, excluding the mover |
| `user:left` | S→C | `{ id }` | Same room, after the presence row was deleted |
| `error` | S→C | `{ code, message, field? }` | Rejections; the connection stays open |

Server `error` codes:

| Code | Meaning |
| --- | --- |
| `invalid_payload` | Malformed payload (`field` names the offending property) |
| `room_not_found` | `join` for a room that does not exist — run `npm run seed` |
| `not_joined` | `move` before a successful join |
| `already_joined` | One socket owns one room; switching needs a reconnect |
| `server_error` | Unexpected failure; the cause is logged server-side, never disclosed |

Client-synthesised error codes (shown by the join screen and the HUD, never sent
over the wire): `connection_failed` (handshake failed) and `connection_lost`
(the connection dropped before the join was acknowledged).

### Sequence: join, move, leave

```
  client A                server                     MongoDB
     |  join{lobby,Ada} ----> |                          |
     |                        | getRoom(lobby) --------->|
     |                        | listPresenceByRoom ----->|
     |                        | upsertPosition(Ada) ---->|   (1 row per connection)
     |                        | socket.join(lobby)       |
     |  <---- joined{...} ----|  (selfId, room, users)   |
     |                        |----> user:joined(Ada) -->|  peers in the room
     |  move{x,y} ----------> | validate + clamp + cap   |
     |                        | upsertPosition ---------->|
     |  <-- (nothing back) ---|----> user:moved --------->|  peers gliding
     |  (disconnect)          | user:left + delete row ->|
```

---

## 3. Data model

### `UserPresence` — one document per connected avatar

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | String, required | The Socket.io connection id; unique per connection |
| `instanceId` | String, required | Writer of the row (`node-<pid>` by default) |
| `roomId` | String, required | Room this avatar is in |
| `name` | String, required | 1–24 chars after validation, trimmed |
| `color`, `avatar` | String | Wire-friendly presentation fields (`avatar` defaults to `circle`) |
| `x`, `y` | Number, required | Authoritative pixel position on the room plane |
| `angle` | Number | Reserved for the client's facing direction (always 0 in Week 1) |
| `location` | GeoJSON `Point` | `{ type: 'Point', coordinates: [longitude, latitude] }`, projected from `x`/`y` |
| `micEnabled` | Boolean | Defaults to `true`; nothing reads it yet (Week 3) |
| `lastSeen`, `createdAt`, `updatedAt` | Date | Written on every accepted move |

Indexes: `_id_`, `location_2dsphere` (**the geospatial engine's index**),
`sessionId_1_roomId_1` (unique — the upsert target), `roomId_1_lastSeen_-1`
(room listing and future stale sweeps), plus the single-field `sessionId` and
`roomId` indexes.

### `Room` — a persisted office

| Field | Type | Notes |
| --- | --- | --- |
| `roomId` | String, required, unique | Lowercased, trimmed channel/database key |
| `name`, `description` | String | Shown in the client (`Lobby`, `Studio`, `Lounge`) |
| `width`, `height` | Number, required | Pixel plane size (default 1920 × 1080), minimum 200 |
| `obstacles[]` | Sub-documents | `{ id, type: wall|desk|plant|pillar|screen, x, y, w, h, blocksAudio, attenuation }` — drawn by the client, ready for occlusion |
| `spawnPoints[]` | `{ x, y }[]` | 24 generated points; a newcomer spawns at the one furthest from the users already inside |

### The projection: 1 px = 0.1 m

MongoDB geospatial indexes only understand `[longitude, latitude]`, while the
world is a flat pixel plane. The pixel plane is therefore mapped onto a ~192 m ×
108 m patch of the globe (`PIXELS_PER_METER = 10`, centre `WORLD_CENTER_LAT/LON`,
default San Francisco):

```
  1 pixel            = 1 / PIXELS_PER_METER metres = 0.1 m
  100 px of earshot  = 10 m to MongoDB

  longitude = centerLon + (x - width  / 2) * (metersPerPixel / (R * cos(centerLat))) / DEG
  latitude  = centerLat - (y - height / 2) * (metersPerPixel / R)                  / DEG
```

`+y` grows downward on screen and north on the globe, the tangent-plane error
over a patch this small is far below a centimetre, and `geo.js` also exposes the
`$centerSphere` radius (radians) and `$maxDistance` (metres) forms the Week 2
queries will use. Round-tripping pixel → GeoJSON → pixel is unit-tested.

---

## 4. Architecture overview

```
                browser tab (React 18 + Vite)                 another tab
   ┌────────────────────────────────────────────────────┐   ┌──────────────┐
   │ main.jsx → App.jsx                                 │   │  same client │
   │   ├─ components/JoinScreen   (join/joinForm rules) │   │              │
   │   ├─ hooks/useSocket ──────────┐                   │   │              │
   │   │     realtime/worldState    │  (ref: room +     │   │              │
   │   │     realtime/connectionStatus │  avatars)      │   │              │
   │   ├─ hooks/useMovement ────┐   │                   │   │              │
   │   │     movement/*.js      │   │                   │   │              │
   │   └─ components/WorldCanvas│   │                   │   │              │
   │         canvas/renderer ←──┘   │                   │   │              │
   │         canvas/coords          │ 1 rAF loop        │   │              │
   └─────────────────────────────── │ ──────────────────┘   └──────┬───────┘
                                    │ socket.io (WebSocket, same port)
                                    ▼
                    ┌───────────────────────────────┐
                    │ server/src/index.js           │  boot + shutdown
                    │  ├─ app.js  (GET /health)     │  HTTP
                    │  └─ sockets/index.js          │  realtime gateway
                    │        sockets/validation.js  │  pure payload rules
                    │        utils/rateLimiter.js   │  30 events/s per socket
                    │        services/roomService   │  room lookup + cache
                    │        services/presenceStore │  upsert / delete
                    │        utils/geo.js           │  1 px = 0.1 m
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │ MongoDB  (mongoose)           │
                    │   userpresences               │
                    │     location: 2dsphere ◄──────┼── $near / $geoWithin
                    │   rooms                       │   (Week 2)
                    └───────────────────────────────┘
```

Week 1 deliberately has **no** Redis adapter, no WebRTC signalling, no audio
graph, no proximity queries and no collision — later weeks plug into the same
gateway and schema.

---

## 5. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/proxispeak` | Local or Atlas connection string (`MONGO_URI_TEST` for tests) |
| `CLIENT_URL` | *(empty)* | Allowed browser origins for the socket and the API. Empty = same-origin only for the socket; `*` = any; a comma-separated list = allow-list |
| `WORLD_WIDTH` / `WORLD_HEIGHT` | `1920` / `1080` | Pixel plane the projection is built on |
| `WORLD_CENTER_LAT` / `WORLD_CENTER_LON` | `37.7749` / `-122.4194` | Tangent-plane centre |
| `PIXELS_PER_METER` | `10` | 1 px = 0.1 m |
| `SOCKET_MOVE_EPS` | `30` | Accepted `move` events per socket per second |
| `SOCKET_MAX_STEP_PX` | `120` | Largest distance one accepted `move` may travel |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `INSTANCE_ID` | `node-<pid>` | Written into presence rows |

---

## 6. How Week 1 is verified

```bash
npm test                       # server suite, then client suite
npm run test:server            # node --test: unit + Socket.io integration
npm run test:client            # node --test: no browser needed
npm run build --prefix client   # production build
```

* Client tests are complete without a database: movement, canvas maths,
  renderer, world state, connection status, join form, config resolution.
* Server tests split into database-free units (projection, validation, rate
  limiter, CORS policy, connection bookkeeping, HTTP surface, listen errors) and
  Socket.io integration tests that create their own throwaway database
  (`proxispeak_day3_test_<pid>_<ts>`), seeded rooms and two real clients.
  **Those integration tests report themselves as skipped with a `NOT VERIFIED`
  banner when no MongoDB is reachable — a green run is only complete with
  `skipped 0`.**
* The interactive two-tab demo cannot be automated; `docs/DEMO_WEEK1.md` scripts
  it by hand and records which steps were executed on which machine.
