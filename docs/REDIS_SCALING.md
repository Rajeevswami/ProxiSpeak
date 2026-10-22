# Multi-Instance Redis Scaling (Week 3 — Day 12)

Day 12 removes the single-process ceiling on ProxiSpeak's Socket.io gateway so
multiple stateless Node.js server processes share presence broadcasts,
point-to-point WebRTC signaling, peer-edge lifecycle state, stale-presence
sweeps, and crash recovery through Redis — **with zero client changes and zero
new packages outside `@socket.io/redis-adapter` and `ioredis`**.

> **Scope note:** Day 12 scales the backend signaling and edge plane across
> multiple Node instances. **Day 13 (mesh optimization) now builds on this key
> space without adding a key** — see [MESH_OPTIMIZATION.md](MESH_OPTIMIZATION.md).

---

## 1. Architecture overview

```text
  Browser A (WebSocket)                         Browser B (WebSocket)
     │        ▲                                    ▲        │
     │        │═════ Direct P2P WebRTC Audio ══════│        │
     │             (never touches Node or Redis)            │
     ▼                                                      ▼
┌──────────────────────────────┐            ┌──────────────────────────────┐
│  Node Instance A (:3001)     │            │  Node Instance B (:3002)     │
│  INSTANCE_ID = node-a        │            │  INSTANCE_ID = node-b        │
│  GET /health -> scaleMode    │            │  GET /health -> scaleMode    │
│                              │            │                              │
│  Socket.io + PeerGraph       │            │  Socket.io + PeerGraph       │
│   ├─ @socket.io/redis-adapter│            │   ├─ @socket.io/redis-adapter│
│   └─ RedisEdgeStore (Lua)    │            │   └─ RedisEdgeStore (Lua)    │
└─────────┬──────────┬─────────┘            └─────────┬──────────┬─────────┘
          │          │                                │          │
          │          └──────────┐          ┌──────────┘          │
          ▼                     ▼          ▼                     ▼
┌──────────────────────┐   ┌───────────────────────────────────────────────┐
│   MongoDB (2dsphere) │   │                 Redis 7.x                     │
│                      │   │                                               │
│  • UserPresence      │   │  Pub/Sub channels (`<prefix>:adapter#*`):     │
│    (x, y, GeoJSON,   │   │   • room fan-out (`user:joined/moved/left`)   │
│     instanceId,      │   │   • socket-id fan-out (`peer:*`, `signal`)    │
│     lastSeen)        │   │   • `io.serverSideEmit` (`expire-socket`,     │
│  • Room blueprints   │   │     `peer-left`)                              │
│  • `$near` queries   │   │                                               │
│                      │   │  Atomic Lua keys (`<prefix>:*`):              │
│                      │   │   • `:edge:<pairToken>` (live edge hash)      │
│                      │   │   • `:gen:<pairToken>`  (monotonic `INCR`)    │
│                      │   │   • `:user-edges:<id>`  (live pairs set)      │
│                      │   │   • `:user-pairs:<id>`  (session pairs set)   │
└──────────────────────┘   └───────────────────────────────────────────────┘
```

### Separation of responsibilities

| Plane | Backing store | Why |
| --- | --- | --- |
| Spatial coordinates & room layouts | **MongoDB (`2dsphere`)** | Already shared across instances since Day 2 (`$near` + exact pixel check). |
| Room & socket event fan-out | **Redis Pub/Sub (`@socket.io/redis-adapter`)** | Every socket automatically joins a room named after its own `socket.id`, so `io.to(roomId).emit(...)` and `io.to(targetSocketId).emit(...)` work transparently across instances. |
| Active peer edges & generations | **Redis keys + atomic Lua (`RedisEdgeStore`)** | Single-threaded Lua execution elects a single winner across N racing instances for every `createEdge` and `removeEdge`. |
| Per-socket move & signal rate limits | **In-memory `TokenBucket` per socket** | A WebSocket lives on one TCP connection on one instance at a time; keeping buckets in process memory adds **0 network round-trips** on hot paths. |
| Voice audio streams | **Direct browser-to-browser WebRTC** | Never passes through Node or Redis; survives mid-run Redis drops uninterrupted. |

---

## 2. Redis key & channel schema

All keys and channels are namespaced under `REDIS_KEY_PREFIX` (default
`proxispeak`). Every `keyPrefix`, `roomId`, and `userId` is strictly validated
before any Redis command is constructed:

* `keyPrefix`: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/` (no colons, spaces, or wildcards)
* `roomId`: `/^[a-z0-9][a-z0-9_-]{0,47}$/`
* `userId`: `/^[A-Za-z0-9_-]{1,128}$/` (self-edges `u1 === u2` rejected)

### Collision-free canonical pair encoding

Undirected user pairs `{u1, u2}` are sorted lexicographically (`a < b`) and
encoded with explicit byte/character lengths:

```text
<pairToken> := "<lenA>:<a>:<lenB>:<b>"   where a < b
```

Because `:` is prohibited inside `userId` **and** both lengths are explicit, two
distinct pairs can **never** alias the same key (for example
`("ab_c", "def") -> "4:ab_c:3:def"` vs `("ab", "c_def") -> "2:ab:5:c_def"`).

### Complete key & channel inventory

| Key / Channel pattern | Type | Purpose | Safety TTL | Deterministic removal path |
| --- | --- | --- | --- | --- |
| `<prefix>:edge:<pairToken>` | `HASH` (`roomId`, `a`, `b`, `generation`) | Single source of truth that an earshot edge is live between `a` and `b`. | `3600 s` (`EXPIRE` refreshed on write) | Deleted atomically by `removeEdge`, `removeUser`, or `sweepOrphanEdges`. |
| `<prefix>:gen:<pairToken>` | `STRING` (integer via `INCR`) | Monotonically increasing generation counter per pair across instances so stale WebRTC offers/ICE for prior edges are rejected. | `3600 s` (`EXPIRE` refreshed on create/remove) | Deleted atomically by `removeUser` / `sweepOrphanEdges` once either user leaves. |
| `<prefix>:user-edges:<userId>` | `SET` of `<pairToken>` | Fast `O(degree)` lookup for `edgesOf(userId)` and disconnect cleanup. **Day 13:** the same set is the degree source for the peer cap — `CREATE_EDGE_LUA` runs `SCARD` on both endpoints inside the atomic create, so no new key and no extra round-trip is needed. | `3600 s` | Entries removed on `removeEdge`; set deleted on `removeUser` / `sweepOrphanEdges`. |
| `<prefix>:user-pairs:<userId>` | `SET` of `<pairToken>` | Tracks every pair counter opened during `userId`'s session so `<prefix>:gen:<pairToken>` is cleaned on exit without scanning all keys. | `3600 s` | Cleaned on both endpoints and deleted on `removeUser` / `sweepOrphanEdges`. |
| `<prefix>:adapter#*` | Pub/Sub channels (ephemeral, zero stored keys) | Socket.io room broadcasts, point-to-point `io.to(socketId)` relays, and `io.serverSideEmit` control events. | Ephemeral (in-flight Pub/Sub only) | Unsubscribed automatically on room empty / `adapter.close()`. |

`KEYS` is **never** called anywhere in production or test code. Diagnostic and
orphan sweeps iterate exclusively via cursor-based `SCAN ... MATCH ... COUNT 100`.

---

## 3. Atomicity, initiator, and ordering guarantees

1. **Single `peer:connect` winner under arbitrary concurrency (`CREATE_EDGE_LUA`)**:
   When User A (on Instance A) and User B (on Instance B) simultaneously move
   within `100 px`, both instances query `$near`, discover each other, and call
   `RedisEdgeStore.createEdge(roomId, a, b)`. Redis executes `CREATE_EDGE_LUA`
   atomically on its single event loop:
   * Winner sees `EXISTS == 0`, runs `INCR <prefix>:gen:<pairToken>`, writes the
     hash and per-user sets, and receives `{ created: true, generation: g }`.
   * Loser sees `EXISTS == 1` and receives `{ created: false, generation: g }`.
   * **Only `created === true` emits `peer:connect`** — guaranteeing each client
     receives **one** `peer:connect` with identical `generation = g`.
2. **Deterministic WebRTC offerer without coordination**:
   `initiator = min(a, b)` (lexicographically smaller socket ID). Because both
   sides agree on `a` and `b`, exactly one browser creates the SDP offer and the
   other waits to answer — zero glare.
3. **Single `peer:disconnect` winner (`REMOVE_EDGE_LUA`)**:
   Concurrent move-away, disconnect, presence sweep, or orphan sweep callers
   racing on `removeEdge(roomId, a, b)` see `true` **only** for the single Lua
   invocation that deleted `<prefix>:edge:<pairToken>`. Every loser receives
   `false` and stays silent.
4. **Cross-instance stale presence sweep & session recovery**:
   * **Boot cleanup (`cleanupOnBoot`)** deletes **only `{ instanceId }`** rows so
     restarting Instance B never drops live users connected to Instance A.
   * **Periodic sweep (`cleanupStale`)** runs across stale rows (`lastSeen < cutoff`)
     in multi-instance mode and claims each row atomically via
     `deleteOne({ _id, roomId, lastSeen: { $lt: cutoff } })`.
   * Only the instance with `deletedCount === 1` removes peer edges, emits
     `user:left` once, and invokes `io.closeRemoteSocket(roomId, sessionId)`.
   * If the stale socket lives on another instance, `io.serverSideEmit('proxispeak:expire-socket', ...)`
     instructs the owning instance to mark `presenceExpired = true`, drop local
     peer registration, and call **`socket.conn.close()`** (raw Engine.IO
     transport close — **never** `socket.disconnect(true)`), triggering automatic
     Socket.io client reconnection and Day 7 re-join recovery.

---

## 4. Failure modes and user impact

| Failure scenario | System response | `/health` `scaleMode` | User-visible UX impact |
| --- | --- | --- | --- |
| `REDIS_URL` unset / empty | Zero Redis connections created; synchronous `MemoryEdgeStore` active. | `"single"` | Exact pre-Day-12 single-instance behavior; 0 network hops on edge ops. |
| `REDIS_URL` unreachable at boot | Clients torn down after `REDIS_CONNECT_TIMEOUT_MS` (default `3000 ms`); **one** loud redacted warning logged; no reconnect loop. | `"single"` | Process boots cleanly as single-instance instead of crash-looping. |
| Redis drops mid-run | Adapter & `RedisEdgeStore` errors caught safely; zero process crashes; zero socket disconnects. | `"redis-degraded"` (`HTTP 200`) | Existing P2P WebRTC audio calls continue uninterrupted; new cross-instance edges pause until Redis reconnects. |
| Redis recovers mid-run | `ioredis` reconnects automatically; once all 3 clients (`store`, `pub`, `sub`) emit `ready`, `PeerGraph.reconcileLocalUsers()` runs on every instance. | `"redis"` (`HTTP 200`) | Any avatars standing within earshot automatically receive `peer:connect` without needing to move again. |
| `FLUSHALL` run while connected | Pub/Sub channels stay live; next `move` or `sweepOrphanEdges()` detects empty Redis keys, reconciles live local users, and seeds `CREATE_EDGE_LUA` with each instance's session `pairGenFloor` (`generation = prev + 1`). | `"redis"` (`HTTP 200`) | Zero crashes or socket drops; edges self-heal with strictly higher generations so client `PeerManager` replaces stale peers cleanly. |
| Node instance killed (`kill -9`) | Surviving instances' `sweepOrphanEdges()` (`SCAN` every `EDGE_SWEEP_INTERVAL_MS`, plus boot pass) detects edges whose `sessionId` has no live `UserPresence`, emits `peer:disconnect` to survivors once, and cleans keys. | `"redis"` | Disconnected clients auto-reconnect to surviving instances; surviving peers cleanly close dead WebRTC connections. |

`/health` reads cached `scaleState` in memory and **never** performs MongoDB or
Redis network I/O, preventing transient backing-service blips from triggering
cascading container restarts.

---

## 5. Load balancer & sticky-session note

Socket.io's default handshake begins with **Engine.IO HTTP long-polling** before
upgrading to a WebSocket (`GET /socket.io/?EIO=4&transport=polling` followed by
`POST` + `Upgrade: websocket`). Across multiple Node instances behind a reverse
proxy (Nginx, HAProxy, ALB, Envoy):

* **Either** enable **sticky sessions** (cookie or client IP hash) on the load
  balancer when HTTP long-polling fallback is enabled,
* **Or** configure clients for direct WebSocket transport (`transports: ['websocket']`),
  which opens a single stateful TCP connection directly to one upstream instance
  with no multi-request polling handshake.

TLS (`rediss://...`) is supported natively whenever `REDIS_URL` uses the
`rediss:` scheme, and credentials in URLs are always redacted (`***`) before logging.

---

## 6. Running two instances locally & running `scale-check`

### Start MongoDB, Redis, and two ProxiSpeak instances

```bash
# Terminal 1 — seed rooms once
MONGO_URI="mongodb://127.0.0.1:27017/proxispeak" npm run seed

# Terminal 2 — Instance A on :4000
PORT=4000 INSTANCE_ID=node-a \
  MONGO_URI="mongodb://127.0.0.1:27017/proxispeak" \
  REDIS_URL="redis://127.0.0.1:6379" \
  CLIENT_URL="http://localhost:5173" \
  npm start

# Terminal 3 — Instance B on :4001
PORT=4001 INSTANCE_ID=node-b \
  MONGO_URI="mongodb://127.0.0.1:27017/proxispeak" \
  REDIS_URL="redis://127.0.0.1:6379" \
  CLIENT_URL="http://localhost:5173" \
  npm start
```

Inspect `/health` on both ports:

```bash
curl -s http://127.0.0.1:4000/health
# {"status":"ok","service":"proxispeak","instanceId":"node-a","scaleMode":"redis",...}
curl -s http://127.0.0.1:4001/health
# {"status":"ok","service":"proxispeak","instanceId":"node-b","scaleMode":"redis",...}
```

### Run the automated two-instance verification CLI

```bash
npm run scale-check
# or override explicit URLs / room:
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
```

Sample output (verified against real MongoDB `8.0.0` + `redis-server` `7.4.2`):

```text
ProxiSpeak Two-Instance Scale Check — A=http://127.0.0.1:4000 | B=http://127.0.0.1:4001 | room=lobby
check                                            status  detail
1. /health reports 2 distinct redis instances    PASS    A=node-a (redis), B=node-b (redis)
2. Cross-instance join snapshot & user:joined    PASS    A=..., B=..., snapshotSawA=true
3. Cross-instance user:moved broadcast           PASS    A walked to (..., ...) within earshot of B (..., ...)
4. Single peer:connect per side & 1 initiator    PASS    countA=1, countB=1, gen=1, initA=false, initB=true
5. Cross-instance WebRTC signal relay            PASS    relayed offer & answer for gen=1
6. Stale-generation signal rejected safely       PASS    error.code=stale_generation, socketAlive=true
7. Out-of-range peer:disconnect & signal guard   PASS    discA=1, discB=1, afterDisconnectError=no_peer_edge
8. Cross-instance disconnect & user:left         PASS    user:left count for B on A = 1
RESULT: PASS (8/8 checks passed)
```

---

## 7. Measured performance, leak audit, and honest limitations

### Measured 50-user benchmark (real `redis-server` 7.4.2 over loopback TCP)

Measured by `server/test/redis.scale.integration.test.js` (`node:perf_hooks`,
50 concurrent WebSocket users, 60 end-to-end round-trips per operation):

| Operation (50 active WebSocket avatars) | Single-instance (`MemoryEdgeStore`) | Two-instance (`RedisEdgeStore` + Pub/Sub) | Measured Redis overhead |
| --- | --- | --- | --- |
| `move -> user:moved` round-trip **p50** | `0.904 ms` | `1.288 ms` | **`+0.384 ms`** |
| `move -> user:moved` round-trip **p95** | `2.898 ms` | `2.300 ms` – `4.915 ms` | **`<= +2.9 ms`** |
| `signal -> signal` relay round-trip **p50** | `0.069 ms` | `0.340 ms` | **`+0.271 ms`** |
| `signal -> signal` relay round-trip **p95** | `0.126 ms` | `1.360 ms` | **`+1.234 ms`** |

### Measured 50-cycle cross-instance leak audit

After 50 full cross-instance `join -> proximity peer:connect -> WebRTC signal -> disconnect`
cycles:

* `redisStoreKeys`: **`0`**
* `presenceRows`: **`0`**
* `nodeASockets` / `nodeBSockets`: **`0` / `0`**
* `nodeAPeerRooms` / `nodeBPeerRooms`: **`0` / `0`**
* `nodeARemoteNames` / `nodeBRemoteNames`: **`0` / `0`**
* `nodeAPendingSyncs` / `nodeBPendingSyncs`: **`0` / `0`**

### Current limitations (honest architectural boundaries)

1. **Mesh optimization is Day 13 (implemented):** the default policy is a
   symmetric cap of `MAX_PEERS_PER_USER=8` plus a 115 px drop radius, so a
   dense crowd no longer forms an `O(k²)` mesh. Existing edges are never evicted
   for closer newcomers; that limitation, the measurements and the star
   no-thrash proof are in [MESH_OPTIMIZATION.md](MESH_OPTIMIZATION.md).
   `MAX_PEERS_PER_USER=0` with `PEER_DISCONNECT_RADIUS_PX` equal to the radius
   reproduces the Day 12 behaviour exactly.
2. **Standalone Redis topology:** Connects to one `REDIS_URL` (`redis://` or
   `rediss://`). Redis Sentinel / Redis Cluster sharded Pub/Sub and TURN servers
   are outside Day 12 scope.
3. **Environment verification note (2026-10-22, Day 13):** the Day 13 Redis
   suites (edge-store cap contract, cross-instance cap/reclaim/sweep, embedded
   two-instance `mesh-check`) ran live against `redis-server` **6.2.14** with
   **0 skipped**; the full server suite was **136 passed / 0 failed / 32
   skipped** (168 tests) and the client suite **151 passed / 0 failed** here. The 32 skips
   are all MongoDB-backed suites: this sandbox has no `mongod` and cannot
   download one (no apt or `fastdl.mongodb.org` access), so the MongoDB path and
   a two-browser audible check remain **NOT VERIFIED here**; run with
   `MONGO_URI_TEST` + `REDIS_URL_TEST` on a machine with MongoDB and Redis for
   `0` skipped.
