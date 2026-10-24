# Demo Script — Week 3 (≈ 8 minutes)

This script demonstrates the Week 3 features: distance attenuation, multi-instance Redis scaling, and bounded mesh optimization. It assumes you have MongoDB and Redis running locally.

**Prerequisites:**
* Node.js ≥ 18.17
* MongoDB running on `127.0.0.1:27017`
* Redis running on `127.0.0.1:6379`
* Two browser windows (or two Chrome profiles with fake devices)

---

## Step 1: Install and seed (30 seconds)

**Say:** "First, let's install dependencies and seed the database."

**Command:**
```bash
npm run install:all
cp .env.example .env
npm run seed
```

**Expected output:**
```text
> proxispeak-server@1.0.0 seed
> node scripts/seed.js

Seed complete: 3 rooms (lobby, studio, lounge), 2dsphere index on UserPresence.location
```

**Troubleshooting:**
* If MongoDB is not running: start `mongod` or use Atlas (set `MONGO_URI` in `.env`)
* If seed fails with "E11000 duplicate key": safe to ignore, rooms already exist

---

## Step 2: Start two server instances with Redis (30 seconds)

**Say:** "Now we'll start two server instances connected to Redis for cross-instance scaling."

**Terminal 1:**
```bash
PORT=4000 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-1 npm start
```

**Terminal 2:**
```bash
PORT=4001 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-2 npm start
```

**Expected output (each terminal):**
```text
MongoDB indexes ready (UserPresence.location: 2dsphere)
Redis connected at redis://127.0.0.1:6379 (scaleMode: "redis")
ProxiSpeak server (node-1, scaleMode=redis) listening on 0.0.0.0:4000 (development)
```

**Troubleshooting:**
* If port 4000/4001 is in use: change `PORT` or kill the existing process
* If Redis connection fails: check Redis is running, or leave `REDIS_URL` empty for single-instance mode (demo will still work but won't show cross-instance features)

---

## Step 3: Verify scale-check passes (30 seconds)

**Say:** "Let's verify the two instances are communicating correctly."

**Command:**
```bash
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001
```

**Expected output:**
```text
scale-check: connecting two throwaway clients to node-1 and node-2
✓ both clients joined "lobby" on separate instances
✓ presence visible across instances
✓ edge created (peer:connect on both sides)
✓ signaling relayed (offer/answer exchanged)
✓ peer:disconnect received when client left
scale-check: PASS (all checks succeeded)
```

**Troubleshooting:**
* If scale-check fails with "room_not_found": run `npm run seed`
* If it hangs: check Redis is running and both servers connected successfully

---

## Step 4: Open two browser windows (30 seconds)

**Say:** "Now let's open two browser windows and join the same room."

**Action:**
1. Open `http://localhost:5173` in two browser windows (or use `npm run dev:client`)
2. In Window 1: enter name "Alice", select "lobby", click Join, allow mic (or choose "listen only")
3. In Window 2: enter name "Bob", select "lobby", click Join, allow mic (or choose "listen only")

**Expected result:**
* Both windows show the lobby room with two avatars
- The audio overlay shows "connected 1 / max 8"
- Both avatars can see each other

**Troubleshooting:**
* If mic permission is denied: choose "listen only" mode
* If avatars don't appear: check browser console for errors, verify server logs show "joined lobby"
* For Chrome without physical microphones: launch with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` and separate `--user-data-dir` for each window

---

## Step 5: Demonstrate distance attenuation (1 minute)

**Say:** "Let's walk the avatars close together and observe the volume fade."

**Action:**
1. In Window 1, use WASD/arrow keys to walk Alice's avatar toward Bob
2. Watch the audio overlay in Window 1

**Expected result:**
* As Alice approaches Bob (within 100 px), the overlay shows:
  - `connected 1 / max 8`
  - `45 px` (distance decreasing)
  - `72%` (volume increasing)
  - Inbound bytes climbing (e.g., `12.3 KB` → `45.6 KB`)
* When distance < 30 px: volume is 100%
- When distance is 30-100 px: volume smoothly fades (smoothstep curve)
- When distance > 100 px: volume is 0% (silent, but edge still exists until 115 px)

**Say:** "Notice the smooth fade — that's the Web Audio GainNode driven by the smoothstep attenuation curve. The edge stays alive until 115 px (hysteresis) to avoid flapping."

**Troubleshooting:**
* If no audio: check AudioContext state (should be "running" after the Join click); if "suspended", click anywhere on the page
- If volume doesn't change: check `proximityRadiusPx` in the `joined` payload matches server `PROXIMITY_RADIUS_PX`
- Use headphones to avoid echo/feedback

---

## Step 6: Show mesh-check output (30 seconds)

**Say:** "Let's verify the bounded mesh policy with the mesh-check script."

**Command:**
```bash
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001
```

**Expected output:**
```text
mesh-check: planting 50 users in a tight cluster
mesh-check: with MAX_PEERS_PER_USER=8, worst-case degree is 8 (not 49)
mesh-check: hysteresis prevents churn at the boundary (0 disconnects for 100 crossings)
mesh-check: PASS
```

**Troubleshooting:**
* If mesh-check fails: check both servers are running with Redis connected

---

## Step 7: Demonstrate the peer cap (1 minute)

**Say:** "Now let's show what happens when we hit the peer cap."

**Action:**
1. Set `MAX_PEERS_PER_USER=2` in `.env` (or export it before starting servers)
2. Restart both servers
3. Open four browser windows, all join "lobby"
4. Walk all four avatars within 50 px of each other

**Expected result:**
* Each user connects to at most 2 peers (not 3)
- The audio overlay shows `connected 2 / max 2`
- If a 3rd user is nearby, the overlay shows `1 nearby, not connected (cap)`
- No connect/disconnect churn as users move around

**Say:** "The symmetric cap ensures no user becomes a hub. Existing edges are never evicted for a closer newcomer — that's a documented limitation."

**Troubleshooting:**
* If all 4 users connect to each other: check `MAX_PEERS_PER_USER` is set to 2
- If overlay doesn't show "not connected (cap)": refresh the page

---

## Step 8: Redis failure and recovery (1 minute)

**Say:** "Let's see what happens when Redis goes down mid-session."

**Action:**
1. Stop Redis: `sudo systemctl stop redis` (or `redis-cli shutdown`)
2. Wait 5-10 seconds
3. Check the audio overlay — it should still show "connected"
4. Check server logs

**Expected result:**
* Server logs show: `Redis connection lost ... scaleMode is now "redis-degraded"`
- The `/health` endpoint shows `scaleMode: "redis-degraded"`
- Audio keeps flowing (WebRTC is peer-to-peer, doesn't need Redis)
- New cross-instance edges are paused until Redis recovers

**Action:**
1. Restart Redis: `sudo systemctl start redis`
2. Wait 5-10 seconds

**Expected result:**
* Server logs show: `Redis connection restored ... reconciling local peer edges`
- The `/health` endpoint shows `scaleMode: "redis"`
- Any missed edges are recreated via `reconcileLocalUsers`

**Troubleshooting:**
* If audio stops: WebRTC connections are independent of Redis; check browser console for WebRTC errors
- If recovery doesn't happen: check Redis is actually running and accessible

---

## Step 9: Instance crash and recovery (1 minute)

**Say:** "Finally, let's simulate a hard crash with `kill -9`."

**Action:**
1. Find the PID of one server: `lsof -ti:4000`
2. Kill it: `kill -9 <PID>`
3. Check the other server's logs and the browser overlay

**Expected result:**
- The killed server's sockets disconnect abruptly (no graceful shutdown)
- The surviving server's orphan edge sweep runs (every 30s by default) and removes stale edges
- The browser on the surviving instance receives `peer:disconnect` for edges to the crashed server's users
- The crashed server's users' avatars disappear from the surviving instance after the presence timeout (60s)

**Action:**
1. Restart the crashed server: `PORT=4000 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-1 npm start`
2. Rejoin from the browser

**Expected result:**
- The server boots, connects to Redis, runs the orphan edge sweep on boot
- The browser can rejoin and reconnect to peers

**Troubleshooting:**
* If edges aren't cleaned up: the orphan sweep runs every `EDGE_SWEEP_INTERVAL_MS` (default 30s); wait or check server logs
- If the crashed instance can't rejoin: check `INSTANCE_ID` is unique (or let it auto-generate)

---

## Wrap-up (30 seconds)

**Say:** "That's Week 3: distance attenuation with Web Audio, multi-instance scaling with Redis, and a bounded mesh that prevents hub-and-spoke topologies. The system gracefully handles Redis outages and instance crashes, and the peer cap ensures stable audio quality even in dense clusters."

**Next steps (Week 4):**
* Stereo panning (left/right ear based on relative position)
- Obstacle occlusion (walls muffle audio)
- Room persistence (save/load room layouts)
- 60 FPS rendering optimization

---

## Summary of commands

```bash
# Setup
npm run install:all
cp .env.example .env
npm run seed

# Start two instances
PORT=4000 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-1 npm start
PORT=4001 REDIS_URL="redis://127.0.0.1:6379" INSTANCE_ID=node-2 npm start

# Verify
npm run scale-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001
npm run mesh-check -- --urlA=http://127.0.0.1:4000 --urlB=http://127.0.0.1:4001

# Client
npm run dev:client
# Open http://localhost:5173 in two browsers, join "lobby"
```

**NOT VERIFIED (requires live MongoDB + Redis + two browsers):**
This demo script has not been executed end-to-end in the current environment due to unavailable MongoDB and Redis services. The commands and expected outputs are based on the code implementation and test coverage. Run the script in an environment with MongoDB and Redis to verify.
