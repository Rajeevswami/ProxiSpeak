# Week 3 Demo — Two Instances, Approximately 8 Minutes

Goal: show two real browser clients connected to different Node instances, proximity-attenuated WebRTC audio, and the bounded-mesh checks. Use headphones.

**Verification label:** this is a presenter script, not a claim that the demo was executed. The end-to-end MongoDB + Redis + two-browser run is **NOT VERIFIED** in the current sandbox. Success markers below come from the checker code; they are not a captured demo transcript.

## Preparation before the clock starts

Requirements: Node.js 18.17+, MongoDB on `127.0.0.1:27017`, Redis on `127.0.0.1:6379`, and two browser windows. Seed the rooms and start Redis before presenting.

```bash
npm run install:all
cp .env.example .env
npm run seed
```

Start two servers in separate terminals. Both client origins are allowed explicitly:

```bash
# Terminal A
PORT=4000 INSTANCE_ID=node-1 \
REDIS_URL="redis://127.0.0.1:6379" \
CLIENT_URL="http://localhost:5173,http://localhost:5174" \
npm start

# Terminal B
PORT=4001 INSTANCE_ID=node-2 \
REDIS_URL="redis://127.0.0.1:6379" \
CLIENT_URL="http://localhost:5173,http://localhost:5174" \
npm start
```

Start two Vite instances so each browser targets a different server:

```bash
# Terminal C — defaults to VITE_SERVER_URL=http://localhost:4000 in development
npm run dev:client -- --port=5173

# Terminal D — explicitly targets server B
VITE_SERVER_URL="http://localhost:4001" npm run dev:client -- --port=5174
```

Open `http://localhost:5173` in Window A and `http://localhost:5174` in Window B. Keep `lobby` for the browser demo and `studio` for automated checks so synthetic users do not enter the visible demo room.

Optional microphone-less CI-style browser setup can use Chrome's fake media flags with separate profiles, but that setup was not tested here. Do not describe it as an audible verification unless someone actually hears the result.

## 0:00–0:40 — Show the two instances

Run:

```bash
curl http://localhost:4000/health
curl http://localhost:4001/health
```

Point out distinct `instanceId` values and `"scaleMode":"redis"`.

**Say:** “Both browsers will join the same MongoDB-backed room through different Node processes. Redis carries Socket.io fan-out and shared peer-edge state; WebRTC media itself is peer-to-peer.”

## 0:40–1:30 — Prove cross-instance signaling

Use the empty seeded `studio` room:

```bash
npm run scale-check -- \
  --urlA=http://127.0.0.1:4000 \
  --urlB=http://127.0.0.1:4001 \
  --room=studio
```

Look for `RESULT: PASS (8/8 checks passed)`. Explain that the checker covers health, join/snapshot, movement, one consistent edge, offer/answer/ICE relay, stale-generation rejection, out-of-range disconnect, and final departure.

If it fails, show the failed row rather than claiming success. `room_not_found` means seeding is missing; connection errors mean a server or Redis is not ready.

## 1:30–2:30 — Join from two browsers

1. In Window A (`:5173`), join `lobby` as **Alice** and allow the microphone.
2. In Window B (`:5174`), join `lobby` as **Bob** and allow the microphone.
3. Move the avatars within 100 px.

Show that each window renders both avatars and the overlay reports one connected peer out of the configured maximum. Inbound bytes should increase when media flows, but bytes alone are not proof of audible quality.

**Say:** “Alice is connected to server A and Bob to server B. Presence and signaling crossed Redis; the audio connection is a bounded WebRTC edge.”

Use “Listen only” only as a fallback for unavailable/denied microphone capture. A listen-only client cannot supply its own microphone audio.

## 2:30–4:10 — Demonstrate distance attenuation and hysteresis

While one person speaks, move the other avatar with WASD/arrows or a floor click:

1. **30 px or closer:** overlay volume is 100%.
2. **Between 30 and 100 px:** volume follows the smoothstep fade; watch distance and volume change.
3. **At or beyond 100 px but not beyond 115 px:** gain is silent, while the existing edge may remain connected.
4. **Beyond 115 px:** the edge disconnects. Return within 100 px to create a new generation.

**Say:** “The connect and drop radii are deliberately different. That 15 px hysteresis band prevents connect/disconnect flapping when someone sits on the boundary.”

Use actual overlay values; do not recite a fabricated byte count or volume percentage.

## 4:10–4:50 — Show paused-audio recovery behavior

If the browser suspends or interrupts audio while peers exist, the overlay displays exactly:

`Audio is paused by the browser. Click anywhere on the page.`

Click the page and check whether audio resumes. Returning a hidden tab to visible also invokes the resume path. If the browser does not enter a paused state, explain the behavior without pretending to have triggered it.

For no audio, check microphone permission, connection state, inbound bytes, headphones/feedback, and the browser console. Safari interruption behavior remains live-browser unverified.

## 4:50–6:10 — Run the bounded-mesh check

Keep the browsers in `lobby`; run the checker against empty `studio`:

```bash
npm run mesh-check -- \
  --urlA=http://127.0.0.1:4000 \
  --urlB=http://127.0.0.1:4001 \
  --room=studio
```

With the default configuration, look for `RESULT: PASS (18/18 checks passed)`.

Point to the N=10/20/50 rows and explain:

- degree never exceeds the configured cap at either endpoint;
- no edge extends beyond the current drop radius;
- each edge has one initiator and one shared generation;
- no duplicate, self, or cross-room edge appears;
- boundary jitter produces no connect/disconnect churn inside the hysteresis band;
- the default signal burst is relayed without loss.

External mode checks only the running servers' **current** configuration in the exact `studio` room. It intentionally has no embedded before/after comparison.

## 6:10–7:10 — Explain the cap honestly

Use the N=50 row and overlay wording to explain the bounded mesh:

- Default cap: at most 8 peer connections per user, not 49.
- Candidates are considered nearest-first and freed slots refill.
- A closer newcomer does **not** evict an existing edge automatically; a nearby user may remain unconnected until capacity changes.
- These are synthetic Socket.io clients, not 50 browser audio connections, so this is not a 60 FPS or audio-load benchmark.

Optional post-demo, not part of the eight minutes: `REDIS_URL="redis://127.0.0.1:6379" npm run mesh-check` runs embedded current/baseline suites and has a 37-check result. Do not squeeze it into the live browser segment.

## 7:10–8:00 — Wrap up

**Say:** “Week 3 delivers smooth distance attenuation, optional Redis scaling, and a symmetric bounded mesh. Day 14 hardened lifecycle cleanup, configuration, CORS, audio recovery, and the verification tools.”

Close with the limits: STUN-only default, no authentication, MongoDB required, sticky sessions behind a load balancer, no measured live audio-quality/60-FPS guarantee, and no custom room-layout persistence or audio occlusion.

**Next scope, not implemented:** Week 4 room persistence/obstacles, stereo panning, and 60 FPS work.

## Presenter troubleshooting

- **Origin rejected:** both servers need both Vite origins in `CLIENT_URL`, or use one client origin with the same server URL.
- **Second window reaches server A:** set `VITE_SERVER_URL=http://localhost:4001` for the second Vite process; the port alone does not choose the API server.
- **No room / checker timeout:** run `npm run seed`, use the exact existing `studio` room, and verify both `/health` responses.
- **Redis degraded:** restore Redis before scale/mesh checks. Existing browser media and recovery behavior must not be claimed from a checker alone.
- **No audible sound:** use headphones, check mic permission and browser autoplay state, then inspect overlay bytes/connection state. Node tests cannot diagnose speaker output.
