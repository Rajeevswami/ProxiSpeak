# Requirements Trace — ProxiSpeak Geospatial Proximity Audio Ecosystem

Status date: **2026-10-31**. This trace maps each requirement from the company's plan against its **Company plan week** while leaving **Delivered in calendar week** empty to be filled from the real push dates, distinguishing implementation/Node/Redis evidence from live MongoDB or browser evidence. Historical results are not reused as proof of a current live run.

- **DONE** means the requested implementation is present and its available current checks passed.
- **NOT VERIFIED** means the relevant external-service (MongoDB) or real-browser/audio path was not exercised here; it is not a failure claim.
- **PARTIAL** means a subset of the requirement is verified in Node/Redis while live MongoDB or browser media verification remains pending.
- **MISSING** means the requirement has not been started yet.
- Detailed feature evidence is in `docs/ROOM_PERSISTENCE.md`, `docs/OCCLUSION.md`, `docs/PANNING.md`, `docs/RENDERING.md`, `docs/DEPLOY.md`, `docs/DEMO_FINAL.md`, and `CHANGELOG.md`.

| # | Requirement | Company plan week | Delivered in calendar week | Implementation | Tests / command | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | WebSocket server broadcasting avatar X/Y coordinates | Week 1 | | `server/src/sockets/index.js`, `server/src/index.js` | `server/test/socket.integration.test.js`, `socket.validation.test.js`, `socket.race.test.js`; `npm run test:server` | DONE in code; live Mongo server NOT VERIFIED here (`mongod` unavailable in sandbox) |
| 2 | MongoDB geospatial schemas (`UserPresence` `2dsphere`, `Room`) | Week 1 | | `server/src/models/UserPresence.js`, `models/Room.js`, `db/mongo.js`, `utils/geo.js` | `server/test/mongo.test.js`, `geo.test.js`, `proximity.test.js`; `npm run seed` | DONE in code; live Mongo NOT VERIFIED here (`mongod` unavailable in sandbox) |
| 3 | React frontend + HTML5 Canvas world layer | Week 1 | | `client/src/components/WorldCanvas.jsx`, `canvas/renderer.js`, `canvas/coords.js` | `client/test/renderer.test.js`, `coords.test.js`; `npm run test:client` | DONE |
| 4 | Smooth keyboard/mouse movement and coordinate broadcast | Week 1 | | `client/src/movement/`, `hooks/useMovement.js`, `hooks/useSocket.js` | `client/test/movement.test.js`, `worldState.test.js`; `npm run test:client` | DONE in Node; live browser NOT VERIFIED here (no browser binary in sandbox) |
| 5 | MongoDB `$near` geospatial queries to group nearby users | Week 2 | | `server/src/services/proximityService.js` | `server/test/proximity.test.js`, `proximity.roster.test.js`; `npm run audit` | DONE in code; real Mongo `$near` execution NOT VERIFIED here (`mongod` unavailable) |
| 6 | Signal WebRTC offers/answers only within 100 px | Week 2 | | `server/src/services/peerGraph.js`, `services/proximityService.js`, `sockets/index.js` | `server/test/peerGraph.unit.test.js`, `peerGraph.integration.test.js`, `signal.validation.test.js`; `npm run test:server` | DONE in unit/Redis tests; Mongo integration cases NOT VERIFIED here |
| 7 | `getUserMedia` capture + WebRTC P2P audio | Week 2 | | `client/src/webrtc/localMedia.js`, `peerManager.js`, `remoteAudio.js`, `rtcStats.js`, `audio/audioMixer.js` | `client/test/webrtc.*.test.js`, `audio.audioMixer.test.js`; `npm run test:client` | DONE in code/Node; audible browser path NOT VERIFIED here (no browser/audio hardware) |
| 8 | Spatial audit (filtering/clustering accuracy under 20 ms) | Mid-Project Review | | `server/src/services/spatialAudit.js`, `scripts/audit.js`, `app.js`, `AUDIT_*` config | `server/test/spatialAudit.test.js`; `npm run audit -- --users=50 --samples=25 --seed=1` | DONE in code/pure tests; real Mongo audit NOT VERIFIED here (`mongod` unavailable) |
| 9 | Two browsers establishing WebRTC audio via signaling server | Mid-Project Review | | `server/src/sockets/index.js`, `client/src/webrtc/`, `docs/DEMO_MIDREVIEW.md` | `server/test/peerGraph.unit.test.js`, `client/test/webrtc.peerManager.test.js`; `npm test` | Signaling DONE; live two-browser hearing NOT VERIFIED here (no browser in sandbox) |
| 10 | Geospatial engine (`$near`, `$geoWithin` sphere helpers) | Week 2 | | `server/src/services/proximityService.js`, `utils/geo.js`, `models/UserPresence.js` | `server/test/geo.test.js`, `proximity.test.js`, `spatialAudit.test.js`; `npm run test:server` | DONE in code/pure math; live Mongo NOT VERIFIED here |
| 11 | Stateful Socket.io signaling gateway & rate limiting | Week 1 / Week 2 | | `server/src/sockets/index.js`, `services/peerGraph.js`, `utils/rateLimiter.js` | `server/test/socket.*.test.js`, `signal.validation.test.js`; `npm run test:server` | DONE |
| 12 | 2D virtual world client build & viewport letterboxing | Week 1 | | `client/src/components/`, `canvas/`, `movement/`, `realtime/` | `npm run test:client`; `npm run build` | DONE |
| 13 | WebRTC peer lifecycle, generations & ICE queueing | Week 2 | | `client/src/webrtc/`, `client/src/audio/` | `client/test/webrtc.*.test.js`; `npm run test:client` | DONE in code/Node; live media NOT VERIFIED here |
| 14 | Fast whole-room grid clustering + `$near` cross-check | Mid-Project Review | | `computeClusters`, `computeClustersViaNear` in `server/src/services/proximityService.js` | `server/test/proximity.roster.test.js`, `spatialAudit.test.js`; `npm run test:server` | DONE in pure tests; live Mongo NOT VERIFIED here |
| 15 | Signal-burst token-bucket headroom (`SOCKET_SIGNAL_BURST=200`) | Mid-Project Review | | `server/src/config/index.js`, `sockets/index.js` | `server/test/signal.ratelimit.headroom.test.js`; `node --test server/test/signal.ratelimit.headroom.test.js` | DONE |
| 16 | Web Audio `GainNode` hookup with smooth distance drop-off | Week 3 | | `client/src/audio/attenuation.js`, `audio/audioMixer.js`, `hooks/useSocket.js`, `components/AudioStatus.jsx` | `client/test/audio.attenuation.test.js`, `audio.audioMixer.test.js`; `npm run test:client` | DONE in code/Node; audible fade NOT VERIFIED here |
| 17 | Optimize WebRTC mesh: cap, hysteresis, nearest-first, checker | Week 3 | | `server/src/services/peerGraph.js`, `edgeStore.js`, `redisEdgeStore.js`, `scripts/mesh-check.js`, `client/src/realtime/meshIndicator.js` | `server/test/mesh.config.test.js`, `peerGraph.mesh.test.js`, `mesh.twoInstance.test.js`; `REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check` | DONE: embedded **37/37** with real Redis |
| 18 | Redis Pub/Sub for multi-instance Socket.io + shared EdgeStore | Week 3 | | `server/src/db/redis.js`, `sockets/redisAdapter.js`, `services/redisEdgeStore.js`, `services/edgeSweep.js`, `scripts/scale-check.js` | `server/test/edgeStore.contract.test.js`, `redis.failure.test.js`, `redis.scale.integration.test.js`; `REDIS_URL_TEST="redis://127.0.0.1:6379" npm run test:server` | DONE with real Redis; Mongo-backed `scale-check` CLI NOT VERIFIED here |
| 19 | Production empty-`CLIENT_URL` HTTP & Socket.io CORS alignment | Week 3 | | `server/src/app.js`, `utils/origin.js`, `.env.example` | `server/test/app.test.js`, `origin.test.js`, `socket.validation.test.js`; `npm run test:server` | DONE |
| 20 | Bidirectional config / `.env.example` drift guards | Week 3 | | `server/test/configDrift.test.js`, `.env.example`, `client/.env.example` | `node --test server/test/configDrift.test.js` | DONE |
| 21 | Concise one-line invalid-config errors without echoing secrets | Week 3 | | `server/src/config/index.js`, `utils/logger.js`, `utils/loggerCore.js` | `server/test/config.test.js`, `mesh.config.test.js`; `node --test server/test/config.test.js` | DONE |
| 22 | Browser paused-audio hint + gesture/visibility recovery | Week 3 | | `client/src/audio/audioPausedHint.js`, `audio/audioMixer.js`, `components/AudioStatus.jsx` | `client/test/audio.audioPausedHint.test.js`, `audio.audioMixer.test.js`; `npm run test:client` | DONE in Node; browser autoplay/Safari NOT VERIFIED here |
| 23 | Mesh & cluster lifecycle stabilization | Week 3 | | `PeerGraph`, `EdgeStore`, `RedisEdgeStore`, sweeps, Redis connector, mixer, stats, `PeerManager` | `npm test` (with and without `REDIS_URL_TEST`) | DONE |
| 24 | Architecture, limitations & demo documentation | Week 3 / Week 4 | | `README.md`, `docs/WEEK3.md`, `docs/DEMO_WEEK3.md`, `docs/DEMO_FINAL.md`, `docs/LIMITATIONS.md`, `docs/INDEX.md`, `CHANGELOG.md`, this trace | `npm run build && npm test` | DONE for docs/code; live browser/Mongo demo NOT VERIFIED here |
| 25 | Stale-edge race: revision fencing + bounded re-sync | Week 3 | | `server/src/services/edgeStore.js`, `redisEdgeStore.js`, `peerGraph.js`, `sockets/index.js` | `server/test/staleEdgeRace.test.js`, `edgeStore.contract.test.js` (Memory + real Redis) | DONE with Memory + real Redis; live Mongo NOT VERIFIED here |
| 26 | Bounded edge distance sweep + dependency audit remediation | Week 3 / Week 4 | | `server/src/services/edgeSweep.js`, `scripts/mesh-check.js`, `server/package-lock.json`, `client/package-lock.json` | `server/test/edgeValidation.test.js`; `npm audit --prefix server && npm audit --prefix client` | DONE (`0` vulnerabilities in both `server` and `client`) |
| 27 | Shared layout validator for room obstacles | Week 4 | | `server/src/validators/roomLayout.js`, `server/src/models/Room.js` | `node --test server/test/roomLayout.validation.test.js` (21 tests) | DONE |
| 28 | `layoutRevision` on `Room` model with safe legacy backfill | Week 4 | | `server/src/models/Room.js`, `services/roomService.js`, `config/index.js`, `scripts/seed.js` | `node --test server/test/roomLayout.validation.test.js server/test/config.test.js server/test/configDrift.test.js` | DONE |
| 29 | Atomic layout save in MongoDB with revision conflict detection | Week 4 | | `server/src/services/roomService.js`, `utils/errors.js` | `server/test/roomPersistence.mongo.test.js`, `roomLayout.api.test.js` | DONE in code/API tests; live Mongo concurrency test NOT VERIFIED here |
| 30 | Public room read API and token-guarded layout save API | Week 4 | | `server/src/app.js` | `node --test server/test/roomLayout.api.test.js` (12 tests) | DONE |
| 31 | Realtime `room:layout` broadcast and Redis cache invalidation | Week 4 | | `server/src/sockets/index.js`, `services/roomService.js` | `REDIS_URL_TEST="redis://127.0.0.1:6379" node --test server/test/roomLayout.socket.test.js` (6 tests) | DONE (verified with real Socket.io & real Redis) |
| 32 | Room layout CLI (`room:show`, `room:save`) and example layouts | Week 4 | | `server/scripts/room-layout.js`, `server/layouts/`, root and server `package.json` | `node --test server/test/roomLayout.cli.test.js` (8 tests); `npm run room:save -- --room lobby --file server/layouts/valid-office.json --dry-run` | DONE for CLI/dry-run; live Mongo save NOT VERIFIED here |
| 33 | Client-side live `room:layout` updates without React re-renders | Week 4 | | `client/src/realtime/worldState.js`, `hooks/useSocket.js` | `node --test client/test/worldState.layout.test.js` (6 tests) | DONE |
| 34 | Room persistence architecture documentation | Week 4 | | `docs/ROOM_PERSISTENCE.md`, `README.md`, `CHANGELOG.md`, this trace | Documentation review and test verification | DONE |
| 35 | Furniture obstacles which block sound (2D line-of-sight `GainNode`) | Week 4 | | `client/src/audio/occlusion.js`, `audio/audioMixer.js`, `hooks/useSocket.js`, `components/AudioStatus.jsx` | `node --test client/test/audio.occlusion.test.js` (20,000-case cross-check, mixer, caching, overlay), `node client/scripts/occlusion-bench.js`; `docs/OCCLUSION.md` | DONE in code/Node; audible browser path NOT VERIFIED here |
| 36 | 3D/stereo audio panning (left/right ear stereo separation) | Week 4 | | `client/src/audio/panning.js`, `audio/audioMixer.js`, `components/AudioStatus.jsx`, `hooks/useSocket.js` | `node --test client/test/audio.panning.test.js client/test/audio.panningMixer.test.js`, `node --expose-gc client/scripts/panning-report.js`; `docs/PANNING.md` | DONE in code/Node; audible left/right NOT VERIFIED here |
| 37 | Canvas animations rendering pipeline & 60 FPS polish | Week 4 | | `client/src/perf/frameStats.js`, `perf/perfReadout.js`, `canvas/staticLayer.js`, `canvas/renderer.js`, `canvas/frameLoop.js`, `canvas/coords.js`, `components/WorldCanvas.jsx` | `node --test client/test/frameStats.test.js client/test/staticLayer.test.js client/test/renderEquivalence.test.js client/test/frameLoop.test.js`, `node --expose-gc client/scripts/render-report.js`; `docs/RENDERING.md` | Pipeline, Node checks & 60s Headless Chromium (`fps 60 | frame p95 16.7 ms | work p95 0.3 ms | dropped 0`) DONE; physical hardware GPU/monitor 60 FPS NOT VERIFIED here |
| 38 | Single-origin production serving (`client/dist`) & deployment preparation | Final Project Review | | `server/src/app.js`, `client/src/config.js`, `package.json`, `railway.json`, `docs/DEPLOY.md` | `node --test server/test/app.test.js` (14 tests incl. static, immutable headers, SPA fallback, `/api/unknown` 404, `/socket.io`, path traversal, missing `dist`, `HEAD`); `npm run build` | DONE (local production HTTP + static + Socket.io smoke test verified; live Atlas/Railway cloud deploy NOT VERIFIED here) |
| 39 | Production hardening (`npm audit fix`, concise model validation errors, Redis-outage move `WARN` level, dead-code removal) | Final Project Review | | `server/src/models/Room.js`, `server/src/sockets/index.js`, `server/package-lock.json`, `client/package-lock.json` | `npm audit --prefix server && npm audit --prefix client`; `node --test server/test/roomLayout.validation.test.js`; `REDIS_URL_TEST="redis://127.0.0.1:6379" node --test server/test/redis.failure.test.js` | DONE |
| 40 | Final Target 1: Highly scalable, stateful geospatial server managing complex P2P routing logic | Final Project Review | | `server/src/services/proximityService.js`, `peerGraph.js`, `edgeStore.js`, `redisEdgeStore.js`, `roomService.js`, `sockets/index.js`, `db/redis.js` | `REDIS_URL_TEST="redis://127.0.0.1:6379" npm run test:server` (234 passed, 40 Mongo-dependent skipped); `REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check` (37/37 PASS) | PARTIAL: DONE in code, Node, and real two-instance Redis; live MongoDB `$near` execution NOT VERIFIED here (`mongod` unavailable) |
| 41 | Final Target 2: Immersive, physics-aware communication platform demonstrating advanced browser audio manipulation | Final Project Review | | `client/src/audio/attenuation.js`, `occlusion.js`, `panning.js`, `audioMixer.js`, `webrtc/peerManager.js`, `canvas/staticLayer.js`, `canvas/renderer.js`, `canvas/frameLoop.js` | `npm run test:client` (224/224 passed); `node client/scripts/occlusion-bench.js`; `node --expose-gc client/scripts/panning-report.js`; `node --expose-gc client/scripts/render-report.js` | PARTIAL: DONE in code and Node tests/benchmarks; live browser audible output and GPU 60 FPS pacing NOT VERIFIED here (no browser in sandbox) |

## Commit Evidence by Feature

Every short commit hash listed below has been verified as a real commit object in the repository history using `git cat-file -t <hash>`:

### Stabilization and Stale-Edge Fencing

```text
4d5dd96 02b7c0a a6c381e ad845d7 b182735 635db42 9b85dd1
951dad2 b0b0e6f 8cc0b21 d8fdb79 0f92b2b 5a19ab8 3be48c1
8118523 e5399f6 c5a0091 9ef2bc8 4b4f6a8 7dbdf8e b8a6bcf
```

### Room Persistence and Live Layout Sync

```text
d83289d 2be63a1 40055b7 2d31aea 775d9a0 6f8ef65 f5adde8 aa04e53
fed63d7 0199b04 9a40eae c120ff7 4e26716
```

### Sound-Blocking Obstacles (2D Acoustic Occlusion)

```text
35642cc fd2fbd1 afb9df3 faeff7c 424af75 ea9150e
```

### Stereo Audio Panning

```text
65c2b0e 291811c a5a1ba8 2f620d4 c584a73
```

### Steady 60 FPS Canvas Rendering Pipeline

```text
bdad57b 9c92896 8c04f3e b36feef cccdac2 7656ef8 7c5544e 0a0ce6d
6eac3e3 085e705 df00b49 a776b21 a68ef86 3f530ea
```

### Single-Origin Production Serving, Deployment Preparation, and Hardening

```text
b50c235 13e7fdf 4feb253 a7371c8 dae4910 8b16239 7fff589 a04cb33
```

- `b50c235`: `feat(server): serve built client static assets and SPA fallback on the same origin`
- `13e7fdf`: `build: install all packages in root build script and add railway.json`
- `4feb253`: `test(server): cover static serving, SPA fallback, path traversal and missing dist`
- `a7371c8`: `docs(deploy): add single-origin production serving and Atlas/Railway deployment guide`
- `dae4910`: `fix(deps): patch moderate qs and vite advisories via npm audit fix`
- `8b16239`: `fix(server): avoid dumping obstacle objects in Room schema validation errors`
- `7fff589`: `fix(server): log failed move during Redis outage at WARN instead of ERROR`
- `a04cb33`: `chore: remove unused internal exports and unused script imports`

*(The trailing documentation commit is intentionally not self-listed.)*

## Current Verification Boundary (`2026-10-31`)

- Clean full build (`npm run build`, running `npm run install:all && npm --prefix client run build`) succeeded with Vite `6.4.5` (86 modules).
- Without services: server **197 passed / 77 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests).
- With real `redis-server` `6.2.14` (`REDIS_URL_TEST="redis://127.0.0.1:6399"`): server **234 passed / 40 skipped** (`274` tests); client **224 passed / 0 skipped** (`224` tests); embedded two-instance Redis `mesh-check` **37/37 passed**.
- All `40` remaining skips are MongoDB integration tests (cleanly skipped with explicit `NOT VERIFIED` banner when `MONGO_URI_TEST` is unset; `mongod` could not be installed in this sandbox because `deb.debian.org` and `fastdl.mongodb.org` are outside the sandbox outbound network allowlist).
- Single-origin production smoke test (`NODE_ENV=production CLIENT_URL=` on `0.0.0.0`): verified `GET /` (`200 text/html`, `Cache-Control: no-cache`), `GET /assets/index-DuXB0dlR.js` (`200`, `Cache-Control: public, max-age=31536000, immutable`), `GET /health` (`200 application/json`), `GET /api/unknown` (`404 application/json`), and real `socket.io-client` WebSocket connection on the shared port.
- `npm audit`: both `npm audit --prefix server` and `npm audit --prefix client` report **`0` vulnerabilities**.
- No browser or audio hardware is available in this sandbox (`cdn.playwright.dev` and `deb.debian.org` unreachable under sandbox egress rules), so audible browser playback, hearing drop across walls, stereo headphone separation, and real-browser 60-second GPU 60 FPS pacing remain **NOT VERIFIED** here. Manual verification procedures are documented in `docs/DEMO_FINAL.md`, `docs/OCCLUSION.md`, `docs/PANNING.md`, and `docs/RENDERING.md`.
