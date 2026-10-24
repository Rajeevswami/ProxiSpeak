# Week 3 — Proximity Polish, Redis Scaling, and Bounded Mesh

Week 3 covers Days 11–14. Day 14 is a wrap-up only: hardening, regression coverage, dead-code/stale-text cleanup, documentation, and demo preparation. No Week 4 feature is included.

## Day 11 — Distance attenuation

- `client/src/audio/attenuation.js` implements the pure smoothstep curve: full volume through 30 px, fading to zero at the server's proximity radius.
- `client/src/audio/audioMixer.js` owns one shared `AudioContext`, per-peer source/gain chains, muted media-element attachment, smoothed gain updates, and teardown.
- `client/src/webrtc/peerManager.js` attaches remote tracks to the mixer. `client/src/webrtc/rtcStats.js` supplies connection state and inbound audio byte counts.
- The server includes `proximityRadiusPx` in `joined`; the overlay reports distance and volume without putting positions into per-frame React state.
- Pure attenuation, mixer, track, stats, and socket-payload tests run in Node. Actual audible output is not asserted by those tests.

## Day 12 — Optional Redis multi-instance scaling

- `MemoryEdgeStore` preserves the default single-instance path. `RedisEdgeStore` uses atomic Lua operations for shared edges, generations, caps, and cleanup.
- `@socket.io/redis-adapter` fans out room events across instances. Redis key prefixes isolate deployments and tests.
- Boot failure enters single-instance fallback; a mid-run outage enters `redis-degraded`; recovery reconciles local peer graphs. URLs are redacted in logs.
- Presence and orphan-edge sweeps use atomic claims and cursor-based `SCAN`. The scale checker uses real Socket.io clients and now waits for an offer, answer, **and valid ICE candidate**.
- Current verification used a real Redis 7.2.5 process. The two-instance test harness replaces MongoDB with its in-memory presence backing; that distinction is not hidden.

## Day 13 — Bounded mesh

- The default cap is 8 edges per user, enforced at both endpoints. Setting the cap to 0 retains unlimited behavior.
- Candidates are considered nearest-first with deterministic tie-breaking. Freed slots are reclaimed during sync.
- New edges use the 100 px connect radius; existing edges use the 115 px drop radius. The joined payload publishes `maxPeers` and `peerDisconnectRadiusPx`.
- `mesh-check` exercises N=10/20/50 clusters, degree and radius invariants, duplicate/self/cross-room prevention, initiator/generation consistency, boundary jitter, and signal relay.
- Embedded mode compares current and baseline configurations. External mode checks only the exact existing room and current configuration supplied by the running servers.

## Day 14 — Test gaps identified first

The audit began with these gaps, before changing implementation code:

1. Peer creation completing after local leave; saved WebRTC callbacks firing after teardown; stats reads finishing after unwatch.
2. Partial Web Audio and WebRTC setup failure cleanup; repeated mixer shutdown; suspended and Safari `interrupted` audio recovery.
3. External mesh checks inventing before/after rooms instead of checking an existing room and its current configuration.
4. Shutdown waiting for presence writes but not peer syncs; orphan-sweep timer overlap/drain coverage.
5. Single-instance boot cleanup when a restart receives a new random instance id.
6. Scale-check claiming WebRTC relay coverage without awaiting a valid ICE candidate.
7. Bidirectional server/client environment-example drift and concise URL/boolean validation errors.

## Day 14 — Fixes and regression evidence

Each newly reproduced defect has its own `fix:` commit and regression coverage. Short hashes below were checked with `git cat-file -t` and all resolve to `commit`.

| Commit | Correction | Regression coverage |
| --- | --- | --- |
| `b182735` | Keep peer names while a user still has other edges | `server/test/peerGraph.nameCache.test.js` |
| `951dad2` | Roll back an edge whose create finishes after local leave | `server/test/peerGraph.unit.test.js` |
| `b0b0e6f` | Ignore ICE/track/state callbacks from a torn-down peer generation | `client/test/webrtc.peerManager.test.js` |
| `8cc0b21` | Discard late stats after unwatch or replacement | `client/test/webrtc.rtcStats.test.js` |
| `d8fdb79` | Disconnect partially built audio chains after setup failure | `client/test/audio.audioMixer.test.js` |
| `0f92b2b` | Resume Safari's `interrupted` context as well as `suspended` | `client/test/audio.audioMixer.test.js` |
| `5a19ab8` | Use the real room/current config in external mesh-check | `server/test/mesh.config.test.js` plus real external run |
| `3be48c1` | Drain peer syncs before closing backing stores | `server/test/socket.shutdown.test.js` |
| `8118523` | Close and unregister partially initialized peer connections | `client/test/webrtc.peerManager.test.js` |
| `e5399f6` | Make the advertised page click actually resume blocked audio | `client/test/audio.audioMixer.test.js` |
| `c5a0091` | Await valid cross-instance ICE relay in scale-check | `server/test/redis.scale.integration.test.js` |
| `7dbdf8e` | Clear prior random-instance presence on single-instance restart | `server/test/presenceCleanup.unit.test.js` |

Hardening and cleanup commits:

- `4d5dd96` — production empty-`CLIENT_URL` HTTP CORS alignment.
- `a6c381e`, `635db42` — concise numeric, boolean, and URL configuration errors without values or stacks.
- `02b7c0a`, `9b85dd1` — bidirectional server and `VITE_*` example drift guards.
- `ad845d7` — the single-line paused-audio hint and pure predicate.
- `9ef2bc8` — non-overlapping/draining orphan sweep and concurrent mixer-close tests.
- `4b4f6a8` — removed the unused `isConnecting` helper and unnecessary exports; corrected package descriptions.

The audit also rechecked EdgeStore atomicity, Redis recovery/reconcile, presence claims, attenuation boundaries, overlay derivation, and audit output. The standalone spatial-audit CLI's `console` table is intentional command output, not an unlogged server code path. No additional production change was made without a reproduced defect.

## Verification on 2026-10-24

### Commands actually run

| Check | Actual result |
| --- | --- |
| `npm run install:all` | Passed; no dependency or lockfile change |
| `npm ci --prefix server && npm ci --prefix client` | Clean lockfile installs passed: 130 server packages and 74 client packages added |
| `npm test` | Server **188 tests: 131 passed, 57 skipped**; client **165/165 passed** |
| `PATH="/tmp/proxispeak-redis-src/src:$PATH" REDIS_URL_TEST="redis://127.0.0.1:6379" npm test` | Server **188 tests: 156 passed, 32 skipped**; client **165/165 passed** |
| `npm run build` | Vite production build passed; 80 modules transformed |
| `REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check` | **PASS 37/37** with two embedded instances and real Redis |
| Programmatic external `runMeshCheck` against two harness instances | **PASS 18/18**, exact `lobby` room, real Socket.io + Redis |
| Targeted `runScaleCheck` two-instance integration | **PASS 8/8**, including valid ICE candidate relay |
| Targeted lifecycle, shutdown, sweep, configuration, audio, and WebRTC suites | Passed after their individual fixes |

Real result excerpts:

```text
without services: server 131 passed / 57 skipped; client 165 passed / 0 skipped
with real Redis:  server 156 passed / 32 skipped; client 165 passed / 0 skipped
embedded mesh:    RESULT: PASS (37/37 checks passed)
external mesh:    RESULT: PASS (18/18 checks passed)
scale-check:      8/8 checks passed
```

Redis 7.2.5 was built outside the repository solely to provision the test service. Its `src` directory was placed on `PATH` because failure/recovery tests spawn `redis-server`. This added no project dependency.

The clean install reported **one high-severity server dependency advisory** and zero client vulnerabilities. Dependencies were not upgraded because Day 14 prohibits dependency changes; this is not claimed as a security-fix verification.

### NOT VERIFIED here

- MongoDB is not installed and could not be provisioned in the sandbox. The remaining **32 skips** in the Redis-backed run are MongoDB suites. A MongoDB+Redis zero-skip run was **not achieved**.
- The real MongoDB spatial audit (`npm run audit`), seed/server commands against MongoDB, and live Mongo geospatial performance remain unverified in this environment. The audit command was attempted and exited 1 with `ECONNREFUSED 127.0.0.1:27017`; it produced no audit result. Pure and mocked audit tests pass, but they are not presented as a real audit.
- The external scale/mesh harnesses use real Socket.io and Redis but in-memory presence backing. The CLI against two normal Mongo-backed server processes was not run end-to-end.
- No live two-browser microphone, audible attenuation, Safari interruption, or speaker-output check was performed. Browser claims in the demo are instructions, not test results.
- The approximately eight-minute demo has not been executed end-to-end. Its output markers are not captured transcripts.

## Scope boundary

No dependency, TypeScript, deployment, SFU/TURN, Express static-hosting, stereo-panning, obstacle-occlusion, room-persistence, or additional UI feature was added. Week 4 remains room persistence/obstacles, stereo panning, and 60 FPS work.
