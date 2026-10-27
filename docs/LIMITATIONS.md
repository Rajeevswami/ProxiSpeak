# Known Limitations

Scope: end of Week 3, Day 16 (2026-10-27). These are limits of the current implementation and of the checks actually run in this environment—not claims about what a browser or another deployment must do.

## Audio and browser behavior

### Live audible audio is not verified here

Node tests use fake `RTCPeerConnection`, media, `AudioContext`, and stats objects. They verify protocol and cleanup logic, not microphone capture, codecs, network media, speakers, echo, or what a person hears. No live two-browser hearing test was performed for this wrap-up.

The scale and mesh checks use Socket.io clients and signaling payloads; they do not create 50 real browser peer connections. Their N=50 results are mesh-policy evidence, not browser performance or audio-quality measurements.

### STUN-only default; no provisioned TURN

The example ICE configuration contains public STUN only. Restrictive or symmetric NATs can prevent direct peer connections. No TURN service is provisioned or tested, and no TURN/SFU work is part of this wrap-up.

### No custom ICE restart policy

`PeerManager` deliberately does not auto-retry a failed peer connection. Later server graph lifecycle events may create a new generation, but there is no dedicated ICE-restart or media-recovery controller. Network mobility and long-lived browser sessions need separate validation.

### Autoplay and Safari interruption recovery need browser validation

The hint covers `suspended` and `interrupted`; Join, page pointer, and visible-tab paths call `resume()`, and these paths have unit tests. Real autoplay policies, phone calls, Bluetooth route changes, and Safari versions were not exercised. A user may still need another gesture or browser intervention.

### Audio quality and performance are unmeasured

Inbound byte counts are proof-of-life, not a latency, jitter, packet-loss, or bitrate guarantee. Mono distance attenuation and straight-line AABB obstacle gain occlusion (`GainNode` only) are implemented; stereo panning, frequency-dependent filtering (`BiquadFilterNode`), reverb, and diffraction are not. Sixty-FPS rendering and a dense real-audio mesh are not verified.

## Mesh behavior

### A closer newcomer does not evict an existing peer

At the default cap of 8, sync fills available slots nearest-first, but it does not replace an existing edge merely because a closer user appears later. A nearby user can remain unconnected until a slot opens or another sync changes the edge set. The overlay can report nearby-but-unconnected users.

### Unlimited mode does not scale like an SFU

`MAX_PEERS_PER_USER=0` preserves unlimited behavior for compatibility and tests. A full WebRTC mesh still grows quadratically in edges and places upload/CPU work in every browser. The cap bounds degree; it does not turn the system into an SFU.

### Obstacles use straight-line gain occlusion only; no movement collision

In Week 3 (Days 15–16, company plan Week 4), room layouts and furniture/wall obstacles are persisted in MongoDB with optimistic concurrency (`layoutRevision`), validated schemas, real-time live sync, and client-side straight-line `GainNode` sound occlusion (`docs/OCCLUSION.md`). Remaining limits:
- **Simplified ray model**: Occlusion tests a single straight line segment between peer centers using multiplicative `GainNode` transmission; there is no wave diffraction around corners, frequency-dependent low-pass filtering, or acoustic reflection/reverb.
- **No movement collision**: Avatars can freely move across or overlap obstacle rectangles (segments with an endpoint inside an obstacle still count that obstacle).
- **Stereo panning and 60 FPS loop**: Panning and steady 60 FPS rendering loop remain not started.

### No user authentication system (shared admin token only)

The room layout save API relies on a single shared secret `ROOM_ADMIN_TOKEN` provided via `x-room-admin-token` header. There is no user authentication, role-based access control, or token rotation mechanism. If `ROOM_ADMIN_TOKEN` is unset, editing is disabled server-wide (`403 editing_disabled`).

### Layout rate limits are instance-local in-memory

The REST layout save endpoint enforces an in-memory IP rate limiter (10 requests/minute). In clustered multi-instance deployments behind a load balancer without sticky sessions or distributed rate-limiting, rate limits are tracked per process rather than across the cluster.

## Redis and multi-instance operation

### Redis is optional, but normal operation still needs MongoDB

An empty `REDIS_URL` selects in-memory single-instance edge state. It does not replace MongoDB presence/geospatial storage. If MongoDB is unavailable, the normal server does not accept traffic.

### Degraded mode is not full multi-instance service

During Redis failure, already-established browser media is independent of Redis in principle, but cross-instance broadcasts and shared edge operations can be delayed or refused. Recovery reconciles current local users rather than restoring a historical Redis snapshot. Actual audible continuity during an outage was not browser-tested.

### Full Redis wipes do not preserve generations or edges

Recovery and tests rebuild safe current edges with appropriate new generations after a flush; they do not preserve the old Redis records. Redis persistence is an operations concern outside this repository.

### Rate limits and sockets are instance-local

Move/signal token buckets are not shared through Redis. Sticky sessions are required behind a load balancer because the joined socket and its session state belong to one instance. Redis Pub/Sub does not make a socket portable between processes.

### Crash cleanup and position validation are eventually consistent

Orphan-edge and presence sweeps run on intervals. A hard crash can leave temporary stale state until a sweep or restart cleanup runs. Single-instance boot now clears prior presence even when the process receives a new random instance id; multi-instance boot deliberately removes only its own rows.

Position revisions fence stale creates, but MongoDB presence and Redis revisions are not one transaction. In the documented write/bump window, an old-revision create can complete before the mover's post-bump sync removes it. Independently, the edge sweep validates at most 100 live edges per pass. Tests assert the quiescent no-beyond-drop-edge invariant; they do not claim that every intermediate instant is a consistent cross-store snapshot.

## HTTP, security, and deployment

### CORS is not authentication

The join protocol has no user authentication or authorization system. Origin checks limit browser cross-origin use; they do not establish identity or prevent a direct Socket.io client from attempting to join. Do not treat the prototype as a public production service.

### Dependency audits are point-in-time checks

Day 14b updated only the transitive `body-parser` lockfile entry from 1.20.8 to 1.20.9 within the existing Express range. Server and client `npm audit` then reported zero high/critical issues (and zero total vulnerabilities). This does not rule out future advisories or make the prototype deployment-ready.

### No deployment configuration or production hosting

There is no deployment manifest, Express static hosting of the client, SFU, or provisioned TURN. Reverse-proxy TLS, sticky sessions, monitoring, backup, and secret management are operational work not supplied here.

## Verification limits in this sandbox

- Without services: server **191 passed / 77 skipped** (268 tests); client **179/179 passed** (0 skipped).
- With real Redis: server **228 passed / 40 skipped** (268 tests); client **179/179 passed** (0 skipped).
- All 40 remaining skips require MongoDB. A local MongoDB+Redis zero-skip run was **not achieved** because MongoDB could not be provisioned.
- Real embedded Redis mesh-check passed **37/37**; the external real-Socket.io/Redis harness passed **18/18**; scale-check integration passed **8/8**. The external harnesses use in-memory presence backing.
- Fresh `npm ci` installs and the 80-module client build passed. Server and client audits each reported zero total vulnerabilities after the body-parser lockfile patch.
- The real MongoDB spatial audit, Mongo-backed server/seed commands, and live two-browser audio demo are **NOT VERIFIED** here.

### Measured three-run soak boundary

Three separate processes each ran 60 Socket.io users across two instances for
180 seconds with real Redis and in-memory presence. Every one of the 20 settled
samples per run had zero cap, beyond-drop, duplicate, self-edge, missing-endpoint,
socket-error, or logged-error violations. After disconnect, Redis keys, edges,
presence rows, sockets, rooms, cached names, and pending syncs were all zero.

| Run | Baseline RSS MB | First joined RSS MB | Last RSS MB | Post-cleanup RSS MB | Peak Redis keys during churn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 108.19 | 125.84 | 161.78 | 161.49 | 1,761 |
| 2 | 100.13 | 118.46 | 164.55 | 162.53 | 1,783 |
| 3 | 109.39 | 126.71 | 165.29 | 163.32 | 1,799 |

These are measurements from these fixtures, not proof of bounded memory or a
“no leak” claim. In particular, post-cleanup RSS remained above baseline even
though the tracked application state and Redis keys returned to zero.

See `docs/ROOM_PERSISTENCE.md` (Week 3, Day 15 — company plan Week 4), `docs/OCCLUSION.md` (Week 3, Day 16 — company plan Week 4), and `CHANGELOG.md` for specifications and evidence. Future work includes stereo panning and the 60 FPS rendering loop; none is claimed complete.
