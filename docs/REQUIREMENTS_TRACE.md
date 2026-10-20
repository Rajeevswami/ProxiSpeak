# Requirements Trace — up to Day 11

Company requirements through the Mid-Project Review plus Week 3 Day 11, traced
to files, tests and exact commands. Status is honest: there is no local MongoDB
or browser/Chromium here, so their live runs are marked NOT VERIFIED; see
`docs/DAY11.md` and `DEMO_MIDREVIEW.md` for rerun steps.

| # | Requirement | Implementing files | Test files | Command that demonstrates it | Status |
|---|---|---|---|---|---|
| 1 | W1 Backend: WebSocket server broadcasting avatar X/Y coordinates | `server/src/index.js`, `server/src/sockets/index.js`, `server/src/utils/httpServer.js` | `server/test/socket.integration.test.js`, `server/test/socket.validation.test.js` | `npm run test:server` (with MongoDB) | DONE |
| 2 | W1 Backend: basic MongoDB geospatial schemas | `server/src/models/UserPresence.js` (2dsphere), `server/src/models/Room.js`, `server/src/db/mongo.js`, `server/src/utils/geo.js` | `server/test/mongo.test.js`, `server/test/geo.test.js`, `server/test/proximity.test.js` | `npm run seed && npm run test:server` | DONE |
| 3 | W1 Frontend: React Canvas layer | `client/src/components/WorldCanvas.jsx`, `client/src/canvas/renderer.js`, `client/src/canvas/coords.js` | `client/test/renderer.test.js`, `client/test/coords.test.js` | `npm run test:client` | DONE |
| 4 | W1 Frontend: smooth keyboard/mouse avatar movement + coordinate broadcasting | `client/src/movement/`, `client/src/hooks/useMovement.js`, `client/src/hooks/useSocket.js` | `client/test/movement.test.js`, `client/test/worldState.test.js` | `npm run test:client`; manual: `docs/DEMO_WEEK1.md` | DONE |
| 5 | W2 Backend: MongoDB `$near` queries to group users | `server/src/services/proximityService.js` (`findNearby`, `nearQuery`, `computeClustersViaNear`) | `server/test/proximity.test.js` | `npm run audit` (also runs `$near`) | DONE |
| 6 | W2 Backend: only send WebRTC offers/answers to users within 100px radius | `server/src/services/peerGraph.js`, `server/src/services/proximityService.js`, `server/src/sockets/index.js` | `server/test/peerGraph.unit.test.js`, `server/test/peerGraph.integration.test.js`, `server/test/signal.validation.test.js` | `npm run test:server` (with MongoDB) | DONE |
| 7 | W2 Frontend: standard WebRTC P2P audio via `getUserMedia` | `client/src/webrtc/localMedia.js`, `peerManager.js`, `remoteAudio.js`, `rtcStats.js`, `client/src/components/AudioStatus.jsx` | `client/test/webrtc.*.test.js` | Two-browser check: `docs/DEMO_MIDREVIEW.md` | DONE (live browser run NOT VERIFIED in sandbox — no browser) |
| 8 | Mid-Review Backend "Spatial Audit": backend accurately filters/clusters by geospatial coordinates under 20 ms | `server/src/services/spatialAudit.js`, `server/scripts/audit.js`, `GET /api/spatial-audit` in `server/src/app.js`, config `AUDIT_*` in `server/src/config/index.js` | `server/test/spatialAudit.test.js`, `server/test/proximity.test.js` | `npm run audit`; `curl "http://localhost:4000/api/spatial-audit?users=50&samples=25&seed=1"` | DONE (live numbers NOT VERIFIED in sandbox — no MongoDB; PASS/FAIL is reported honestly by the audit itself) |
| 9 | Mid-Review Frontend "Audio Check": two browsers establish WebRTC audio via signaling server | Same as #7 plus Day 8 signaling (`peerGraph.js`, `sockets/index.js`) | `client/test/webrtc.*.test.js`, `server/test/peerGraph.integration.test.js` | `docs/DEMO_MIDREVIEW.md` two-window script | DONE (live run NOT VERIFIED in sandbox — no browser) |
| 10 | Key module: Geospatial Engine (`$near` and `$geoWithin`) | `server/src/services/proximityService.js` (`findNearby`, `countWithin`, `geoWithinQuery`) | `server/test/proximity.test.js`, `server/test/spatialAudit.test.js` | `npm run audit` (explains show 2dsphere, no COLLSCAN) | DONE |
| 11 | Key module: Signaling Server (Node.js + Socket.io) | `server/src/sockets/index.js`, `server/src/services/peerGraph.js` | `server/test/socket.integration.test.js`, `server/test/signal.validation.test.js` | `npm run test:server` | DONE |
| 12 | Key module: 2D Virtual World (React + HTML5 Canvas) | `client/src/` (`WorldCanvas`, canvas, movement, realtime) | `client/test/*.test.js` | `npm run dev:client` + `npm run test:client` | DONE |
| 13 | Key module: WebRTC audio connection | Same as #7 | Same as #7 | `docs/DEMO_MIDREVIEW.md` | DONE (live run NOT VERIFIED in sandbox) |
| 14 | Day 10: fast whole-room clustering (one roster query + in-memory grid + union-find), old `$near` algorithm kept as cross-check | `server/src/services/proximityService.js` (`computeClusters`, `computeClustersViaNear`) | `server/test/proximity.roster.test.js`, `server/test/spatialAudit.test.js` (20-layout equivalence) | `node --test server/test/proximity.roster.test.js server/test/spatialAudit.test.js` | DONE |
| 15 | Day 10: signal burst covers ~20-user clusters | `server/src/config/index.js` (`SOCKET_SIGNAL_BURST=200`), `.env.example` | `server/test/signal.ratelimit.headroom.test.js` | `node --test server/test/signal.ratelimit.headroom.test.js` | DONE |
| 16 | Week 3 — Dynamic Attenuation: distance-based GainNode for remote WebRTC tracks | `client/src/audio/attenuation.js`, `client/src/audio/audioMixer.js`, `client/src/webrtc/peerManager.js`, `client/src/webrtc/remoteAudio.js`, `client/src/hooks/useSocket.js`, `client/src/App.jsx`, `client/src/components/AudioStatus.jsx`; server sends `proximityRadiusPx` in `server/src/sockets/index.js` | `client/test/audio.attenuation.test.js`, `client/test/audio.audioMixer.test.js`, `server/test/socket.integration.test.js` | `npm test`; `npm run build --prefix client`; manual two-window hearing steps: `docs/DAY11.md` | DONE in code and client unit tests; server joined-payload assertion NOT VERIFIED (32 server tests skipped: no MongoDB); real two-browser hearing NOT VERIFIED (no browser/Chromium) |
| 17 | Week 3 — Mesh Scaling | — | — | — | MISSING / not started (later day; excluded from Day 11) |
| 18 | Week 3 — Redis Pub/Sub multi-instance Socket.io (Day 12) | — | — | — | MISSING / not started — next planned step; excluded from Day 11 |

Nothing else was found PARTIAL or MISSING within Week 1, Week 2 or the
Mid-Review scope. Week 3 rows distinguish the Day 11 attenuation deliverable
from later Mesh Scaling and Redis work. Stereo panning and occlusion remain
Week 4 scope, not started.
