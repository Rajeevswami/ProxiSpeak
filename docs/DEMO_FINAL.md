# Final Project Review — 10-Minute Live Demonstration Script

This script walks through a **10-minute live demonstration** for the Final Project Review, directly mapped to the two final company review targets:

- **Target A — Scalable, Stateful Geospatial Server Managing Complex P2P Routing Logic**:
  MongoDB `2dsphere` `$near`/`$geoWithin` spatial engine (`< 20 ms` p95), two Node.js instances sharing Redis Pub/Sub and Lua `RedisEdgeStore`, `100 px` connect / `115 px` hysteresis drop radius, `MAX_PEERS_PER_USER` degree cap with nearest-first refill, live layout persistence (`layoutRevision`), Redis outage/recovery, and `kill -9` instance crash recovery.
- **Target B — Immersive, Physics-Aware Communication Platform Demonstrating Advanced Browser Audio Manipulation**:
  WebRTC P2P microphone audio chained through `MediaStreamAudioSourceNode -> StereoPannerNode -> GainNode -> destination` with smoothstep distance attenuation, 2D Liang-Barsky wall/furniture sound occlusion, equal-power left/right stereo panning, and a two-layer 60 FPS Canvas 2D rendering pipeline (`?perf=1`).

> **Note on sample output below**: Terminal blocks marked *(illustrative local output — requires running MongoDB/browsers)* show the exact output format produced on a machine with local MongoDB, Redis, and two browsers; blocks marked *(measured in verification sandbox)* show real output captured directly in the test environment.

---

## Pre-Demo Checklist (Before the Clock Starts)

1. Have **MongoDB** (`127.0.0.1:27017`) and **Redis** (`127.0.0.1:6379`) running locally.
2. Build the production client bundle once so both servers serve the full SPA from their own port:
   ```bash
   npm run build
   ```
3. Wear **wired headphones** (prevents acoustic feedback between the two local browser windows and makes left/right stereo panning clearly audible).
4. Open four terminal tabs (`T1` = Node A on `:4000`, `T2` = Node B on `:4001`, `T3` = CLI commands, `T4` = Redis control).

---

## Minute 0:00 – 1:30 | Seed, Start Two Clustered Instances, and Spatial Audit (Target A)

### Commands

In **T3**, seed the default rooms (`lobby`, `studio`, `lounge`) and `2dsphere` index:

```bash
npm run seed
```

In **T1**, start **Instance A** on port `4000`:

```bash
PORT=4000 INSTANCE_ID=node-a REDIS_URL="redis://127.0.0.1:6379" ROOM_ADMIN_TOKEN="demo-secret" npm start
```

In **T2**, start **Instance B** on port `4001`:

```bash
PORT=4001 INSTANCE_ID=node-b REDIS_URL="redis://127.0.0.1:6379" ROOM_ADMIN_TOKEN="demo-secret" npm start
```

In **T3**, verify both `/health` endpoints and run the **Spatial Audit** (`50` users, `25` samples):

```bash
curl -s http://127.0.0.1:4000/health
curl -s http://127.0.0.1:4001/health
npm run audit -- --users=50 --samples=25 --seed=1
```

### What to Say

> "Both Node processes serve the built React app, the REST API, and Socket.io from a single origin on ports `4000` and `4001`, connected to MongoDB and sharing Redis (`scaleMode: 'redis'`). Before any browser joins, `npm run audit` plants edge-case avatars at `99 px`, `100 px`, and `101 px` plus seeded random users, verifies that MongoDB uses the `2dsphere` index (`COLLSCAN=false`), checks 100% agreement against an independent Euclidean brute-force reference, and confirms `p95` latency is well under the `20 ms` Mid-Project Review budget."

### Expected Result *(illustrative local output — requires running MongoDB)*

```text
{"status":"ok","service":"proxispeak","instanceId":"node-a","scaleMode":"redis","uptimeSeconds":6,"time":"..."}
{"status":"ok","service":"proxispeak","instanceId":"node-b","scaleMode":"redis","uptimeSeconds":4,"time":"..."}

Spatial Audit — room audit-9f2c1a04 (throwaway), db host 127.0.0.1:27017
users=50 samples=25 warmup=3 seed=1 radius=100px target p95 <= 20ms
operation              mismatches      p50ms      p95ms        maxms
findNearby                      0      1.420      2.610        3.480
countWithin                     0      0.980      1.840        2.310
computeClusters                 0      0.790      1.450        1.920
computeClustersViaNear          0     18.500     24.100       27.800
index: $near 2dsphere=true COLLSCAN=false; $geoWithin 2dsphere=true COLLSCAN=false
cleanup verified (0 rows left): true
RESULT: PASS
```

---

## Minute 1:30 – 3:00 | Cross-Instance Join & `?perf=1` 60 FPS Readout (Targets A & B)

### Actions

1. Open **Browser Window 1** at `http://localhost:4000/?perf=1` (connected to **Instance A**) and join room `lobby` as `Alice` with Microphone enabled.
2. Open **Browser Window 2** at `http://localhost:4001/?perf=1` (connected to **Instance B**) and join room `lobby` as `Bob` with Microphone enabled.

### What to Say

> "Alice is connected to `node-a` on port `4000` and Bob is connected to `node-b` on port `4001`. Even though they are on different Node processes, both immediately see each other on the 2D floor plan via the Socket.io Redis adapter. Notice the `?perf=1` telemetry bar: the room floor, grid, and obstacles are cached on an offscreen `<canvas>` (`staticLayer.js`) rebuilt only when dimensions, DPR, or `layoutRevision` change, so every animation frame executes a single `drawImage` blit plus zero-allocation dynamic avatar drawing at a steady 60 FPS."

### Expected Result

- Both windows show `Alice (you)` and `Bob` in `Lobby`.
- The `?perf=1` line displays:
  ```text
  fps 60 | frame p95 16.9 ms | work p95 0.4 ms | dropped 0
  ```
- Because Alice and Bob spawned at distant spawn points (`> 100 px`), the Audio HUD shows `connected 0 / 8` and **zero WebRTC offers/answers** have been sent yet.

---

## Minute 3:00 – 5:30 | Distance Fade, Wall Occlusion, and Stereo Panning (Target B)

### Actions

1. **Walk into earshot (`<= 100 px`)**:
   - Walk `Alice` (`WASD` or click-to-move) toward `Bob` in open floor space until distance crosses `<= 100 px`.
   - Observe `peer:connect` fire across Redis (`connected 1 / 8`, `connectionState: connected`).
2. **Distance attenuation (`100 px -> 30 px -> 115 px`)**:
   - Walk slowly from `95 px` inward to `25 px`, then back out to `105 px` (hysteresis zone), and finally past `115 px`.
3. **Obstacle sound occlusion**:
   - Walk back within `70 px` of `Bob`, then step to the opposite side of the central concrete wall (`wall-core`, `attenuation = 0.12`) or a desk (`attenuation = 0.50`) while staying within `70 px`.
4. **3D/Stereo left-right panning**:
   - Walk `Alice` in a circle around `Bob` (left of `Bob`, directly above `Bob`, right of `Bob`).

### What to Say

> "First, WebRTC signaling only happens once Euclidean distance enters `100 px`. Inside `30 px` volume is `100%`; between `30 px` and `100 px` a smoothstep curve attenuates the `GainNode`; between `100 px` and `115 px` the hysteresis band holds the WebRTC connection silent so boundary jitter never triggers ICE renegotiations; past `115 px` the edge drops cleanly.
>
> Next, when Alice steps behind the central concrete wall (`attenuation = 0.12`) at the exact same `70 px` distance, Liang-Barsky line-of-sight clipping multiplies `0.12` into the target gain (`39% -> 5%`) with an `80 ms` exponential time constant—muffling the voice smoothly without dropping the WebRTC peer connection.
>
> Finally, as Bob moves from Alice's left to right on screen, `StereoPannerNode` pans smoothly from `pan L 85%` through `pan C` to `pan R 85%` (`pan = 0.85 * dx / max(dist, 30)`)."

### Expected Result

- **Open space at `70 px`**: HUD displays `70 px · volume 39% (100%) · pan R 60%`.
- **Across `wall-core` at `70 px`**: HUD displays `70 px · volume 5% (blocked 12%) · pan R 60%` and voice drops sharply in headphones.
- **Circling `Bob`**: HUD transitions smoothly through `pan L ...` → `pan C` → `pan R ...`, matching left/right headphone channels.

---

## Minute 5:30 – 7:00 | Live Room Layout Persistence via CLI (Targets A & B)

### Commands

In **T3**, inspect the current `lobby` revision, validate a new layout with `--dry-run`, and then save `server/layouts/quiet-zone.json` live:

```bash
npm run room:show -- --room lobby
npm run room:save -- --room lobby --file server/layouts/quiet-zone.json --dry-run
npm run room:save -- --room lobby --file server/layouts/quiet-zone.json
```

### What to Say

> "Room layouts are persisted in MongoDB with a monotonic `layoutRevision` and optimistic concurrency control. When we run `npm run room:save`, the layout is validated against room bounds and obstacle caps, saved atomically in MongoDB, broadcast via `room:layout` to both browser windows across Redis, and `room:cache:invalidate` evicts the in-memory room cache on all server instances. Both canvases rebuild their offscreen `staticLayer` once on the revision bump and the audio mixer immediately recomputes obstacle occlusion on the next 50 ms tick—without reloading or re-joining."

### Expected Result *(illustrative local output — requires running MongoDB)*

```text
INFO [proxispeak:cli:room-layout] [dry-run] Layout for "lobby" is valid (6 obstacles)
INFO [proxispeak:cli:room-layout] Target MongoDB: mongodb://127.0.0.1:27017/proxispeak
INFO [proxispeak:cli:room-layout] Saved layout for "lobby" (revision 2, 6 obstacles)
```

- Both Browser Window 1 (`:4000`) and Browser Window 2 (`:4001`) redraw the new obstacle layout instantaneously, and the occlusion percentage in the Audio HUD updates on the next tick.

---

## Minute 7:00 – 8:30 | Symmetric Peer Cap (`MAX_PEERS_PER_USER=2`) & Nearest-First Refill (Target A)

### Commands & Actions

1. Restart **T1** and **T2** with `MAX_PEERS_PER_USER=2`:
   ```bash
   PORT=4000 INSTANCE_ID=node-a MAX_PEERS_PER_USER=2 REDIS_URL="redis://127.0.0.1:6379" npm start
   PORT=4001 INSTANCE_ID=node-b MAX_PEERS_PER_USER=2 REDIS_URL="redis://127.0.0.1:6379" npm start
   ```
2. Open **4 browser windows** (`Alice`, `Bob`, `Carol`, `Dan`) in `lobby` and walk all 4 avatars to the same spot (`<= 50 px` apart).
3. Or run the automated two-instance Redis mesh verifier in **T3**:
   ```bash
   REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check
   ```

### What to Say

> "To prevent quadratic `N*(N-1)/2` WebRTC encoding overload in crowded rooms, the Lua `RedisEdgeStore` enforces `MAX_PEERS_PER_USER` atomically and symmetrically. With `MAX_PEERS_PER_USER=2` and four avatars standing together, each user connects to at most 2 peers (`connected 2 / 2 (at cap)`) sorted nearest-first. The moment one connected peer walks past `115 px` or disconnects, `proxispeak:edge-removed` triggers a bounded reclaim sync that automatically connects the waiting 3rd peer."

### Expected Result *(measured in verification sandbox with real Redis)*

```text
=== ProxiSpeak Day 13 Mesh Optimization Check ===
Mode: embedded two-instance harness (REDIS_URL=redis://127.0.0.1:6379)
...
  Total checks: 37 | Passed: 37 | Failed: 0
RESULT: PASS
```

---

## Minute 8:30 – 10:00 | Fault Tolerance: Redis Outage/Recovery & `kill -9` Instance Crash (Target A)

### Part 1 — Stopping and Restarting Redis Mid-Session

In **T4**, stop Redis while `Alice` (`:4000`) and `Bob` (`:4001`) are connected, check `/health`, move an avatar, and then restart Redis:

```bash
# Stop Redis (or pause via redis-cli)
redis-cli shutdown nosave

# Check /health on both nodes
curl -s http://127.0.0.1:4000/health
curl -s http://127.0.0.1:4001/health

# Restart Redis
redis-server --daemonize yes
curl -s http://127.0.0.1:4000/health
```

**What to Say & Expected Result**:
- When Redis stops, neither server crashes and **zero browser sockets disconnect**.
- `/health` stays `200 OK` and transitions `scaleMode` from `"redis"` to `"redis-degraded"`. Already-established WebRTC P2P audio between Alice and Bob continues flowing directly between browsers. Moves during the outage log a `WARN` (not `ERROR`) on the server and emit a recoverable `server_error` notice to the client.
- As soon as `redis-server` restarts, `ioredis` reconnects, `/health` returns to `scaleMode: "redis"`, and `reconcileLocalUsers()` automatically synchronizes any edges that crossed `100 px` during the outage.

### Part 2 — `kill -9` of One Server Instance & Recovery

In **T3**, find the PID of **Instance B** (`:4001`) and terminate it abruptly with `kill -9`:

```bash
kill -9 $(lsof -t -i:4001)
```

Then restart **Instance B** in **T2**:

```bash
PORT=4001 INSTANCE_ID=node-b REDIS_URL="redis://127.0.0.1:6379" npm start
```

**What to Say & Expected Result**:
- When `node-b` is killed with `SIGKILL` (`kill -9`), `Alice` on `node-a` (`:4000`) is unaffected. Meanwhile, `node-a`'s periodic stale-presence and orphan-edge sweeps (`presenceCleanup.js` and `edgeSweep.js`) evict any orphaned edges/presence left by the crashed node.
- In `Bob`'s browser window (`:4001`), the HUD displays `Connection lost — reconnecting…` without reloading the page.
- As soon as `node-b` starts back up, Socket.io reconnects automatically, re-emits `join`, restores `Bob` into `lobby`, and re-establishes the WebRTC audio edge with `Alice` at a strictly higher generation number.

---

## Demo Troubleshooting Quick Reference

| Issue During Demo | Immediate Fix |
| --- | --- |
| **`room "lobby" does not exist` when joining** | Run `npm run seed` in **T3** against the same `MONGO_URI` used by the servers. |
| **Port `4000` or `4001` already in use (`EADDRINUSE`)** | Run `kill $(lsof -t -i:4000 -i:4001)` before starting the instances. |
| **Echo / feedback screech in room** | Plug in headphones, or join the second window in **Listen only** mode (WebRTC P2P audio still flows in one direction and shows distance/occlusion/panning on the listener's HUD). |
| **`Audio is paused by the browser` banner** | Click once anywhere inside the receiving browser window to satisfy the browser's Web Audio user-gesture autoplay policy. |
| **`scaleMode: "single"` instead of `"redis"` on `/health`** | Ensure `REDIS_URL="redis://127.0.0.1:6379"` is passed to both `npm start` commands and `redis-server` is running. |
