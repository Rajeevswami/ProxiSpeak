# Mid-Project Review Demo (~7 minutes)

Two review items: **Spatial Audit** (backend) and **Audio Check** (frontend).
Prerequisites: Node ≥ 18.17, MongoDB, two browser windows, headphones.

## 0:00–1:00 — Start everything

```bash
mongod --dbpath ./data            # or your MongoDB service / Atlas MONGO_URI in .env
npm run install:all               # fresh installs (once)
npm run seed                      # 2dsphere index + lobby/studio/lounge
npm start                         # terminal 1: HTTP + WebSocket on :4000
npm run dev:client                # terminal 2: http://localhost:5173
```

Say: "Week 1 built the WebSocket + Canvas world; Week 2 added `$near`
proximity, the peer graph and WebRTC audio. Today we prove both review items
with measured numbers, not slides."

## 1:00–3:00 — Spatial Audit (backend)

```bash
npm run audit
curl "http://localhost:4000/api/spatial-audit?users=50&samples=25&seed=1"
```

Expected output shape (real numbers vary by machine — never quote these as
measured):

```
operation              mismatches      p50ms      p95ms        maxms
findNearby                      0        ...        ...          ...
countWithin                     0        ...        ...          ...
computeClusters                 0        ...        ...          ...
computeClustersViaNear          0        ...        ...          ...
index: $near 2dsphere=true COLLSCAN=false; $geoWithin 2dsphere=true COLLSCAN=false
cleanup verified (0 rows left): true
RESULT: PASS
```

Say: "The audit plants edge cases — exactly 99/100/101 px horizontally,
vertically and diagonally, duplicate coordinates, an A-B-C chain, isolated and
different-sized clusters — in a throwaway `audit-*` room, compares every
operation against an independent brute-force pixel check, times with
`performance.now()`, and cleans up in a `finally`. PASS means 0 mismatches
AND p95 ≤ `AUDIT_TARGET_MS` (default 20 ms) for every operation. Whole-room
clustering now reads one lean roster and computes on an in-memory grid;
`$near`/`$geoWithin` on the 2dsphere index still drive per-user discovery and
counting — the explains prove no COLLSCAN. If it prints FAIL, that is the
honest result for this machine/database."

## 3:00–6:30 — Audio Check (frontend, two browsers)

1. Headphones on. Open http://localhost:5173 in two windows.
2. Window A: name "Ada", room `lobby`, **Join with mic**. Window B: "Bob",
   same room, **Join with mic**. (Secure context: localhost is fine.)
3. Walk the avatars within 100 px. Within ~2 s both overlays show the peer row
   as `connected` and `bytesReceived` increasing — audio is flowing through a
   WebRTC peer connection established via the signaling server.
4. Talk: each hears the other. Walk apart beyond 100 px: the row disappears
   (server `peer:disconnect`, connection closed).
5. Close a tab: the other window's row disappears and its mic stops.

Say: "The server never touches audio — it only decides, from `$near`, who may
exchange offers/answers, and relays signaling for live edges inside 100 px."

## 6:30–7:00 — Close

"Day 11 has since added the Web Audio distance-gain mixer. Next (Day 12): Redis
Pub/Sub scaling; mesh optimization is planned for Day 13. Stereo panning and
occlusion remain Week 4 work. This review's spatial audit still uses one roster
query and reports its measured result against the 20 ms p95 budget."

## Troubleshooting

| Symptom | Fix |
|---|---|
| MongoDB not running | Start `mongod --dbpath ./data` (or fix `MONGO_URI`); server and audit refuse honestly without it. |
| Port in use | Another server holds 4000/5173 — stop it or set `PORT` / use the printed Vite port. |
| Mic permission denied | Padlock → Site settings → Microphone → Allow; rejoin. Or use *Listen only*. |
| No audio, bytes climb but silence | Click the page once (browser autoplay policy), check tab/OS volume and headphones. |
| Bytes frozen at 0, stuck `connecting` | ICE failed: STUN-only has no TURN, so strict/symmetric NATs across networks can fail; localhost/LAN works. |
| Audit FAIL on p95 | Atlas (network latency) vs local MongoDB: every query is a round-trip, so a remote cluster can exceed 20 ms p95 where local mongod passes. Report the measured numbers; do not tune the target to hide them. |
