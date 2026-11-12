# Production Serving and Deployment Guide

This guide explains how ProxiSpeak serves the React SPA, REST API, and Socket.io signaling server from **one Node.js process on a single origin**, how to run production mode locally, and how to deploy a single-instance setup on a free cloud host (such as Railway) backed by a MongoDB Atlas `M0` cluster over HTTPS.

---

## 1. Architecture of Single-Origin Production Serving

In production mode, one Node.js process (`server/src/index.js`) binds `0.0.0.0:$PORT` and serves all three layers on the same origin:

```text
https://<your-app>.up.railway.app  (or http://localhost:4000 locally)
 ├── GET /health                   -> Express liveness JSON (200)
 ├── GET /api/rooms                -> Express room list JSON
 ├── GET /api/rooms/:roomId        -> Express room blueprint JSON
 ├── PUT /api/rooms/:roomId/layout -> Express token-guarded layout save
 ├── /socket.io/*                  -> Socket.io WebSocket / Engine.IO transport
 ├── /assets/*                     -> Hashed Vite bundles (Cache-Control: public, max-age=31536000, immutable)
 └── GET /, GET /<deep-link>       -> client/dist/index.html (Cache-Control: no-cache)
```

Key guarantees implemented in `server/src/app.js` and `client/src/config.js`:

- **Static asset caching**: Hashed bundles under `client/dist/assets/` are served with `Cache-Control: public, max-age=31536000, immutable`. `index.html` (both at `/` and via the SPA fallback) is served with `Cache-Control: no-cache` so browsers always fetch the latest entrypoint after a deploy.
- **SPA fallback ordering**: The `GET`/`HEAD` fallback is registered **after** `/health` and all `/api/*` routes and explicitly excludes `/api`, `/health`, `/socket.io`, dotfiles, and non-HTML file extensions. Unknown `/api/*` routes always return the JSON `404` (`{ "ok": false, "error": "No route for GET /api/..." }`).
- **Path traversal protection**: Requests containing `..`, percent-encoded traversal sequences (`%2e`, `%2f`, `%5c`, `%00`), or backslashes are rejected with HTTP `400` before reaching `express.static` or the SPA fallback.
- **Missing build resilience**: If `client/dist/index.html` is absent at startup, Express logs one clear warning (`Client build not found at ... — run "npm run build" to serve the frontend; API and Socket.io remain active`) and continues serving `/health`, `/api/*`, and `/socket.io`.
- **Same-origin client socket resolution**: In a production build (`import.meta.env.DEV === false`), `resolveServerUrl()` in `client/src/config.js` returns `''`, causing `socket.io-client` to connect to `window.location.origin` automatically without requiring `VITE_SERVER_URL`.
- **Same-origin CORS in production**: When `NODE_ENV=production` and `CLIENT_URL` is empty, both Express HTTP CORS and Socket.io enforce same-origin-only policy (no cross-origin reflection).

---

## 2. Running Production Mode Locally

You can run the exact single-origin production setup on your machine whenever a local MongoDB instance (or Atlas URI) is available:

1. **Build the project** (installs both `server/` and `client/` packages and builds `client/dist/`):
   ```bash
   npm run build
   ```
2. **Seed the default rooms** (`lobby`, `studio`, `lounge`) once:
   ```bash
   MONGO_URI="mongodb://127.0.0.1:27017/proxispeak" npm run seed
   ```
3. **Start the server in production mode** with `CLIENT_URL` empty (same-origin):
   ```bash
   NODE_ENV=production CLIENT_URL= PORT=4000 MONGO_URI="mongodb://127.0.0.1:27017/proxispeak" npm start
   ```
4. **Verify health and open the app**:
   ```bash
   curl -i http://127.0.0.1:4000/health
   ```
   Open `http://localhost:4000` in two browser windows and join `lobby`. Both the UI and the `/socket.io` connection are served from port `4000` (Vite's dev server on `5173` is not used).

---

## 3. Step-by-Step Cloud Deployment (MongoDB Atlas M0 + Railway)

### Step 1 — Create a MongoDB Atlas M0 Cluster

1. Sign in to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and create a new **M0 (Free)** cluster in a region close to your host.
2. **Database Access (Database User)**:
   - Open **Security → Database Access → Add New Database User**.
   - Choose **Password** authentication, set a username (for example `proxispeak_app`) and a generated alphanumeric password (if the password contains special characters like `@`, `:`, `/`, `?`, or `#`, URL-encode them in the connection string).
   - Grant **Read and write to any database** (`readWriteAnyDatabase` or `readWrite` on `proxispeak`).
3. **Network Access (IP Access List)**:
   - Open **Security → Network Access → Add IP Address**.
   - Because free-tier PaaS hosts like Railway use dynamic outbound IPs unless a static egress feature is configured, add `0.0.0.0/0` (Allow Access from Anywhere) for the project test deployment, plus your own computer's IP so you can run `npm run seed` locally.
   - Rely on strong database credentials and TLS (`mongodb+srv://`).
4. **Connection String (with database name)**:
   - Click **Clusters → Connect → Drivers** (Node.js) and copy the `mongodb+srv://` URI.
   - **Important**: Ensure the database name `proxispeak` is present in the path before `?`:
     ```text
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/proxispeak?retryWrites=true&w=majority
     ```

### Step 2 — Push the Repository to GitHub

Ensure your branch is pushed to GitHub with `package.json` and `railway.json` at the repository root:

```bash
git push origin Rajeev
```

### Step 3 — Create the Railway Service

1. Sign in to [Railway](https://railway.com/) and click **New Project → Deploy from GitHub repo**.
2. Select the `ProxiSpeak` repository and configure the service branch in **Settings → Source**.
3. Railway reads `railway.json` at the repo root automatically:
   - **Build Command**: `npm run build` (runs `npm run install:all && npm --prefix client run build`)
   - **Start Command**: `npm start` (runs `node server/src/index.js`, binding `0.0.0.0:$PORT`)
   - **Healthcheck Path**: `/health`

### Step 4 — Configure Environment Variables in Railway

In your Railway service's **Variables** tab, configure:

| Variable | Value | Notes |
| --- | --- | --- |
| `MONGO_URI` | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/proxispeak?retryWrites=true&w=majority` | **Required.** Must include the database name (`/proxispeak`). Never commit this value to Git. |
| `NODE_ENV` | `production` | **Required.** Enables production same-origin CORS rules and disables `/api/spatial-audit` unless `AUDIT_ENABLED=true`. |
| `CLIENT_URL` | *(leave unset or empty)* | Leave empty so HTTP and Socket.io enforce same-origin policy on the Railway domain. |
| `ROOM_ADMIN_TOKEN` | `<strong-random-secret>` | *Optional.* Required only if you plan to update room layouts via `PUT /api/rooms/:roomId/layout` or `npm run room:save`. |
| `REDIS_URL` | *(leave unset for 1 instance)* | *Optional.* Only set (`redis://` or `rediss://`) if running multiple server instances. |

*(Note: Railway injects `PORT` automatically; `HOST` defaults to `0.0.0.0` in `server/src/config/index.js`.)*

### Step 5 — Generate a Public HTTPS Domain

In Railway **Settings → Networking → Public Networking**, click **Generate Domain** to obtain a public HTTPS URL (for example `https://proxispeak-production.up.railway.app`).

### Step 6 — Run the Seed Once from Your Own Computer Against Atlas

Rooms (`lobby`, `studio`, `lounge`) are not created implicitly on join. From your local clone, run `npm run seed` pointing at your Atlas `MONGO_URI`:

```bash
MONGO_URI="mongodb+srv://<username>:<password>@<cluster>.mongodb.net/proxispeak?retryWrites=true&w=majority" npm run seed
```

Expected log lines (credentials are automatically redacted by `server/src/db/mongo.js`):

```text
INFO ... MongoDB connected (...)
INFO ... MongoDB 2dsphere index ensured on UserPresence.location
INFO ... Seeded room "lobby" ...
INFO ... Seeded room "studio" ...
INFO ... Seeded room "lounge" ...
```

`npm run seed` is idempotent: re-running it preserves any custom room layouts and `layoutRevision` numbers already saved in the database.

### Step 7 — Verify `/health` and Test on Two Devices

1. **Check the health endpoint**:
   ```bash
   curl -s https://<your-app>.up.railway.app/health
   ```
   Expected response (`200 OK`):
   ```json
   {
     "status": "ok",
     "service": "proxispeak",
     "instanceId": "node-...",
     "scaleMode": "single",
     "uptimeSeconds": 42,
     "time": "2026-10-31T..."
   }
   ```
2. **Open the public `https://` link on two devices** (or two browser profiles with headphones):
   - Join room `lobby` on both devices and allow microphone access.
   - Move the two avatars within `100 px` to verify WebRTC peer connection (`peer:connect`), audible voice attenuation with distance, obstacle occlusion across walls, and left/right stereo panning.
   - Append `?perf=1` to the URL (`https://<your-app>.up.railway.app/?perf=1`) to inspect the live `fps | frame p95 | work p95 | dropped` readout.

---

## 4. Operational Notes and Constraints

### Why HTTPS Is Required for `getUserMedia`
Modern browsers restrict `navigator.mediaDevices.getUserMedia` (microphone capture) to **Secure Contexts**:
- `https://...` origins, or
- `http://localhost` / `http://127.0.0.1` on the local machine.

If you open ProxiSpeak over plain `http://` on a LAN IP (such as `http://192.168.1.10:4000`) or an unencrypted public URL, the browser blocks microphone access (`navigator.mediaDevices` is unavailable or rejects with `NotAllowedError`). Deploying behind Railway's TLS proxy (`https://`) satisfies the Secure Context requirement on desktop and mobile browsers. When microphone capture is unavailable or denied, ProxiSpeak degrades gracefully to **Listen only** mode.

### Free-Tier Sleep, Cold Starts, and Cost Notes
- **Always check current provider pricing**: Cloud hosting plans, trial credits, bandwidth allowances, and sleep policies change over time. Do not rely on fixed dollar figures in documentation—check [Railway's pricing page](https://railway.com/pricing) and [MongoDB Atlas pricing](https://www.mongodb.com/pricing) before deploying or scaling.
- **Container sleep / idle spin-down**: Free or trial tiers may sleep inactive containers or pause inactive `M0` clusters after extended idle periods.
- **Impact on WebSockets**: When a sleeping container stops, active Socket.io connections disconnect. Once woken by an incoming request, `/health` responds as soon as MongoDB connects, and connected browsers automatically reconnect and re-join via Socket.io's built-in reconnection + `sessionRecovery.js`.

### Single Instance vs. Multi-Instance Scaling (`REDIS_URL` and Sticky Sessions)
- **Single instance needs no Redis**: When `REDIS_URL` is unset/empty, the server runs in `scaleMode: "single"` using `MemoryEdgeStore` and in-memory Socket.io rooms. Zero Redis connections are opened.
- **Horizontal scaling requires Redis + sticky sessions**: If you run more than one server instance (`scaleMode: "redis"` with `REDIS_URL` set):
  1. Every instance must point to the same `MONGO_URI`, `REDIS_URL`, and `REDIS_KEY_PREFIX`.
  2. The load balancer in front of the instances **must enable sticky sessions (session affinity)** if Socket.io HTTP long-polling is used during the initial handshake, because an Engine.IO polling session is owned by the Node process that created it until upgraded to WebSocket.

### STUN-Only WebRTC Limitation on Strict Networks
- ProxiSpeak defaults to public Google STUN (`stun:stun.l.google.com:19302`, configurable via `ICE_SERVERS`).
- **Strict NATs and firewalls**: University/college Wi-Fi, corporate networks, and some mobile carrier networks use symmetric NATs or block direct UDP peer-to-peer traffic. On those networks, STUN hole-punching cannot establish a direct media path between browsers, and the WebRTC `connectionState` will transition to `failed` even though Socket.io signaling (`joined`, `user:moved`, `peer:connect`) succeeds.
- **Workaround for testing**: Test with both devices on a standard home Wi-Fi network, or tether one/both devices appropriately if campus Wi-Fi blocks UDP.
- **Out of scope**: Provisioning a TURN relay server (`turn:` / `turns:`) or an SFU media server is outside the project specification.

---

## 5. Rolling Back a Deployment

If a deployment introduces a regression:

1. **Via Railway Dashboard**:
   - Open your service's **Deployments** tab, locate the last known-good deployment, click the menu (`⋯`), and select **Redeploy** / **Rollback**.
2. **Via Git**:
   ```bash
   git revert <bad-commit-hash>
   git push origin Rajeev
   ```
3. **Database compatibility note**:
   - Room documents in MongoDB carry a monotonic `layoutRevision` integer (`>= 1`) and `UserPresence` documents are ephemeral session rows cleaned up on boot (`cleanupOnBoot()`). Rolling back application code does not require a destructive database migration.

---

## 6. Troubleshooting

| Symptom | Likely Cause | Resolution |
| --- | --- | --- |
| **White page or JSON 404 on `GET /`** (`{"ok":false,"error":"No route for GET /"}`) | `client/dist/` was not built before `npm start` ran, or the build step only ran `npm install` without building the client. | Ensure the build command is `npm run build` (which runs `npm run install:all && npm --prefix client run build`). Check startup logs for `Client build not found at .../client/dist`. |
| **Socket not connecting** (`Connection failed` / `connect_error` in UI) | 1. `CLIENT_URL` is set to a different origin (e.g. `http://localhost:5173`) in production.<br>2. `VITE_SERVER_URL` was set to `localhost` during build.<br>3. Reverse proxy is not forwarding WebSocket upgrades. | 1. Leave `CLIENT_URL` empty in production for same-origin serving.<br>2. Leave `VITE_SERVER_URL` unset when building.<br>3. Verify `curl -i "https://<host>/socket.io/?EIO=4&transport=polling"` returns `200` with an Engine.IO `sid`. |
| **Microphone blocked** (UI switches to `Listen only` with notice) | 1. Page opened over plain `http://` on a non-localhost address.<br>2. Browser or OS microphone permission was denied for the site.<br>3. Another application has exclusive hardware lock on the mic. | 1. Access the app via its `https://` URL (or `http://localhost:4000` locally).<br>2. Click the lock/site-settings icon in the browser address bar, allow Microphone, and re-join.<br>3. Check OS privacy settings for microphone access. |
| **`npm run seed` fails** (`MongoServerSelectionError` or `AuthenticationFailed`) | 1. `MONGO_URI` is still pointing to `127.0.0.1:27017` instead of Atlas.<br>2. Database user password contains unencoded special characters.<br>3. Database user lacks `readWrite` permissions. | 1. Pass `MONGO_URI="mongodb+srv://..."` explicitly in the command.<br>2. URL-encode special characters in the password (`@` → `%40`, `#` → `%23`).<br>3. Verify the user role in Atlas **Database Access**. |
| **`room "lobby" does not exist` on Join** | The server connected to a fresh database (or a different database name in `MONGO_URI`) that has not been seeded yet. | Ensure `MONGO_URI` includes `/proxispeak` in both Railway and your local seed command, then run `MONGO_URI="..." npm run seed`. |
| **Atlas Network Access timeout** (`Could not connect to any servers in your MongoDB Atlas cluster`) | Railway's outbound IP or your local IP is not on the Atlas IP Access List, or the `M0` cluster is paused. | In Atlas **Security → Network Access**, add `0.0.0.0/0` (for dynamic cloud host egress) and resume the cluster if paused. |
