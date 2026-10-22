# Mesh Optimization (Week 3 — Day 13)

Day 13 caps and stabilises the WebRTC mesh. Nothing new is installed: the same
Socket.io gateway, `PeerGraph`, `EdgeStore` and Redis keys from Day 12 now apply
a **symmetric per-user peer cap**, a **hysteresis band** around the 100 px
connect radius, **nearest-first deterministic** slot filling and **bounded slot
reclaim**. The WebRTC rule from the Mid-Review stays true: an offer/answer is
only ever initiated between users who are within **100 px**.

> **Scope:** this is mesh optimization only. Stereo panning, obstacle occlusion,
> room persistence, an SFU/MCU, TURN, deploy configs and TypeScript are **not**
> part of Day 13.

---

## 1. The problem, with numbers

Before Day 13 every pair within 100 px opened its own `RTCPeerConnection`:

* edges in a room where `k` users stand inside one 100 px circle:
  `k(k−1)/2` (10 → 45, 20 → 190, 50 → 1225);
* connections per browser: `k−1` (10 → 9, 20 → 19, 50 → 49).

Each edge is one SDP offer/answer exchange, one ICE trickle stream, one audio
encoder/decoder pair and one set of stats timers **per browser**. A dense room is
therefore quadratic in every one of those resources, and a mid-range laptop
stops keeping up long before the signaling server does.

Measured with `npm run mesh-check` in this environment (real Socket.io sockets,
two embedded server instances sharing real Redis `6.2.14`; every pair inside the
tight cluster ≤ 30 px apart):

| Configuration | Users | Max conns / user | Mean | Total edges | Connect events seen | Signals relayed | Dropped | Settled after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **before** — unlimited peers, drop = 100 px | 10 | 9 | 9.0 | 45 | 94 | 45/45 | 0 | 1712 ms |
| **before** — unlimited, drop = 100 px | 20 | 19 | 19.0 | 190 | 402 | 190/190 | 0 | 2687 ms |
| **before** — unlimited, drop = 100 px | 50 | 49 | 49.0 | **1225** | 3174 | 1225/1225 | 0 | 5206 ms |
| **after** — cap 8, drop 115 px | 10 | 8 | 7.2 | 36 | 76 | 36/36 | 0 | 1739 ms |
| **after** — cap 8, drop 115 px | 20 | 8 | 7.3 | 73 | 168 | 73/73 | 0 | 2725 ms |
| **after** — cap 8, drop 115 px | 50 | 8 | 7.6 | **190** | 672 | 190/190 | 0 | 5232 ms |

The 50-user edge count drops from **1225 to 190** (−84.5%) and the worst browser
from 49 WebRTC connections to **8**. The theoretical bound at cap 8 is 200 edges
(`50 × 8 / 2`); the measured 190 means a few slots stay empty because existing
edges are never evicted (see §5) — the cap is a hard upper bound, not a promise
that every slot is always used.

Formulas behind the "before" row: `k(k−1)/2` edges and `k−1` connections per
browser.

---

## 2. The policy

### 2.1 Symmetric, atomic cap (`MAX_PEERS_PER_USER`)

A new edge `{a, b}` is created **only if** `degree(a) < max` **and**
`degree(b) < max`. The default is `8`; `0` disables the cap and restores Day 12
exactly. The check lives inside the store's create operation:

* `MemoryEdgeStore.createEdge` — one synchronous step over two `Set.size`
  values; no `await` can interleave between the check and the insert.
* `RedisEdgeStore.createEdge` — the existing `CREATE_EDGE_LUA` script now runs
  `SCARD <prefix>:user-edges:<a>` and `SCARD <prefix>:user-edges:<b>` **inside
  the same Lua invocation**, before it writes anything. Redis executes scripts
  atomically, so two instances racing the same hub cannot both take the last
  slot. No extra round-trip, no new key: the degree is read from the per-user
  edge sets that already existed on Day 12.

The create result carries `capped: true` when the pair was refused. The caller
counts it (`cappedRejections`) and **stays silent**: a capped pair is not an
error, produces no `peer:connect`, no `peer:disconnect` and no socket `error`
event.

**Why the check must be symmetric and atomic — the star paradox.** If only the
initiating side were checked, a star centre with one free slot could accept an
edge from every leaf at once (each leaf checked only itself, each saw room).
The centre would end up with N edges, and the leaves could each be at their own
cap while the centre is over it. The mirror failure also exists: checking
both sides in two separate reads without atomicity lets two instances each see
"1 of 2 slots used" and both create, giving degree 3. Only a single atomic
check of both degrees prevents either over-count.

### 2.2 Hysteresis — connect at 100 px, drop at 115 px

* `PROXIMITY_RADIUS_PX` (100) stays the **connect** radius. A new edge is only
  created when the measured pixel distance is **≤ 100**.
* `PEER_DISCONNECT_RADIUS_PX` (default `radius + 15` = **115**) is the **drop**
  radius. An existing edge is removed only when the distance **exceeds 115**.
  Validation: `radius ≤ drop ≤ 3 × radius`; setting it equal to the radius
  restores the Day 12 connect/disconnect behaviour exactly.
* Removal on disconnect, presence expiry and room leave is unchanged: those
  paths remove the edge regardless of distance.

| Distance | New edge? | Existing edge | Client experience |
| --- | --- | --- | --- |
| 0–100 px | yes | kept | connected, audio audible |
| 100–115 px | **no** | **kept** | connected, audio already silent (Day 11 gain is 0 at 100 px) |
| > 115 px | no | removed | `peer:disconnect` |

**Why the 100–115 px band is silent.** Day 11's attenuation curve reaches gain
0 exactly at `proximityRadiusPx` (100 by default). An edge held in the band
therefore carries no audible audio; it only avoids tearing down and rebuilding
a peer connection for a person who stepped one pixel over the line. The band is
a stability mechanism, not an audio extension — the *hearing* radius is still
100 px.

Measured boundary churn (one user oscillating 99 ↔ 101 px across another's
boundary 100 times, counted on both endpoints):

| Configuration | Connect events | Disconnect events |
| --- | ---: | ---: |
| hysteresis, drop = 115 px | **0** | **0** |
| drop = 100 px (Day 12 behaviour) | 100 | 100 |

The first edge still appears exactly at 100 px in both configurations — the
approach test walks a peer in from 260 px in 10 px steps and records the
distance of the first `peer:connect`.

### 2.3 Nearest-first and deterministic

`findNearby` already returns neighbours sorted by distance. Before creating
anything, `PeerGraph` sorts the candidates again by `(distancePx, userId)` and
processes them in that order, so slots go to the nearest peers and two runs with
the same positions produce the same edge set. Entries without a finite
`distancePx` are never used to create a new edge (the server cannot prove they
are inside 100 px), though they may keep an existing edge inside the band.

### 2.4 Slot reclaim, bounded

When an edge disappears — peer left, moved past the drop radius, expired — the
two endpoints get **at most one** extra sync each, so freed slots are filled by
the nearest in-range unconnected peer:

* the mover's own sync removes the edge and continues to fill its free slots in
  the same pass (nearest-first);
* `PeerGraph.leave()` schedules one reclaim sync per surviving endpoint;
* an edge removed on another instance is announced with `io.serverSideEmit`
  (`proxispeak:edge-removed`) and the owning instance syncs its local endpoint;
* a reclaim sync is flagged `isReclaim` and **never schedules further reclaims**,
  so a removal cannot cascade. Work per removal is O(degree) store calls, not a
  graph-wide recomputation.

### 2.5 No eviction — an honest limitation

An existing edge is **never** dropped to make room for a closer newcomer. A
crowded user who connected to eight farther peers keeps them even if somebody
closer arrives later; the newcomer's slot only appears when an edge is removed
naturally. This is deliberate: eviction on every approach would thrash the mesh
(connect/disconnect storms, new generations, renegotiation) exactly when the
room is busiest. Consequence: after a burst of joins the greedy edge set can
have a few users below the cap even while in-range peers wait (measured mean
7.2–7.6 at cap 8, not 8.0). Adding eviction would be a separate policy change
with its own churn budget.

### 2.6 Star no-thrash guarantee

Scenario from the brief: eight users at `(100,100)`, one outsider `Z` at
`(180,100)`, `MAX_PEERS_PER_USER=4`. After the first settled state, 100 further
rounds of `sync` from either side (four different orders, including reversed)
produce **zero** new `peer:connect` and **zero** `peer:disconnect` events, and
the final edge set and per-user degrees are identical to the settled ones. This
is proven by `peerGraph.mesh.test.js` ("star scenario…") and is a direct
consequence of nearest-first ordering, the symmetric cap and no eviction: every
sync re-computes the same candidate list, finds the same degrees and the same
existing edges, and creates nothing.

---

## 3. Cross-instance behaviour

* The cap lives in the **shared** `EdgeStore`, not in process memory, so two
  instances enforcing it see the same degrees (the Redis Lua `SCARD` reads the
  shared sets).
* `reconcileLocalUsers()` (after a Redis outage / `FLUSHALL`) and
  `sweepOrphanEdges()` use the same create/remove paths, so they cannot create
  an edge above the cap or beyond 100 px, and cannot remove one inside the drop
  radius unless the user is really gone.
* Orphan sweep removes edges whose presence row vanished (`kill -9`); after the
  sweep the surviving peers reconcile normally and fill free slots within the
  policy.
* Counters are **per instance** (in memory): `edgesCreated`, `edgesRemoved`,
  `cappedRejections`, `hysteresisHolds`. They are logged at `debug` level and
  printed by `mesh-check`; `/health` does not gain any network or DB call.

Failure modes:

| Failure | Effect on the mesh |
| --- | --- |
| An instance dies (`kill -9`) | Orphan sweep removes its edges; survivors reclaim slots on the next sync. No cap is ever exceeded because every create still checks both degrees. |
| Redis drops mid-run | Existing P2P audio is untouched; new edges pause. On recovery every instance reconciles within cap and radii. |
| `FLUSHALL` | Edges disappear; next `move`/reconcile re-creates them through the same capped create (strictly higher generations). |
| Two instances race the same hub | Lua serialises the `SCARD` checks; the loser receives `capped` and stays silent. |
| A peer sits exactly at 100 px | `<=` is inclusive: the edge is created (and held anywhere ≤ 115 px). |

---

## 4. Configuration

| Variable | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `PROXIMITY_RADIUS_PX` | `100` | `0 … world diagonal` | **Connect** radius (unchanged). |
| `PEER_DISCONNECT_RADIUS_PX` | `radius + 15` (`115`) | `>= radius`, `<= 3 × radius` | **Drop** radius for existing edges. Equal to the radius = Day 12 behaviour. |
| `MAX_PEERS_PER_USER` | `8` | integer `0 … 100000`; `0` = unlimited | Symmetric degree cap. `0` = Day 12 behaviour. |

Both new values travel to the client in the `joined` payload as `maxPeers` and
`peerDisconnectRadiusPx`.

### Client indicator (no new protocol)

The existing audio overlay polls the peer manager at most once per second and
now also shows:

```text
connected 2 / 8 · 3 nearby, not connected (cap)
```

`connected` is the live peer-manager count; `M` is computed by the pure helper
`client/src/realtime/meshIndicator.js` from **the client's own known avatar
positions** (existing world ref) and the live connection ids. Positions stay out
of React state; no event, field or library was added. `0` is rendered as `∞`.

---

## 5. Running `npm run mesh-check`

```bash
# self-contained: two real instances + real Redis if REDIS_URL is set
REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check

# against already-running servers (room must exist: npm run seed)
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001 --room=lobby
```

* Embedded mode (the default) starts throwaway Node instances on ephemeral
  ports, creates a throwaway room and removes it plus all Redis keys in a
  `finally`. **No MongoDB is needed**: the Day 12 two-instance harness injects
  its deterministic in-memory presence/room backing. Everything that enforces
  the policy — Socket.io gateway, `PeerGraph`, `EdgeStore`, Redis adapter and,
  with `REDIS_URL`, `RedisEdgeStore` — is the production code path.
* External mode needs a healthy `/health` on every URL and an existing room.
* Exit code is `0` only when every check passes, `1` otherwise. Numbers are
  measured, never synthesised.

Measurements printed by the run used for this document (Redis `6.2.14`, two
instances, cap 8 / drop 115):

```text
Connections per user and total edges (tight cluster, every pair <= 100 px)
config                             N   max  mean   edges  connect ev  signals  drops  settle  status
after (cap 8, drop 115)           10     8   7.2      36          76    36/36      0    1739  PASS
after (cap 8, drop 115)           20     8   7.3      73         168    73/73      0    2725  PASS
after (cap 8, drop 115)           50     8   7.6     190         672  190/190      0    5232  PASS
before (unlimited, drop = radius)  10     9     9      45          94    45/45      0    1712  PASS
before (unlimited, drop = radius)  20    19    19     190         402  190/190      0    2687  PASS
before (unlimited, drop = radius)  50    49    49    1225        3174  1225/1225    0    5206  PASS

Boundary: approach + 100 crossings of the 100 px edge
  after  drop=115px: first connect at 100 px; jitter connects=0, disconnects=0
  before drop=100px: first connect at 100 px; jitter connects=100, disconnects=100

Per-instance mesh counters (after suite)
  mesh-0-6lav5: edgesCreated=225 edgesRemoved=255 cappedRejections=1765 hysteresisHolds=2
  mesh-1-t9dnj: edgesCreated=234 edgesRemoved=203 cappedRejections=1991 hysteresisHolds=52

RESULT: PASS (37/37 checks passed)
```

Column notes: **drops** counts signals that were not delivered within 4 s (the
gateway drops a rate-limited signal silently, so an undelivered candidate is the
only observable drop); **settle** is wall-clock from the first join through the
walk to the target plus 700 ms without any edge event — it includes joining and
walking, not just the edge diff.

The 37 checks are: per N (10/20/50) degree ≤ cap, no edge beyond the drop
radius, one initiator + one shared generation per edge, no duplicate/self/
cross-room edge, each `joined` publishing both limits, first edge only at
≤ 100 px, the jitter result for each configuration, plus three cross-configuration
comparisons (cap bounds the mesh, hysteresis removes churn, no signal dropped).

## 6. Manual test with four browser windows

1. Start MongoDB, seed the rooms, then start the server with a small cap:

   ```bash
   cp .env.example .env
   # edit .env:
   #   MAX_PEERS_PER_USER=2
   #   PEER_DISCONNECT_RADIUS_PX=115
   npm run seed
   npm start
   npm run dev:client
   ```

2. Open **four** browser windows at `http://localhost:5173` (separate profiles,
   headphones, microphone or listen-only). Join the same room with four names
   and walk all four avatars into one small cluster (well under 100 px).
3. Expect the overlay in every window to read `connected 2 / 2` and to append
   `· 2 nearby, not connected (cap)` — each user holds two connections and the
   other two neighbours are explicitly shown as capped, not as a failure.
4. Walk one connected peer more than 115 px away: its row disappears, a
   `peer:disconnect` fires, and a waiting neighbour fills the free slot
   (`connected 2 / 2` again). Between 100 and 115 px the connection stays and
   the audio is already silent (Day 11 gain = 0 at 100 px).
5. Set `MAX_PEERS_PER_USER=0` and restart the server: the overlay reads
   `connected 3 / ∞` and all six edges form — the Day 12 mesh.

---

## 7. Verification status (honest)

* **Run here:** `npm run mesh-check` (embedded, two instances, real Redis
  `6.2.14`) → **PASS 37/37**; full server suite **136 passed / 0 failed / 32
  skipped** (168 tests) and client suite **151 passed / 0 failed / 0 skipped** with
  `REDIS_URL_TEST` set. The 32 skipped are the MongoDB-backed suites: this
  sandbox has no `mongod` and cannot download one (apt and `fastdl.mongodb.org`
  are unreachable), so *any* MongoDB-dependent test is **NOT VERIFIED here**;
  with a local MongoDB, skipped must be 0.
* **What is proven live:** the cap (Memory + Redis, including 200 concurrent
  creates around one hub), hysteresis and the approach boundary, nearest-first
  determinism, slot reclaim, the star no-thrash run, cross-instance cap and
  reclaim over real Redis, orphan sweep + reconcile, and the `joined` fields.
* **What is not verified:** audible two-window behaviour in a real browser (no
  browser binary), and the MongoDB-backed presence path. The mesh-check numbers
  above come from the in-memory presence backing, not MongoDB; the geospatial
  query itself is proven separately by the Day 7–12 MongoDB suites on a machine
  with `mongod`.
