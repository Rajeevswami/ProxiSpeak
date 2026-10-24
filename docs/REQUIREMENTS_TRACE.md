# Requirements Trace — Through Week 3, Day 14

Status date: **2026-10-24**. This trace describes the current checkout and distinguishes implementation/Node evidence from live MongoDB or browser evidence. Historical results are not reused as proof of a current live run.

- **DONE** means the requested implementation is present and its available current checks passed.
- **LIVE NOT VERIFIED** means the relevant external-service or browser path was not exercised here; it is not a failure claim.
- Exact Day 14 evidence, including all fix hashes and test counts, is in `docs/WEEK3.md`.

| # | Requirement | Implementation | Tests / demonstration | Status |
| --- | --- | --- | --- | --- |
| 1 | W1 backend: WebSocket avatar-coordinate broadcast | `server/src/sockets/index.js`, `server/src/index.js` | `socket.integration.test.js`, `socket.validation.test.js`, `socket.race.test.js`; `npm run test:server` | DONE; live Mongo server NOT VERIFIED here |
| 2 | W1 backend: MongoDB geospatial schemas | `models/UserPresence.js`, `models/Room.js`, `db/mongo.js`, `utils/geo.js` | `mongo.test.js`, `geo.test.js`, `proximity.test.js`; `npm run seed` with MongoDB | DONE in code; live Mongo NOT VERIFIED here |
| 3 | W1 frontend: React + Canvas layer | `components/WorldCanvas.jsx`, `canvas/renderer.js`, `canvas/coords.js` | `renderer.test.js`, `coords.test.js`; `npm run test:client` | DONE |
| 4 | W1 frontend: smooth keyboard/mouse movement | `movement/`, `hooks/useMovement.js`, `hooks/useSocket.js` | `movement.test.js`, `worldState.test.js`; `docs/DEMO_WEEK1.md` | DONE in Node; live browser NOT VERIFIED here |
| 5 | W2 backend: `$near` proximity grouping | `services/proximityService.js` | `proximity.test.js`, `proximity.roster.test.js`; `npm run audit` with MongoDB | DONE in code; real audit NOT VERIFIED here |
| 6 | W2 backend: signal only nearby users | `services/peerGraph.js`, `services/proximityService.js`, `sockets/index.js` | `peerGraph.unit.test.js`, `peerGraph.integration.test.js`, `signal.validation.test.js` | DONE; Mongo integration cases skip here |
| 7 | W2 frontend: `getUserMedia` + P2P audio | `webrtc/localMedia.js`, `peerManager.js`, `remoteAudio.js`, `rtcStats.js`, `audio/audioMixer.js` | `client/test/webrtc.*.test.js`, `audio.audioMixer.test.js` | DONE in code/Node; audible browser path NOT VERIFIED |
| 8 | Mid-review spatial audit with latency target | `services/spatialAudit.js`, `scripts/audit.js`, `app.js`, `AUDIT_*` config | `spatialAudit.test.js`; `npm run audit -- --users=50 --samples=25 --seed=1` | DONE in code/pure tests; real Mongo audit NOT VERIFIED |
| 9 | Mid-review two-browser audio check | Day 8 signaling plus Day 9 browser media modules | Socket/WebRTC Node tests; manual `docs/DEMO_MIDREVIEW.md` | Signaling DONE; live hearing NOT VERIFIED |
| 10 | Geospatial engine (`$near`, `$geoWithin`) | `services/proximityService.js`, `utils/geo.js`, `models/UserPresence.js` | `geo.test.js`, `proximity.test.js`, `spatialAudit.test.js` | DONE in code; live Mongo NOT VERIFIED here |
| 11 | Socket.io signaling server | `sockets/index.js`, `services/peerGraph.js` | `socket.*.test.js`, `signal.validation.test.js` | DONE |
| 12 | 2D virtual world | `client/src/components/`, `canvas/`, `movement/`, `realtime/` | `npm run test:client`; `npm run build` | DONE; build passed |
| 13 | WebRTC audio connection | `client/src/webrtc/`, `client/src/audio/` | WebRTC/mixer/stats tests; `docs/DEMO_WEEK3.md` | DONE in code/Node; live media NOT VERIFIED |
| 14 | Day 10 fast whole-room clustering + cross-check | `computeClusters`, `computeClustersViaNear` in `services/proximityService.js` | `proximity.roster.test.js`, `spatialAudit.test.js` | DONE in available tests; live Mongo NOT VERIFIED here |
| 15 | Day 10 signal-burst headroom | `SOCKET_SIGNAL_BURST=200`, socket token bucket | `signal.ratelimit.headroom.test.js`, mesh signal-burst checks | DONE |
| 16 | Day 11 distance-based GainNode attenuation | `audio/attenuation.js`, `audio/audioMixer.js`, `hooks/useSocket.js`, `components/AudioStatus.jsx` | `audio.attenuation.test.js`, `audio.audioMixer.test.js`; `npm run build` | DONE in code/Node; audible fade NOT VERIFIED |
| 17 | Day 13 cap + hysteresis + nearest-first + reclaim + checker | `peerGraph.js`, both edge stores, `scripts/mesh-check.js`, `realtime/meshIndicator.js` | `mesh.config.test.js`, `peerGraph.mesh.test.js`, `mesh.twoInstance.test.js`; real Redis mesh-check | DONE: embedded **37/37**, external harness **18/18** |
| 18 | Day 12 Redis Pub/Sub + shared edge state + recovery | `db/redis.js`, `sockets/redisAdapter.js`, `redisEdgeStore.js`, `edgeSweep.js`, `scripts/scale-check.js` | `edgeStore.contract.test.js`, `redis.failure.test.js`, `redis.scale.integration.test.js` | DONE with real Redis: scale-check **8/8**; Mongo-backed CLI NOT VERIFIED |
| 19 | Day 14 production empty-`CLIENT_URL` HTTP CORS alignment | `server/src/app.js`, `utils/origin.js`, `.env.example` | `app.test.js`, `origin.test.js`, `socket.validation.test.js` | DONE; non-production defaults covered |
| 20 | Day 14 bidirectional config/example drift guards | `server/test/configDrift.test.js`, `.env.example`, `client/.env.example` | `node --test server/test/configDrift.test.js` | DONE; exact server and `VITE_*` key checks |
| 21 | Day 14 concise invalid-config errors | `server/src/config/index.js`, `utils/logger.js`, `utils/loggerCore.js` | `config.test.js`, `mesh.config.test.js` | DONE; invalid values/credentials are not echoed |
| 22 | Day 14 one-line paused-audio hint + recovery | `audio/audioPausedHint.js`, `audio/audioMixer.js`, `components/AudioStatus.jsx` | `audio.audioPausedHint.test.js`, `audio.audioMixer.test.js` | DONE in Node; browser autoplay/Safari NOT VERIFIED |
| 23 | Day 14 bug hunt + regressions | PeerGraph, EdgeStores, sweeps, Redis, mixer, stats, PeerManager, scale/mesh checkers | Fix-by-fix table in `docs/WEEK3.md`; all current suites | DONE; each reproduced defect has a named fix commit |
| 24 | Day 14 cleanup + coherent docs + demo | `README.md`, `docs/WEEK3.md`, `DEMO_WEEK3.md`, `LIMITATIONS.md`, `CHANGELOG.md`, this trace | Clean install, tests, build, real Redis checks; manual demo remains separate | DONE for docs/code; live demo NOT VERIFIED |

## Day 14 commit evidence

The following short hashes were resolved with `git cat-file -t` and are commits in the current history:

```text
4d5dd96 02b7c0a a6c381e ad845d7 b182735 635db42 9b85dd1
951dad2 b0b0e6f 8cc0b21 d8fdb79 0f92b2b 5a19ab8 3be48c1
8118523 e5399f6 c5a0091 9ef2bc8 4b4f6a8 7dbdf8e
```

Their subjects and file-by-file mapping are recorded in `docs/WEEK3.md` and `CHANGELOG.md`. Earlier Day 1–13 hashes remain in the changelog; no hash or date is inferred from a document alone.

## Current verification boundary

- Clean lockfile installs and the client production build passed.
- Without services: server **131 passed / 57 skipped**; client **165/165 passed**.
- With real Redis: server **156 passed / 32 skipped**; client **165/165 passed**.
- The remaining 32 skips are MongoDB tests. A MongoDB+Redis zero-skip run, real Mongo audit, normal Mongo-backed external CLI run, and live two-browser hearing demo are **NOT VERIFIED** here.
- External harnesses use real Socket.io and Redis with in-memory presence backing; they are not represented as live Mongo or real-browser media runs.

Week 4 room persistence/obstacles, stereo panning, and 60 FPS work remain **not started**.
