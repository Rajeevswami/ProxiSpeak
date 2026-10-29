# Requirements Trace — Through Week 3 (Day 18): Steady 60 FPS Canvas Rendering

Status date: **2026-10-29**. This trace maps each requirement from the company's four-week plan against both its **Company plan week** and the internship **Delivered in calendar week** (`Days 1–7 = Week 1`, `Days 8–14 = Week 2`, `Days 15–21 = Week 3`, `Days 22–28 = Week 4`), distinguishing implementation/Node evidence from live MongoDB or browser evidence. Historical results are not reused as proof of a current live run.

- **DONE** means the requested implementation is present and its available current checks passed.
- **NOT VERIFIED** means the relevant external-service (MongoDB) or real-browser/audio path was not exercised here; it is not a failure claim.
- **MISSING** means the requirement has not been started yet.
- Detailed evidence is in `docs/WEEK3.md`, `docs/ROOM_PERSISTENCE.md` (Week 3, Day 15), `docs/OCCLUSION.md` (Week 3, Day 16), `docs/PANNING.md` (Week 3, Day 17), `docs/RENDERING.md` (Week 3, Day 18), and `CHANGELOG.md`.

| # | Requirement | Company plan week | Delivered in calendar week | Implementation | Tests / demonstration | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | WebSocket server broadcasting avatar X/Y coordinates | Week 1 | Week 1 (Day 3) | `server/src/sockets/index.js`, `server/src/index.js` | `socket.integration.test.js`, `socket.validation.test.js`, `socket.race.test.js`; `npm run test:server` | DONE in code; live Mongo server NOT VERIFIED here |
| 2 | MongoDB geospatial schemas (`UserPresence` `2dsphere`, `Room`) | Week 1 | Week 1 (Day 2) | `models/UserPresence.js`, `models/Room.js`, `db/mongo.js`, `utils/geo.js` | `mongo.test.js`, `geo.test.js`, `proximity.test.js`; `npm run seed` with MongoDB | DONE in code; live Mongo NOT VERIFIED here |
| 3 | React frontend + HTML5 Canvas world layer | Week 1 | Week 1 (Day 4) | `components/WorldCanvas.jsx`, `canvas/renderer.js`, `canvas/coords.js` | `renderer.test.js`, `coords.test.js`; `npm run test:client` | DONE |
| 4 | Smooth keyboard/mouse movement and coordinate broadcast | Week 1 | Week 1 (Day 5) | `movement/`, `hooks/useMovement.js`, `hooks/useSocket.js` | `movement.test.js`, `worldState.test.js`; `docs/DEMO_WEEK1.md` | DONE in Node; live browser NOT VERIFIED here |
| 5 | MongoDB `$near` geospatial queries to group nearby users | Week 2 | Week 1 (Day 7) | `services/proximityService.js` | `proximity.test.js`, `proximity.roster.test.js`; `npm run audit` with MongoDB | DONE in code; real Mongo audit NOT VERIFIED here |
| 6 | Signal WebRTC offers/answers only within 100 px | Week 2 | Week 2 (Day 8) | `services/peerGraph.js`, `services/proximityService.js`, `sockets/index.js` | `peerGraph.unit.test.js`, `peerGraph.integration.test.js`, `signal.validation.test.js` | DONE; Mongo integration cases NOT VERIFIED here |
| 7 | `getUserMedia` capture + WebRTC P2P audio | Week 2 | Week 2 (Day 9) | `webrtc/localMedia.js`, `peerManager.js`, `remoteAudio.js`, `rtcStats.js`, `audio/audioMixer.js` | `client/test/webrtc.*.test.js`, `audio.audioMixer.test.js` | DONE in code/Node; audible browser path NOT VERIFIED |
| 8 | Spatial audit (filtering/clustering accuracy under 20 ms) | Mid-Project Review | Week 2 (Day 10) | `services/spatialAudit.js`, `scripts/audit.js`, `app.js`, `AUDIT_*` config | `spatialAudit.test.js`; `npm run audit -- --users=50 --samples=25 --seed=1` | DONE in code/pure tests; real Mongo audit NOT VERIFIED |
| 9 | Two browsers establishing WebRTC audio via signaling server | Mid-Project Review | Week 2 (Days 8–9) | Day 8 signaling plus Day 9 browser media modules | Socket/WebRTC Node tests; manual `docs/DEMO_MIDREVIEW.md` | Signaling DONE; live browser hearing NOT VERIFIED |
| 10 | Geospatial engine (`$near`, `$geoWithin` sphere helpers) | Week 2 | Week 1 (Day 7) | `services/proximityService.js`, `utils/geo.js`, `models/UserPresence.js` | `geo.test.js`, `proximity.test.js`, `spatialAudit.test.js` | DONE in code; live Mongo NOT VERIFIED here |
| 11 | Stateful Socket.io signaling gateway & rate limiting | Week 1 / Week 2 | Week 1 (Day 3) / Week 2 (Day 8) | `sockets/index.js`, `services/peerGraph.js` | `socket.*.test.js`, `signal.validation.test.js` | DONE |
| 12 | 2D virtual world client build & viewport letterboxing | Week 1 | Week 1 (Days 4–5) | `client/src/components/`, `canvas/`, `movement/`, `realtime/` | `npm run test:client`; `npm run build` | DONE; build passed |
| 13 | WebRTC peer lifecycle, generations & ICE queueing | Week 2 | Week 2 (Day 9) | `client/src/webrtc/`, `client/src/audio/` | WebRTC/mixer/stats tests; `docs/DEMO_WEEK3.md` | DONE in code/Node; live media NOT VERIFIED |
| 14 | Fast whole-room grid clustering + `$near` cross-check | Mid-Project Review | Week 2 (Day 10) | `computeClusters`, `computeClustersViaNear` in `services/proximityService.js` | `proximity.roster.test.js`, `spatialAudit.test.js` | DONE in pure tests; live Mongo NOT VERIFIED here |
| 15 | Signal-burst token-bucket headroom (`SOCKET_SIGNAL_BURST=200`) | Mid-Project Review | Week 2 (Day 10) | `SOCKET_SIGNAL_BURST=200`, socket token bucket | `signal.ratelimit.headroom.test.js`, mesh signal-burst checks | DONE |
| 16 | Web Audio `GainNode` hookup with smooth distance drop-off | Week 3 | Week 2 (Day 11) | `audio/attenuation.js`, `audio/audioMixer.js`, `hooks/useSocket.js`, `components/AudioStatus.jsx` | `audio.attenuation.test.js`, `audio.audioMixer.test.js`; `npm run build` | DONE in code/Node; audible fade NOT VERIFIED |
| 17 | Optimize WebRTC mesh: cap, hysteresis, nearest-first, checker | Week 3 | Week 2 (Day 13) | `peerGraph.js`, both edge stores, `scripts/mesh-check.js`, `realtime/meshIndicator.js` | `mesh.config.test.js`, `peerGraph.mesh.test.js`, `mesh.twoInstance.test.js`; real Redis `mesh-check` | DONE: embedded **37/37** with real Redis |
| 18 | Redis Pub/Sub for multi-instance Socket.io + shared EdgeStore | Week 3 | Week 2 (Day 12) | `db/redis.js`, `sockets/redisAdapter.js`, `redisEdgeStore.js`, `edgeSweep.js`, `scripts/scale-check.js` | `edgeStore.contract.test.js`, `redis.failure.test.js`, `redis.scale.integration.test.js` | DONE with real Redis; Mongo-backed CLI NOT VERIFIED |
| 19 | Production empty-`CLIENT_URL` HTTP & Socket.io CORS alignment | Week 3 | Week 2 (Day 14) | `server/src/app.js`, `utils/origin.js`, `.env.example` | `app.test.js`, `origin.test.js`, `socket.validation.test.js` | DONE |
| 20 | Bidirectional config / `.env.example` drift guards | Week 3 | Week 2 (Day 14) | `server/test/configDrift.test.js`, `.env.example`, `client/.env.example` | `node --test server/test/configDrift.test.js` | DONE |
| 21 | Concise one-line invalid-config errors without echoing secrets | Week 3 | Week 2 (Day 14) | `server/src/config/index.js`, `utils/logger.js`, `utils/loggerCore.js` | `config.test.js`, `mesh.config.test.js` | DONE |
| 22 | Browser paused-audio hint + gesture/visibility recovery | Week 3 | Week 2 (Day 14) | `audio/audioPausedHint.js`, `audio/audioMixer.js`, `components/AudioStatus.jsx` | `audio.audioPausedHint.test.js`, `audio.audioMixer.test.js` | DONE in Node; browser autoplay/Safari NOT VERIFIED |
| 23 | Week 3 stabilization bug hunt + lifecycle regressions | Week 3 | Week 2 (Day 14) | PeerGraph, EdgeStores, sweeps, Redis, mixer, stats, PeerManager, scale/mesh checkers | Fix-by-fix table in `docs/WEEK3.md`; all current suites | DONE |
| 24 | Coherent architecture, limitations & demo documentation | Week 3 | Week 2 (Day 14) | `README.md`, `docs/WEEK3.md`, `DEMO_WEEK3.md`, `LIMITATIONS.md`, `CHANGELOG.md`, this trace | Clean install, tests, build, real Redis checks | DONE for docs/code; live demo NOT VERIFIED |
| 25 | Stale-edge race: revision fencing + bounded re-sync | Week 3 | Week 2 (Day 14b) | Both edge stores, `peerGraph.js`, `sockets/index.js` | `staleEdgeRace.test.js`, revision contract tests (Memory + real Redis) | DONE with Memory + real Redis; live Mongo NOT VERIFIED |
| 26 | Bounded edge distance sweep + lockfile remediation | Week 3 | Week 2 (Day 14b) | `edgeSweep.js`, `mesh-check.js`, `server/package-lock.json` | `edgeValidation.test.js`; scale/mesh checks; `npm audit` | DONE (zero high/critical advisories) |
| 27 | Shared layout validator for room obstacles | Week 4 | Week 3 (Day 15) | `server/src/validators/roomLayout.js`, `server/src/models/Room.js` | `server/test/roomLayout.validation.test.js` (21 tests) | DONE |
| 28 | `layoutRevision` on `Room` model with safe legacy backfill | Week 4 | Week 3 (Day 15) | `server/src/models/Room.js`, `server/src/services/roomService.js`, `server/src/config/index.js`, `server/scripts/seed.js` | `server/test/config.test.js`, `server/test/configDrift.test.js` | DONE |
| 29 | Atomic layout save in MongoDB with revision conflict detection | Week 4 | Week 3 (Day 15) | `server/src/services/roomService.js`, `server/src/utils/errors.js` | `server/test/roomPersistence.mongo.test.js` | DONE in code; live Mongo NOT VERIFIED here |
| 30 | Public room read API and token-guarded layout save API | Week 4 | Week 3 (Day 15) | `server/src/app.js` | `server/test/roomLayout.api.test.js` (12 tests) | DONE |
| 31 | Realtime `room:layout` broadcast and Redis cache invalidation | Week 4 | Week 3 (Day 15) | `server/src/sockets/index.js`, `server/src/services/roomService.js` | `server/test/roomLayout.socket.test.js` (real Socket.io & Redis) | DONE |
| 32 | Room layout CLI (`room:show`, `room:save`) and example layouts | Week 4 | Week 3 (Day 15) | `server/scripts/room-layout.js`, `server/layouts/`, root and server `package.json` | `server/test/roomLayout.cli.test.js` (8 tests) | DONE |
| 33 | Client-side live `room:layout` updates without React re-renders | Week 4 | Week 3 (Day 15) | `client/src/realtime/worldState.js`, `client/src/hooks/useSocket.js` | `client/test/worldState.layout.test.js` (6 tests) | DONE |
| 34 | Room persistence architecture documentation | Week 4 | Week 3 (Day 15) | `docs/ROOM_PERSISTENCE.md`, `README.md`, `CHANGELOG.md`, this trace | Documentation audit and verification checks | DONE |
| 35 | Furniture obstacles which block sound (2D line-of-sight `GainNode`) | Week 4 | Week 3 (Day 16) | `client/src/audio/occlusion.js`, `client/src/audio/audioMixer.js`, `client/src/hooks/useSocket.js`, `client/src/components/AudioStatus.jsx` | `client/test/audio.occlusion.test.js` (20,000-case cross-check, mixer, caching, overlay), `client/scripts/occlusion-bench.js`; `docs/OCCLUSION.md` | DONE in code/Node; audible browser path NOT VERIFIED |
| 36 | 3D/stereo audio panning (left/right ear stereo separation) | Week 4 | Week 3 (Day 17) | `client/src/audio/panning.js`, `client/src/audio/audioMixer.js`, `client/src/components/AudioStatus.jsx`, `client/src/hooks/useSocket.js` | `client/test/audio.panning.test.js`, `client/test/audio.panningMixer.test.js`, `client/scripts/panning-report.js`; `docs/PANNING.md` | DONE in code/Node; audible left/right NOT VERIFIED |
| 37 | Canvas animations rendering pipeline & 60 FPS polish | Week 4 | Week 3 (Day 18) | `client/src/perf/frameStats.js`, `client/src/perf/perfReadout.js`, `client/src/canvas/staticLayer.js`, `client/src/canvas/renderer.js`, `client/src/canvas/frameLoop.js`, `client/src/canvas/coords.js`, `client/src/components/WorldCanvas.jsx` | `client/test/frameStats.test.js`, `staticLayer.test.js`, `renderEquivalence.test.js`, `frameLoop.test.js`, `client/scripts/render-report.js`; `docs/RENDERING.md` | Pipeline & Node checks DONE; real-browser steady 60 FPS NOT VERIFIED here |

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

## Week 3 (Day 17) commit evidence

The following short hashes were resolved with `git cat-file -t` and are verified commits in the current history:

```text
65c2b0e 291811c a5a1ba8 2f620d4
```

- `65c2b0e`: `feat: add stereo pan law for peer positions`
- `291811c`: `feat: add a stereo panner node to each peer audio chain`
- `a5a1ba8`: `feat: show pan side and strength in the audio overlay`
- `2f620d4`: `test: cover panning maths, mixer chain order and cleanup`

The documentation commit is intentionally not self-listed.

## Week 3 (Day 18) commit evidence

The following short hashes were resolved with `git cat-file -t` and are verified commits in the current history:

```text
bdad57b 9c92896 8c04f3e b36feef cccdac2 7656ef8 7c5544e 0a0ce6d 6eac3e3 085e705 df00b49 a776b21
```

- `bdad57b`: `docs: record the canvas render baseline before optimization`
- `9c92896`: `feat: add a frame statistics ring buffer`
- `8c04f3e`: `feat: cache the static canvas layer and rebuild it only when inputs change`
- `b36feef`: `refactor: split static and dynamic drawing and remove per-frame allocations`
- `cccdac2`: `feat: coalesce resize and watch device pixel ratio changes`
- `7656ef8`: `feat: add an opt-in performance readout`
- `7c5544e`: `perf: keep avatar screen coordinates in stack locals to avoid HeapNumber boxing`
- `0a0ce6d`: `test: cover frame stats, static layer, drawing equivalence and loop cleanup`
- `6eac3e3`: `docs: document the 60 FPS rendering pipeline (Week 3, Day 18) and update trace and changelog`
- `085e705`: `fix(canvas): isolate frame callback errors so a throw cannot kill the rAF loop`
- `df00b49`: `fix(canvas): prevent Math.round off-by-one overflow above MAX_BACKING_PIXELS`
- `a776b21`: `chore(canvas): remove unused exports from Week 3 (Day 18) modules`

The trailing documentation commit is intentionally not self-listed.

## Current verification boundary

- Clean lockfile installs (`npm ci` in both `server/` and `client/`) and the 86-module Vite 6.4.4 client production build passed on 2026-10-29.
- Without services: server **191 passed / 77 skipped** (268 tests); client **224/224 passed** (0 skipped).
- With real `redis-server` 6.2.14 (installed from PyPI `redislite` in `/tmp` outside the repository, because Debian and MongoDB download hosts are outside the sandbox allowlist): server **228 passed / 40 skipped** (268 tests); client **224/224 passed** (0 skipped); embedded two-instance Redis `mesh-check` **37/37 passed**.
- All 40 remaining skips are MongoDB integration tests (cleanly skipped with explicit NOT VERIFIED banner when `MONGO_URI_TEST` is unset; `mongod` could not be installed in this sandbox because `deb.debian.org` and `fastdl.mongodb.org` are outside outbound network allowlist).
- Week 3 (Day 16) occlusion geometry cross-checked across 20,000 random segment/rectangle pairs against an independent 4-edge + point-in-rectangle reference with 0 disagreements; 8 peers × 200 obstacles benchmarked at `p50 = 11.66 µs` / `p95 = 12.32 µs` (spread room, 99.69% AABB rejected).
- Week 3 (Day 17) stereo panning: `audio.panning.test.js` (12 tests incl. 100,000-pair property checks) and `audio.panningMixer.test.js` (10 tests). `node --expose-gc client/scripts/panning-report.js`: 8 peers × 200 obstacles full tick `p50 = 11.75 µs` / `p95 = 13.73 µs`; panning alone `p50 = 0.56 µs`; heap delta over 50,000 ticks `-97,824 B`.
- Week 3 (Day 18) 60 FPS Canvas rendering: `frameStats.test.js` (6 tests), `staticLayer.test.js` (4 tests), `renderEquivalence.test.js` (5 tests), and `frameLoop.test.js` (7 tests) — +23 new tests (**224/224** total client tests). `node --expose-gc client/scripts/render-report.js` (`60` avatars × `200` obstacles, fake 2D context — JS cost only): per-frame 2D operations reduced from `1,075` to `424` (constant `11 / 74 / 424` across `0..200` obstacles after 1 static build); retained heap delta over `50,000` frames `< 1 KB` (`~0.005 B/frame`).
- `npm audit`: client reports 0 vulnerabilities; server reports 1 **moderate** transitive `qs` advisory (`GHSA-6pq8-jhm2-2vcw`, 0 high/critical; `npm audit fix` without `--force` resolves `6.16.0 -> 6.16.2`, left untouched in client-only scope).
- No browser or audio output is available in this sandbox (`cdn.playwright.dev` and `deb.debian.org` unreachable under sandbox egress rules), so audible browser playback, hearing drop across walls, stereo headphone checks, and real-browser 60-second GPU 60 FPS pacing remain **NOT VERIFIED** here. Manual verification procedures are documented in `docs/OCCLUSION.md`, `docs/PANNING.md`, and `docs/RENDERING.md`.
