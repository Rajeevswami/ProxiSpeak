# Week 2 — Real-time Presence, Proximity & P2P Audio

Week 2 delivers the proximity mesh and WebRTC audio: the server computes who is within earshot of whom, creates peer edges only for pairs within the connect radius, and the browser opens WebRTC connections with distance-based volume attenuation.

## Deliverables

### Day 7 — Proximity queries and live presence

* **MongoDB `$near` queries** — `proximityService.findNearby` uses `$near` with `$maxDistance` on the `2dsphere` index to find neighbors within a radius.
* **Presence lifecycle** — `join` → `move` → `disconnect` with atomic upserts, rate-limited moves (token bucket, 30/s per socket), and presence cleanup sweeps.
* **Room-scoped broadcasts** — `user:joined`, `user:moved`, `user:left` sent only to sockets in the same room.

**Files:** `server/src/services/proximityService.js`, `server/src/services/presenceStore.js`, `server/src/sockets/index.js`, `server/src/sockets/validation.js`
**Tests:** `server/test/proximity.test.js`, `server/test/proximity.validation.test.js`, `server/test/proximity.roster.test.js`, `server/test/socket.integration.test.js`, `server/test/socket.validation.test.js`

### Day 8 — Peer graph and WebRTC signaling

* **In-process peer graph** — `PeerGraph` tracks which users are registered in which rooms, queries neighbors via `findNearby`, and creates/removes edges atomically.
* **Socket.io signaling events** — `peer:connect` (offer/answer initiation), `peer:disconnect` (edge removed), `signal` (SDP/ICE relay). The server relays signaling only along live edges validated by the `EdgeStore`.
* **WebRTC peer manager** — `client/src/webrtc/peerManager.js` creates `RTCPeerConnection` per edge, handles offer/answer, ICE trickling, and connection state.

**Files:** `server/src/services/peerGraph.js`, `server/src/services/edgeStore.js`, `server/src/sockets/index.js`, `client/src/webrtc/peerManager.js`, `client/src/webrtc/remoteAudio.js`
**Tests:** `server/test/peerGraph.unit.test.js`, `server/test/peerGraph.integration.test.js`, `server/test/signal.validation.test.js`, `client/test/webrtc.peerManager.test.js`

### Day 9 — getUserMedia P2P audio

* **Local media capture** — `createLocalMedia` acquires the microphone via `getUserMedia` with graceful fallback (listen-only mode).
* **Remote audio playback** — each peer's `MediaStream` is attached to a hidden `<audio>` element (Chrome quirk) and routed through the `AudioMixer`.
* **Audio status overlay** — `AudioStatus` component shows connected peers, connection state, inbound bytes, mic status.

**Files:** `client/src/webrtc/localMedia.js`, `client/src/webrtc/remoteAudio.js`, `client/src/components/AudioStatus.jsx`, `client/src/hooks/useSocket.js`
**Tests:** `client/test/webrtc.localMedia.test.js`, `client/test/webrtc.remoteAudio.test.js`

### Day 10 — Mid-Project Review (spatial audit)

* **Spatial audit endpoint** — `GET /api/spatial-audit` runs a synthetic workload (50 users, 25 samples) and reports p50/p95/max latency. Guarded by `AUDIT_ENABLED` (default on outside production, off in production).
* **Fast clustering** — `computeClusters` uses a spatial grid + union-find instead of per-user `$near` queries.
* **Signal burst headroom** — `SOCKET_SIGNAL_BURST` raised to 200 to accommodate ~20 mutually-near peers.

**Files:** `server/src/services/spatialAudit.js`, `server/src/app.js`, `server/scripts/audit.js`
**Tests:** `server/test/spatialAudit.test.js`, `server/test/signal.ratelimit.headroom.test.js`

## Socket.io Event Table

### Client → Server

| Event | Payload | Description |
| --- | --- | --- |
| `join` | `{ roomId: string, name: string }` | Join a room; server responds with `joined` |
| `move` | `{ x: number, y: number }` | Move avatar; server broadcasts `user:moved` and re-syncs peer graph |
| `signal` | `{ to: string, generation: number, data: object }` | Relay WebRTC signaling (SDP/ICE) to peer `to` along live edge |

### Server → Client

| Event | Payload | Description |
| --- | --- | --- |
| `joined` | `{ selfId, room, users, iceServers, proximityRadiusPx, maxPeers, peerDisconnectRadiusPx }` | Join acknowledgment with room blueprint, current users, ICE servers, mesh config |
| `user:joined` | `{ id: string, name: string, x: number, y: number }` | Another user joined the room |
| `user:moved` | `{ id: string, x: number, y: number }` | Another user moved |
| `user:left` | `{ id: string }` | Another user left the room |
| `peer:connect` | `{ peerId: string, name: string, initiator: boolean, generation: number, iceServers: array }` | New peer edge created; `initiator=true` means this client sends the offer |
| `peer:disconnect` | `{ peerId: string, generation: number }` | Peer edge removed |
| `signal` | `{ from: string, generation: number, data: object }` | WebRTC signaling from peer `from` |
| `error` | `{ code: string, message: string, field?: string }` | Rejection (see error codes below) |

### Error Codes

| Code | Meaning |
| --- | --- |
| `room_not_found` | Room does not exist (run `npm run seed`) |
| `already_joined` | Socket already joined a room; reconnect to join another |
| `not_joined` | Must join before sending `move` or `signal` |
| `session_expired` | Presence expired; reconnect and join again |
| `no_peer_edge` | No live edge to the target peer (moved out of range or edge removed) |
| `stale_generation` | Peer edge has been replaced; use the current generation |
| `invalid_payload` | Payload validation failed (see `field` for which one) |
| `server_error` | Unexpected server error |

## Data Model

### UserPresence (MongoDB)

```javascript
{
  sessionId: String,        // Socket.io socket.id
  roomId: String,           // "lobby" | "studio" | "lounge"
  name: String,             // display name
  color: String,            // avatar color (hex)
  avatar: String,           // "circle"
  x: Number,                // pixel x
  y: Number,                // pixel y
  location: {               // GeoJSON Point (projected from x/y)
    type: "Point",
    coordinates: [lon, lat]
  },
  instanceId: String,       // server instance that owns this socket
  lastSeen: Date            // updated on move + heartbeat
}
// Indexes: { location: "2dsphere" }, { sessionId: 1, roomId: 1 } (unique), { roomId: 1, lastSeen: 1 }
```

### Room (MongoDB)

```javascript
{
  roomId: String,           // "lobby" | "studio" | "lounge"
  name: String,             // display name
  width: Number,            // pixels
  height: Number,           // pixels
  spawnPoints: [{ x, y }],  // spawn locations
  obstacles: [{             // optional rectangles
    id: String,
    type: String,           // "wall" | "building"
    x: Number, y: Number, w: Number, h: Number,
    blocksAudio: Boolean,   // true = audio occlusion (Week 4)
    attenuation: Number     // 0..1 (Week 4)
  }]
}
```

### EdgeStore (Memory or Redis)

**Memory:** in-process `Map<pairToken, PeerEdge>` with monotonic generations.
**Redis:** `<prefix>:edge:<pairToken>` HASH, `<prefix>:gen:<pairToken>` STRING, `<prefix>:user-edges:<userId>` SET, `<prefix>:user-pairs:<userId>` SET. Every key has a bounded TTL (default 3600s). Atomic Lua scripts for `createEdge`, `removeEdge`, `removeUser`.

## Configuration Table

Every environment variable is validated at boot with one clear error line naming the variable (no stack traces, no echoing secrets).

| Name | Default | Meaning | Valid range | Component |
| --- | --- | --- | --- | --- |
| `PORT` | `4000` | HTTP/WebSocket port | 1..65535 | server |
| `HOST` | `0.0.0.0` | Network interface | any | server |
| `NODE_ENV` | `development` | `development` or `production` | enum | server |
| `LOG_LEVEL` | `info` | Minimum log level | `debug`, `info`, `warn`, `error` | server |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/proxispeak` | MongoDB connection string | any | server |
| `MONGO_TIMEOUT_MS` | `8000` | Server selection timeout | ≥ 500 | server |
| `CLIENT_URL` | `http://localhost:5173` | Allowed browser origins (comma-separated) | list or `*` | server |
| `WORLD_WIDTH` | `1920` | Room width in pixels | ≥ 200 | server |
| `WORLD_HEIGHT` | `1080` | Room height in pixels | ≥ 200 | server |
| `WORLD_CENTER_LAT` | `37.7749` | Projection center latitude | -90..90 | server |
| `WORLD_CENTER_LON` | `-122.4194` | Projection center longitude | -180..180 | server |
| `PIXELS_PER_METER` | `10` | Pixel-to-meter scale | > 0 | server |
| `SOCKET_MOVE_EPS` | `30` | Move events per second per socket | 1..1000 | server |
| `SOCKET_MAX_STEP_PX` | `120` | Max pixel distance per move | 1..100000 | server |
| `PROXIMITY_RADIUS_PX` | `100` | Connect radius (new edges) | 0..diagonal | server |
| `PEER_DISCONNECT_RADIUS_PX` | `115` | Drop radius (hysteresis) | `radiusPx`..3×`radiusPx` | server |
| `MAX_PEERS_PER_USER` | `8` | Peer cap per user (0 = unlimited) | 0..100000 | server |
| `PRESENCE_CLEANUP_INTERVAL_MS` | `30000` | Stale presence sweep interval | 1..2³¹-1 | server |
| `PRESENCE_TIMEOUT_MS` | `60000` | Presence row timeout | 1..2³¹-1 | server |
| `INSTANCE_ID` | random | Unique per-process identifier | pattern | server |
| `ICE_SERVERS` | `[{"urls":"stun:..."}]` | WebRTC ICE servers (JSON array) | JSON | server |
| `SOCKET_SIGNAL_EPS` | `30` | Signal events per second per socket | 1..1000 | server |
| `SOCKET_SIGNAL_BURST` | `200` | Signal burst capacity | 1..10000 | server |
| `AUDIT_ENABLED` | `true` (non-prod) | Enable spatial audit endpoint | boolean | server |
| `AUDIT_TARGET_MS` | `20` | p95 latency target for audit | 0.001..60000 | server |
| `REDIS_URL` | (empty) | Redis connection string (empty = single-instance) | `redis://` or `rediss://` | server |
| `REDIS_KEY_PREFIX` | `proxispeak` | Redis key prefix | pattern | server |
| `EDGE_SWEEP_INTERVAL_MS` | `30000` | Orphan edge sweep interval | 1..2³¹-1 | server |
| `REDIS_CONNECT_TIMEOUT_MS` | `3000` | Redis connection timeout | 100..60000 | server |
| `REDIS_EDGE_TTL_SECONDS` | `3600` | Edge key TTL in Redis | 60..604800 | server |
| `SCALE_CHECK_URL_1` | `http://127.0.0.1:4000` | First instance URL for scale-check | URL | script |
| `SCALE_CHECK_URL_2` | `http://127.0.0.1:4001` | Second instance URL for scale-check | URL | script |
| `SCALE_CHECK_ROOM` | `lobby` | Room for scale-check | room id | script |

**Client (Vite):**

| Name | Default | Meaning | Component |
| --- | --- | --- | --- |
| `VITE_SERVER_URL` | (empty) | Server URL override (empty = auto-detect) | client |
| `VITE_DEV_ALLOWED_HOSTS` | (empty) | Extra hosts for Vite dev server | client (dev only) |

See [.env.example](../.env.example) and [client/.env.example](../client/.env.example) for placeholders and comments.
