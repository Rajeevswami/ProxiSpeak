# Documentation Index

This index organizes all technical specifications, verification reports, deployment guides, and live demonstration scripts in `docs/`.

## Final Project Review & Operations

| Document | Topic |
| --- | --- |
| [`docs/DEPLOY.md`](DEPLOY.md) | Single-origin production serving (`client/dist/`), local production run, MongoDB Atlas `M0` + Railway HTTPS setup, rollback, and troubleshooting |
| [`docs/DEMO_FINAL.md`](DEMO_FINAL.md) | 10-minute Final Project Review live demonstration script mapped to both final review targets |
| [`docs/REQUIREMENTS_TRACE.md`](REQUIREMENTS_TRACE.md) | Complete traceability matrix for all company requirements (files, tests, commands, status) |
| [`docs/LIMITATIONS.md`](LIMITATIONS.md) | Honest technical, architectural, and sandbox verification boundaries |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Chronological and feature-indexed changelog with verified commit hashes |

## Feature Deep-Dives

| Document | Feature |
| --- | --- |
| [`docs/RENDERING.md`](RENDERING.md) | Steady 60 FPS Canvas 2D rendering pipeline (`frameStats`, `staticLayer`, `drawStatic`/`drawDynamic`, `?perf=1`, and pre/post operation baseline) |
| [`docs/PANNING.md`](PANNING.md) | Stereo audio panning (`panForPositions`, `StereoPannerNode` chain, smoothing, and heap/tick benchmarks) |
| [`docs/OCCLUSION.md`](OCCLUSION.md) | Furniture and wall sound occlusion (Liang-Barsky segment-rectangle intersection, multiplicative transmission `T`, and 20,000-case cross-check) |
| [`docs/ROOM_PERSISTENCE.md`](ROOM_PERSISTENCE.md) | Room layout persistence (`layoutRevision`, shared validator, token-guarded REST API, live `room:layout` broadcast, and CLI) |
| [`docs/MESH_OPTIMIZATION.md`](MESH_OPTIMIZATION.md) | WebRTC mesh optimization (`MAX_PEERS_PER_USER`, hysteresis band `100..115 px`, nearest-first refill, and revision fencing) |
| [`docs/REDIS_SCALING.md`](REDIS_SCALING.md) | Multi-instance horizontal scaling (`@socket.io/redis-adapter`, Lua `RedisEdgeStore`, outage degradation, and self-healing) |

## Milestone Notes & Earlier Demo Scripts

| Document | Scope |
| --- | --- |
| [`docs/WEEK1.md`](WEEK1.md) | Foundation server, MongoDB `2dsphere` schema, Socket.io presence, React Canvas world, and movement |
| [`docs/WEEK2.md`](WEEK2.md) | Proximity queries, 100 px fenced WebRTC signaling, P2P audio, and Mid-Project Review spatial audit |
| [`docs/WEEK3.md`](WEEK3.md) | Distance attenuation, Redis multi-instance scaling, WebRTC mesh optimization, and stabilization |
| [`docs/DAY7.md`](DAY7.md), [`docs/DAY8.md`](DAY8.md), [`docs/DAY9.md`](DAY9.md), [`docs/DAY11.md`](DAY11.md) | Detailed subsystem notes for proximity queries, signaling, WebRTC media, and `GainNode` attenuation |
| [`docs/DEMO_WEEK1.md`](DEMO_WEEK1.md), [`docs/DEMO_MIDREVIEW.md`](DEMO_MIDREVIEW.md), [`docs/DEMO_WEEK3.md`](DEMO_WEEK3.md) | Earlier review demonstration scripts |
