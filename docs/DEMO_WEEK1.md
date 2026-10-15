# ProxiSpeak — Week 1 demo script (~5 minutes)

What this shows: two people join a room from the browser, see the same floor
plan, walk around, and watch each other move — the foundation the proximity
audio of Weeks 2–4 plugs into.

**Before you start**

* Node.js ≥ 18.17 and MongoDB (local `mongod`, or an Atlas cluster reachable
  through `MONGO_URI`).
* The repo installed once: `npm run install:all`.
* Two browser tabs, and a terminal you can keep open for logs.

---

## Step 0 — (30 s) Start MongoDB

```bash
mkdir -p ./data
mongod --dbpath ./data          # or: use your usual MongoDB service
```

*Say:* "the whole geospatial layer is MongoDB — one `2dsphere` index is what
makes proximity queries possible at all, so the database is not optional here."

*Expect:* `mongod` logs `Waiting for connections ... port: 27017`. Leave it
running in this terminal (or in the background).

## Step 1 — (20 s) Configure

```bash
cp .env.example .env            # defaults are already correct for a local mongod
```

Check the two lines that matter:

```
MONGO_URI=mongodb://127.0.0.1:27017/proxispeak
CLIENT_URL=http://localhost:5173      # the browser origin allowed to open the socket
```

*Say:* "one origin allow-list for both the HTTP API and the websocket — no
wildcard, no origin reflection."

## Step 2 — (20 s) Seed the rooms

```bash
npm run seed
```

*Expect:*

```
INFO  … [proxispeak:seed] target: mongodb://127.0.0.1:27017/proxispeak
INFO  … [proxispeak:seed] connected to proxispeak
INFO  … [proxispeak:seed] indexes ensured (UserPresence.location = 2dsphere)
INFO  … [proxispeak:seed] room "lobby" created
INFO  … [proxispeak:seed] room "studio" created
INFO  … [proxispeak:seed] room "lounge" created
INFO  … [proxispeak:seed] UserPresence indexes: {"_id":1}, {"sessionId":1}, {"roomId":1}, {"location":"2dsphere"}, {"sessionId":1,"roomId":1}, {"roomId":1,"lastSeen":-1}
INFO  … [proxispeak:seed] done
```

*Say:* "rooms are data, not code — a join for a room that was never created is
refused instead of invented. Re-running the seed is safe: existing rooms are
left untouched."

## Step 3 — (30 s) Start the server

```bash
npm start                       # HTTP + WebSocket on one port
```

*Expect (boot sequence):*

```
INFO  … [proxispeak:mongo] connected
INFO  … [proxispeak] MongoDB indexes ready (UserPresence.location: 2dsphere)
INFO  … [proxispeak] Rooms available: lobby, lounge, studio
INFO  … [proxispeak:sockets:…] Socket.io attached to the HTTP server (CORS: http://localhost:5173)
INFO  … [proxispeak] ProxiSpeak server listening on 0.0.0.0:4000 (development)
INFO  … [proxispeak] Health:  GET /health
INFO  … [proxispeak] Socket:  io() on the same origin
```

In a second terminal:

```bash
curl -s http://localhost:4000/health
# {"status":"ok","service":"proxispeak","uptimeSeconds":1,"time":"…"}
```

*Say:* "`/health` never touches MongoDB — a database hiccup must not make a
healthy process look dead."

## Step 4 — (20 s) Start the client

```bash
npm run dev:client              # Vite on http://localhost:5173
```

*Expect:* `VITE v6.4.4 ready` and `Local: http://localhost:5173/`.

## Step 5 — (60 s) Two tabs, one room

Open **two tabs** at `http://localhost:5173`. Join `lobby` as **Ada** in the
first and **Bob** in the second (different names make the demo readable; the
server does not require it).

*Expect:* both tabs show the same letterboxed 1920×1080 floor with a light grid
and coloured obstacles — grey `wall`, amber `desk`, blue `screen`, purple
`pillar`, green `plant`. Two labelled circles: your own avatar is highlighted
with a bright fill, a ring and a `(you)` tag; the other tab's avatar appears next
to you. The names must match in both tabs.

*Say:* "the room and the avatars come from the server — the client only draws
what `joined` and `user:joined` told it."

## Step 6 — (60 s) Movement

1. In the **Ada** tab hold `D` (or `→`) for a second. Ada moves immediately;
   **Bob's tab** shows Ada *gliding*, not jumping.
2. Hold `W`+`D`: the diagonal is the same speed as a straight line, not faster.
3. Click a spot across the room: Ada walks there and stops exactly on it. Press
   any movement key mid-walk and she stops — the click target is cancelled.
4. Stop moving: within a tenth of a second the other tab shows Ada's **exact**
   resting position.

*Say:* "movement is client-side prediction at 300 px/s, scaled by frame time, so
60 Hz and 144 Hz displays behave identically. Positions are broadcast at 10 Hz
and only when they change; remote avatars interpolate between those reports. The
server is the authority: it clamps coordinates into the room and caps a single
`move` at 120 px, so no client can teleport."

## Step 7 — (30 s) Window behaviour

Resize one tab (or drag it very small, then maximise again).

*Expect:* the room re-fits with letterboxing at every size — never stretched,
obstacle labels disappear when the scale is too small to read, and nothing goes
blank on a very large window (the canvas backing store is capped).

*Say:* "the canvas is devicePixelRatio-aware and re-fits on resize; a minimised
or 0-sized window cannot kill the render loop."

## Step 8 — (20 s) Leaving

Close the **Bob** tab.

*Expect:* Bob's avatar disappears from the Ada tab immediately (`user:left`)
and his presence row is deleted — check with:

```bash
mongosh "mongodb://127.0.0.1:27017/proxispeak" \
  --eval 'db.userpresences.find({ roomId: "lobby" }, { sessionId: 1, name: 1, x: 1, y: 1, location: 1 }).pretty()'
```

## Step 9 — (40 s) Connection loss and automatic reconnect

With the Ada tab still open, stop the server (`Ctrl-C` in the server terminal).

*Expect:* Ada's world stays on screen and the HUD shows
**"Connection lost — reconnecting…"**. Socket.io keeps retrying on its own.

Start the server again (`npm start`) and wait a couple of seconds.

*Expect:* the HUD message disappears, Ada is back in the room automatically —
**no page reload** — and there is exactly one Ada avatar (never a duplicate).
Her avatar reappears at a free spawn point: resuming the exact position you left
is part of the Week 2 presence lifecycle, not of Week 1.

*Say:* "the reconnect is Socket.io's job; the client waits for the server to
acknowledge the new connection before it sends another `move`, and it never
draws the presence row of the connection it just lost."

## Step 10 — (optional, 30 s) A room that does not exist

On a fresh database, skip Step 2 (`npm run seed`) and try to join `lobby`.

*Expect:* the join screen shows a red message naming the room and telling you to
run `npm run seed` on the server. The server log line answers with
`room_not_found`.

## Step 11 — (20 s) Wrap up

```bash
npm test                        # server suite, then client suite
```

*Expect:* both suites pass, and **`skipped 0`** in the server suite (any skipped
test means no MongoDB was reachable and the integration tests were NOT VERIFIED).

*Say:* "Week 2 is MongoDB `$near` proximity queries and the presence lifecycle;
Week 3 adds the WebRTC audio that opens when you walk into earshot. Today was
about getting the foundation honest: schema, realtime channel, movement and the
error paths."

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERROR [proxispeak:mongo] Cannot reach MongoDB at "mongodb://127.0.0.1:27017/proxispeak"` and `fatal startup error: connect ECONNREFUSED 127.0.0.1:27017` | MongoDB is not running or `MONGO_URI` is wrong. Start `mongod --dbpath ./data`, or point `MONGO_URI` at Atlas (and allow your IP under *Network Access*). |
| `fatal startup error: cannot listen on 0.0.0.0:4000 (EADDRINUSE): … change PORT or stop that process` | Another process owns port 4000 — usually an older run of this server. Stop it (`lsof -i :4000`) or set `PORT=4001` in `.env` (then start the client with `VITE_SERVER_URL=http://localhost:4001`, see `client/.env.example`). |
| Join fails with "That room does not exist on the server …" | The database has no rooms: run `npm run seed`. |
| Browser console: CORS / "blocked by CORS policy" or the socket never connects while `curl localhost:4000/health` works | `CLIENT_URL` does not list the page's origin. Set `CLIENT_URL=http://localhost:5173` in `.env` and restart the server. The boot line prints the active policy (`CORS: …`). Requests without an `Origin` header (curl, scripts) are always accepted — CORS protects browsers, it is not authentication. |
| Browser console: `ERR_CONNECTION_REFUSED` to `localhost:4000`, and the join screen says "Could not reach the server" | The client is up but the server is not: start `npm start` (the join screen can be used again as soon as it is running — Socket.io keeps retrying and the pending join is sent on connect). |
| The client points at the wrong server | `VITE_SERVER_URL` in `client/.env` overrides everything; remove it to fall back to `http://localhost:4000` in dev. |
| `Blocked request. This host ("…") is not allowed.` when the dev server is reached through a preview/tunnel URL | Vite only answers known Host headers. Set `VITE_DEV_ALLOWED_HOSTS` (see `client/.env.example`) to the preview host or a suffix such as `.e2b.app` and restart `npm run dev:client`. |
| The microphone permission prompt appears | It must not: Week 1 has no `getUserMedia`. If you see it, you are on Week 3 code — report it. |
| Two tabs show the same name and you cannot tell the avatars apart | Names are not unique; the avatars are distinguished by their position and the `(you)` tag. Use different names for a demo. |
| An avatar in the other tab is frozen after its tab crashed or the network dropped | The server reaps a dead socket on its ping timeout (up to ~20 s) and only then deletes the presence row and broadcasts `user:left`. A cleanly closed tab is immediate. Immediate cleanup for a network drop is the Week 2 presence lifecycle. |
| Avatars do not move at all in the other tab | Check the server log for `move dropped (rate limit)` or `move adjusted`: a legitimate client sends 10 events/s of ≤ 30 px, far below the 30/s and 120 px limits. If you raised `SOCKET_MOVE_EPS`/`SOCKET_MAX_STEP_PX` in `.env`, restart the server. |
| `npm test` reports `skipped 11` | The Socket.io integration tests found no MongoDB. Start the database (or set `MONGO_URI_TEST`), then re-run — `skipped 0` is the only fully verified run. |

---

## What was executed where (honesty note)

Commands in this script come from the repository's own scripts and configuration
and were checked against the source. On the machine that wrote this script:

* **Executed:** `npm run install:all` (both installs), `npm run build --prefix client`,
  `npm test` (both suites: server 45 tests — 34 passed, **11 skipped: NOT VERIFIED,
  no MongoDB**; client 99 passed), `npm start` without MongoDB (the exact
  troubleshooting message above), the busy-port path (the exact message above),
  and `npm run dev:client` plus HTTP requests against Vite (page, module
  transform, `allowedHosts` behaviour).
* **Not executed here:** starting `mongod`, `npm run seed`, `npm start` with a
  database, and the interactive two-tab walkthrough (Steps 0, 2, 3, 5–10), plus
  the diagnostic one-liners that need your machine (`mongosh …`, `lsof -i :4000`).
  The authoring environment had no MongoDB server and no browser, so those steps
  are **NOT VERIFIED** from here and the expected outputs are the ones the code
  produces (boot logs from `server/src/index.js`, seed logs from
  `server/scripts/seed.js`, seed output also quoted in `README.md`).
