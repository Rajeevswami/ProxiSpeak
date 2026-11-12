# Week 2 — Day 7: Proximity engine

## Scope and provenance

Built on `origin/Rajeev` tip `843c6e0` (Week 1, Days 1–6). All Day 7
implementation commits use the actual date 2026-10-16; no history was backdated.
The Week 1 reference remains a historical record in [WEEK1.md](WEEK1.md).
No client, dependency, HTTP route, signaling, audio or peer-graph changes.

## Internal service API

Import from `server/src/services/proximityService.js`:

- `findNearby(roomId, sessionId, radiusPx = config.proximity.radiusPx)` returns
  `[{ id, distancePx }]`, ordered by ascending authoritative pixel distance,
  then session id for equal distances. The public user id is the Socket.IO
  session id, not the MongoDB `_id`. Missing/stale self returns `[]`.
  Uses MongoDB `$near` with `$maxDistance` in metres on the existing
  `location_2dsphere` index. Same room only; self is excluded.
- `countWithin(roomId, { x, y }, radiusPx = config.proximity.radiusPx)` queries
  `$geoWithin` / `$centerSphere` using the existing radians helper and returns
  the exact pixel-circle count. Includes a user at the centre.
- `computeClusters(roomId, radiusPx = config.proximity.radiusPx)` returns arrays
  of session ids, including single-user clusters. It queries MongoDB for each
  user's neighbors, then walks connected components: A–B–C is one cluster even
  when A and C cannot hear each other directly. Empty room returns `[]`.
  Membership reflects stored positions; this is not a transaction snapshot
  across concurrent movement. Peer graph diffing is deliberately not included.

All functions measure elapsed query work with `performance.now()` and log only
at logger debug level (`LOG_LEVEL=debug`). No new default console output.
Radii must be finite, nonnegative and no larger than the configured world
diagonal (`Math.hypot(width, height)`). Centres must contain finite x/y numbers
inside that world. Room ids must use the normalized join identifier format;
session ids must be bounded strings, never MongoDB operator objects.

### Units and boundary semantics

The existing world transform is reused: by default **100 px = 10 m**
(`PIXELS_PER_METER=10`). `$near` uses metres; `$centerSphere` uses radians.
The tangent-plane mapping is not exactly spherical: candidate radii include the
worst longitude scale across the configured world's latitude span and 0.01 px
of numerical slack. The service then checks stored x/y with exact Euclidean
`distancePx <= radiusPx` and sorts by pixel distance, not spherical distance.
This preserves exact 99/100/101 px membership (also vertically and diagonally).
Coordinates are expected to be inside the configured world, as enforced by the
existing socket validation. No geospatial library is added.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXIMITY_RADIUS_PX` | `100` | Default service radius, pixels |
| `PRESENCE_CLEANUP_INTERVAL_MS` | `30000` | Sweep interval, milliseconds |
| `PRESENCE_TIMEOUT_MS` | `60000` | Maximum presence age, milliseconds |

Presence interval and timeout values must be between 1 and 2,147,483,647 ms;
overflowing Node timers are rejected rather than silently running every 1 ms.
| `INSTANCE_ID` | `node-local` at Day 7; random per process in the current code | Presence-row owner id |

**Assign a distinct, stable `INSTANCE_ID` to every simultaneous server instance.**
At Day 7, `node-local` replaced the older PID fallback and was intentionally
stable for a default single process. The current code instead generates a fresh
random id when `INSTANCE_ID` is unset, so the historical `node-local` value must
not be presented as today's default. Current single-instance boot cleanup removes
rows left by earlier process ids; multi-instance cleanup removes only its own
rows. Never reuse an explicit id while its previous process is running. This is
ownership groundwork, not cross-instance Socket.IO broadcast support.

## Presence lifecycle

- Join creates `lastSeen`; accepted moves refresh it along with x/y and GeoJSON.
- Engine.IO's existing ping/pong heartbeat refreshes `lastSeen` for joined idle
  sockets. No new client event, polling framework or dependency is needed.
- Every proximity read and join snapshot filters out rows older than the
  timeout immediately, without waiting for the next sweep.
- The periodic sweep examines only its own instance's rows. Each deletion is
  scoped to the row's `_id`, room and instance and atomically rechecks age, so a
  heartbeat after candidate selection prevents deletion. A successful deletion
  emits `user:left { id }` to that row's room, never another room.
- Sweeps cannot overlap. Shutdown clears the interval, waits for an active
  sweep, closes sockets, drains heartbeat/disconnect writes, then closes MongoDB.
- This is application-level expiry, not a MongoDB TTL index: explicit deletion
  is required to broadcast `user:left`. Other-instance stale rows are filtered
  out of reads but are never deleted by this instance's sweeper.

Keep timeout above Engine.IO's heartbeat cadence and expected database/network
latency (default Engine.IO ping interval is 25 s). Aggressively small values can
expire healthy idle clients. Redis and distributed fan-out remain later work.

## Verification and exact rerun commands

Fresh `npm ci --prefix server` and `npm ci --prefix client` succeeded with zero
reported vulnerabilities. `npm run build --prefix client` succeeded (Vite 6.4.4,
70 modules). Root `npm test` runs both suites:

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Server | 34 | 0 | 17 |
| Client | 99 | 0 | 0 |

**NOT VERIFIED against real MongoDB in this environment:** no `mongod` executable,
no supplied test URI, local connection refused. The 17 skips are 11 existing
Week 1 DB/socket integration tests and 6 Day 7 DB tests. Therefore exact
geospatial correctness, cleanup DB behavior, index explain, real DB-backed
join/move/disconnect regression behavior, and query p50/p95 are NOT VERIFIED.
No measured timings are claimed.

On a machine with MongoDB running locally (tests create and drop only their own
uniquely named test databases):

```sh
npm ci --prefix server
npm ci --prefix client
MONGO_URI_TEST=mongodb://127.0.0.1:27017/proxispeak npm test
MONGO_URI_TEST=mongodb://127.0.0.1:27017/proxispeak node --test server/test/proximity.test.js
npm run build --prefix client
```

Require **zero skips** locally. The timing test warms both operations, samples
20 calls each with 50 users, prints actual p50/p95 milliseconds, and asserts
p95 < 100 ms (target well below 20 ms). Correctness tests use a reproducible
200-user random fixture with 20 randomly selected centres, exact boundaries,
room isolation, self exclusion, empty/single rooms, counts, connected components
and movement. Cleanup tests cover live-only reads, heartbeat refresh, fresh-row
survival, stale broadcasts and boot ownership; explain asserts the 2dsphere
winning plan and no COLLSCAN. The timer stop function is exercised as well.

## Next, not implemented

Day 8: peer graph and WebRTC signaling events within the proximity radius.
