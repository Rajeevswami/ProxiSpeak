# Requirements Trace — Through Week 3 (Day 16): Sound-Blocking Obstacles

Status date: **2026-10-27**. This trace maps each requirement from the company's four-week plan against the internship calendar week in which it was delivered (`Days 1–7 = Week 1`, `Days 8–14 = Week 2`, `Days 15–21 = Week 3`, `Days 22–28 = Week 4`) and distinguishes implementation/Node evidence from live MongoDB or browser evidence. Historical results are not reused as proof of a current live run.

- **DONE** means the requested implementation is present and its available current checks passed.
- **LIVE NOT VERIFIED** means the relevant external-service or browser path was not exercised here; it is not a failure claim.
- **MISSING** means the requirement has not been started yet.
- Exact Day 14 evidence is in `docs/WEEK3.md`; Day 14b additions, Room Persistence (`docs/ROOM_PERSISTENCE.md`), and Week 3 (Day 16) audio occlusion (`docs/OCCLUSION.md`) measurements are recorded below and in `CHANGELOG.md`.

| # | Requirement | Delivered in calendar week | Implementation | Tests / demonstration | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | W1 backend: WebSocket avatar-coordinate broadcast | Week 1 (Day 3) | `server/src/sockets/index.js`, `server/src/index.js` | `socket.integration.test.js`, `socket.validation.test.js`, `socket.race.test.js`; `npm run test:server` | DONE; live Mongo server NOT VERIFIED here |
| 2 | W1 backend: MongoDB geospatial schemas | Week 1 (Day 2) | `models/UserPresence.js`, `models/Room.js`, `db/mongo.js`, `utils/geo.js` | `mongo.test.js`, `geo.test.js`, `proximity.test.js`; `npm run seed` with MongoDB | DONE in code; live Mongo NOT VERIFIED here |
| 3 | W1 frontend: React + Canvas layer | Week 1 (Day 4) | `components/WorldCanvas.jsx`, `canvas/renderer.js`, `canvas/coords.js` | `renderer.test.js`, `coords.test.js`; `npm run test:client` | DONE |
| 4 | W1 frontend: smooth keyboard/mouse movement | Week 1 (Day 5) | `movement/`, `hooks/useMovement.js`, `hooks/useSocket.js` | `movement.test.js`, `worldState.test.js`; `docs/DEMO_WEEK1.md` | DONE in Node; live browser NOT VERIFIED here |
| 5 | W2 backend: `$near` proximity grouping | Week 1 (Day 7) | `services/proximityService.js` | `proximity.test.js`, `proximity.roster.test.js`; `npm run audit` with MongoDB | DONE in code; real audit NOT VERIFIED here |
| 6 | W2 backend: signal only nearby users | Week 2 (Day 8) | `services/peerGraph.js`, `services/proximityService.js`, `sockets/index.js` | `peerGraph.unit.test.js`, `peerGraph.integration.test.js`, `signal.validation.test.js` | DONE; Mongo integration cases skip here |
| 7 | W2 frontend: `getUserMedia` + P2P audio | Week 2 (Day 9) | `webrtc/localMedia.js`, `peerManager.js`, `remoteAudio.js`, `rtcStats.js`, `audio/audioMixer.js` | `client/test/webrtc.*.test.js`, `audio.audioMixer.test.js` | DONE in code/Node; audible browser path NOT VERIFIED |
| 8 | Mid-review spatial audit with latency target | Week 2 (Day 10) | `services/spatialAudit.js`, `scripts/audit.js`, `app.js`, `AUDIT_*` config | `spatialAudit.test.js`; `npm run audit -- --users=50 --samples=25 --seed=1` | DONE in code/pure tests; real Mongo audit NOT VERIFIED |
| 9 | Mid-review two-browser audio check | Week 2 (Days 8–9) | Day 8 signaling plus Day 9 browser media modules | Socket/WebRTC Node tests; manual `docs/DEMO_MIDREVIEW.md` | Signaling DONE; live hearing NOT VERIFIED |
| 10 | Geospatial engine (`$near`, `$geoWithin`) | Week 1 (Day 7) | `services/proximityService.js`, `utils/geo.js`, `models/UserPresence.js` | `geo.test.js`, `proximity.test.js`, `spatialAudit.test.js` | DONE in code; live Mongo NOT VERIFIED here |
| 11 | Socket.io signaling server | Week 1 (Day 3) / Week 2 (Day 8) | `sockets/index.js`, `services/peerGraph.js` | `socket.*.test.js`, `signal.validation.test.js` | DONE |
| 12 | 2D virtual world | Week 1 (Days 4–5) | `client/src/components/`, `canvas/`, `movement/`, `realtime/` | `npm run test:client`; `npm run build` | DONE; build passed |
| 13 | WebRTC audio connection | Week 2 (Day 9) | `client/src/webrtc/`, `client/src/audio/` | WebRTC/mixer/stats tests; `docs/DEMO_WEEK3.md` | DONE in code/Node; live media NOT VERIFIED |
| 14 | Day 10 fast whole-room clustering + cross-check | Week 2 (Day 10) | `computeClusters`, `computeClustersViaNear` in `services/proximityService.js` | `proximity.roster.test.js`, `spatialAudit.test.js` | DONE in available tests; live Mongo NOT VERIFIED here |
| 15 | Day 10 signal-burst headroom | Week 2 (Day 10) | `SOCKET_SIGNAL_BURST=200`, socket token bucket | `signal.ratelimit.headroom.test.js`, mesh signal-burst checks | DONE |
| 16 | Day 11 distance-based GainNode attenuation | Week 2 (Day 11) | `audio/attenuation.js`, `audio/audioMixer.js`, `hooks/useSocket.js`, `components/AudioStatus.jsx` | `audio.attenuation.test.js`, `audio.audioMixer.test.js`; `npm run build` | DONE in code/Node; audible fade NOT VERIFIED |
| 17 | Day 13 cap + hysteresis + nearest-first + reclaim + checker | Week 2 (Day 13) | `peerGraph.js`, both edge stores, `scripts/mesh-check.js`, `realtime/meshIndicator.js` | `mesh.config.test.js`, `peerGraph.mesh.test.js`, `mesh.twoInstance.test.js`; real Redis mesh-check | DONE: embedded **37/37**, external harness **18/18** |
| 18 | Day 12 Redis Pub/Sub + shared edge state + recovery | Week 2 (Day 12) | `db/redis.js`, `sockets/redisAdapter.js`, `redisEdgeStore.js`, `edgeSweep.js`, `scripts/scale-check.js` | `edgeStore.contract.test.js`, `redis.failure.test.js`, `redis.scale.integration.test.js` | DONE with real Redis: scale-check **8/8**; Mongo-backed CLI NOT VERIFIED |
| 19 | Day 14 production empty-`CLIENT_URL` HTTP CORS alignment | Week 2 (Day 14) | `server/src/app.js`, `utils/origin.js`, `.env.example` | `app.test.js`, `origin.test.js`, `socket.validation.test.js` | DONE; non-production defaults covered |
| 20 | Day 14 bidirectional config/example drift guards | Week 2 (Day 14) | `server/test/configDrift.test.js`, `.env.example`, `client/.env.example` | `node --test server/test/configDrift.test.js` | DONE; exact server and `VITE_*` key checks |
| 21 | Day 14 concise invalid-config errors | Week 2 (Day 14) | `server/src/config/index.js`, `utils/logger.js`, `utils/loggerCore.js` | `config.test.js`, `mesh.config.test.js` | DONE; invalid values/credentials are not echoed |
| 22 | Day 14 one-line paused-audio hint + recovery | Week 2 (Day 14) | `audio/audioPausedHint.js`, `audio/audioMixer.js`, `components/AudioStatus.jsx` | `audio.audioPausedHint.test.js`, `audio.audioMixer.test.js` | DONE in Node; browser autoplay/Safari NOT VERIFIED |
| 23 | Day 14 bug hunt + regressions | Week 2 (Day 14) | PeerGraph, EdgeStores, sweeps, Redis, mixer, stats, PeerManager, scale/mesh checkers | Fix-by-fix table in `docs/WEEK3.md`; all current suites | DONE; each reproduced defect has a named fix commit |
| 24 | Day 14 cleanup + coherent docs + demo | Week 2 (Day 14) | `README.md`, `docs/WEEK3.md`, `DEMO_WEEK3.md`, `LIMITATIONS.md`, `CHANGELOG.md`, this trace | Clean install, tests, build, real Redis checks; manual demo remains separate | DONE for docs/code; live demo NOT VERIFIED |
| 25 | Day 14b stale-edge race: reproduce, fence revisions, one bounded re-sync | Week 2 (Day 14b) | Both edge stores, `peerGraph.js`, `sockets/index.js` | `staleEdgeRace.test.js`, revision contract tests; deterministic gates, real sockets, 200 seeded interleavings per store | DONE with Memory + real Redis; live Mongo path NOT VERIFIED |
| 26 | Day 14b bounded edge validation + dependency remediation | Week 2 (Day 14b) | `edgeSweep.js`, `mesh-check.js`, `server/package-lock.json` | `edgeValidation.test.js`; scale/mesh checks; server/client `npm audit` | DONE; zero high/critical audit findings |
| 27 | Week 4: Shared layout validator for room obstacles | Week 3 (Day 15) | `server/src/validators/roomLayout.js`, `server/src/models/Room.js` | `server/test/roomLayout.validation.test.js` (21 tests) | DONE |
| 28 | Week 4: Layout revision on Room model with safe backfill | Week 3 (Day 15) | `server/src/models/Room.js`, `server/src/services/roomService.js`, `server/src/config/index.js`, `server/scripts/seed.js` | `server/test/config.test.js`, `server/test/configDrift.test.js` | DONE |
| 29 | Week 4: Atomic layout save with revision conflict detection | Week 3 (Day 15) | `server/src/services/roomService.js`, `server/src/utils/errors.js` | `server/test/roomPersistence.mongo.test.js` | DONE in code; live Mongo NOT VERIFIED here |
| 30 | Week 4: Room read API and token-guarded layout save API | Week 3 (Day 15) | `server/src/app.js` | `server/test/roomLayout.api.test.js` (12 tests) | DONE |
| 31 | Week 4: Realtime layout broadcast and multi-instance cache invalidation | Week 3 (Day 15) | `server/src/sockets/index.js`, `server/src/services/roomService.js` | `server/test/roomLayout.socket.test.js` (2 tests, real Socket.io & Redis) | DONE |
| 32 | Week 4: Room layout CLI and example blueprints | Week 3 (Day 15) | `server/scripts/room-layout.js`, `server/layouts/`, root and server `package.json` | `server/test/roomLayout.cli.test.js` (8 tests) | DONE |
| 33 | Week 4: Client-side live layout updates without re-renders | Week 3 (Day 15) | `client/src/realtime/worldState.js`, `client/src/hooks/useSocket.js` | `client/test/worldState.layout.test.js` (6 tests) | DONE |
| 34 | Week 4: Room persistence architecture documentation | Week 3 (Day 15) | `docs/ROOM_PERSISTENCE.md`, `README.md`, `CHANGELOG.md`, this trace | Documentation audit and verification checks | DONE |
| 35 | Week 4: Furniture obstacles which block sound | Week 3 (Day 16) | `client/src/audio/occlusion.js`, `client/src/audio/audioMixer.js`, `client/src/hooks/useSocket.js`, `client/src/components/AudioStatus.jsx` | `client/test/audio.occlusion.test.js` (20,000-case cross-check, mixer, caching, overlay), `client/scripts/occlusion-bench.js`; `docs/OCCLUSION.md` | DONE in code/Node; audible browser path NOT VERIFIED |
| 36 | Week 4: Stereo panning (left/right ear logic) | — | — | — | MISSING |
| 37 | Week 4: 60 FPS rendering loop / performance polish | — | — | — | MISSING |

## Day 14 commit evidence

The following short hashes were resolved with `git cat-file -t` and are commits in the current history:

```text
4d5dd96 02b7c0a a6c381e ad845d7 b182735 635db42 9b85dd1
951dad2 b0b0e6f 8cc0b21 d8fdb79 0f92b2b 5a19ab8 3be48c1
8118523 e5399f6 c5a0091 9ef2bc8 4b4f6a8 7dbdf8e
```

Their subjects and file-by-file mapping are recorded in `docs/WEEK3.md` and `CHANGELOG.md`. Earlier Day 1–13 hashes remain in the changelog; no hash or date is inferred from a document alone.

Day 14b delivered commit `b8a6bcf` (merged in `c3f927c`), which includes credential
redaction, race regressions, store revisions, graph/socket fencing, bounded sweep
validation, and the body-parser lockfile patch. Each resolves as a commit with
`git cat-file -t`; the documentation commit is intentionally not self-listed.

## Week 3 (Day 15) — Room Persistence (Company Plan Week 4) commit evidence

The following short hashes were resolved with `git cat-file -t` and are verified commits in the current history:

```text
d83289d 2be63a1 40055b7 2d31aea 775d9a0 6f8ef65 f5adde8 aa04e53
```

- `d83289d`: `feat: add shared layout validator for room obstacles`
- `2be63a1`: `feat: add layout revision to rooms with safe backfill`
- `40055b7`: `feat: save room layouts atomically with revision conflict detection`
- `2d31aea`: `feat: add room read API and token-guarded layout save API`
- `775d9a0`: `feat: broadcast layout updates to the room and invalidate caches across instances`
- `6f8ef65`: `feat: add room layout CLI and example layouts`
- `f5adde8`: `feat: apply live layout updates on the client`
- `aa04e53`: `test: cover validation, concurrency, guard, live sync and seed idempotency`

The documentation commit is intentionally not self-listed.

## Week 3 (Day 16) commit evidence

The following short hashes were resolved with `git cat-file -t` and are verified commits in the current history:

```text
35642cc fd2fbd1 afb9df3 faeff7c 424af75
```

- `35642cc`: `feat: add exact segment versus rectangle intersection for audio occlusion`
- `fd2fbd1`: `feat: compute sound transmission through blocking obstacles`
- `afb9df3`: `feat: apply obstacle transmission to peer gain in the audio mixer`
- `faeff7c`: `feat: show transmission in the audio overlay`
- `424af75`: `test: cover occlusion geometry, cross-check and mixer integration`

The documentation commit is intentionally not self-listed.

## Current verification boundary

- Clean lockfile installs (`npm ci` in both `server/` and `client/`) and the 81-module Vite 6.4.4 client production build passed. Server and client `npm audit` each reported zero high/critical and zero total vulnerabilities.
- Without services: server **191 passed / 77 skipped** (268 tests); client **179/179 passed** (0 skipped).
- With real Redis (`redis-server` 7.2.5): server **228 passed / 40 skipped** (268 tests); client **179/179 passed** (0 skipped).
- All 40 remaining skips are MongoDB integration tests (cleanly skipped with explicit NOT VERIFIED banner when `MONGO_URI_TEST` is unset; `mongod` could not be installed in this sandbox because `deb.debian.org` and `fastdl.mongodb.org` are outside outbound network allowlist).
- Week 3 (Day 16) occlusion geometry cross-checked across 20,000 random segment/rectangle pairs against an independent 4-edge + point-in-rectangle reference with 0 disagreements; 8 peers × 200 obstacles benchmarked at `p50 = 11.04 µs` / `p95 = 12.41 µs` (spread room, 99.69% AABB rejected) and `p50 = 11.21 µs` / `p95 = 13.67 µs` for a full `audioMixer.updateGains` tick.
- No browser is installed in this sandbox, so audible browser playback and live hearing drop across walls remain **NOT VERIFIED** here.
- Stereo panning and 60 FPS rendering work remain **MISSING** (not started).
