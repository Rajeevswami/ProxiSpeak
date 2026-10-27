# Room Persistence Architecture & Specification

**Calendar Week 3 (Day 15 — 2026-10-26, Company Plan Week 4)** introduces transactional room obstacle layouts, atomic revision conflict detection, secure token-guarded layout APIs, real-time multi-instance broadcast, and developer CLI tooling to ProxiSpeak.

---

## 1. Architectural Overview & Data Model

ProxiSpeak rooms represent 2D shared audio spaces. Layouts define physical structures (`wall`, `desk`, `plant`, `pillar`, `screen`) stored in MongoDB and broadcast live to connected clients. Starting in **Week 3 (Day 16)**, blocking obstacles (`blocksAudio === true`) attenuate remote voice along the 2D line of sight in the client Web Audio mixer (`docs/OCCLUSION.md`), while avatars continue to have no movement collision with obstacles.

### Data Model: `Room` & `Obstacle`

Rooms are stored in MongoDB in the `rooms` collection. Each document includes dimensions, metadata, obstacles, spawn points, and an integer `layoutRevision`:

```typescript
interface Room {
  roomId: string;             // Unique slug (e.g. 'lobby', 'studio')
  name: string;               // Display name
  description?: string;        // Optional description
  width: number;              // Immutable width in pixels (e.g. 1920)
  height: number;             // Immutable height in pixels (e.g. 1080)
  layoutRevision: number;     // Integer >= 1, increments on successful save
  obstacles: Obstacle[];      // Bounded array of obstacles (max 200)
  spawnPoints: Array<{ x: number; y: number }>;
  createdAt: Date;
  updatedAt: Date;
}

interface Obstacle {
  id: string;                 // Unique identifier within the room ([A-Za-z0-9_-]{1,64})
  type: ObstacleType;         // 'wall' | 'desk' | 'plant' | 'pillar' | 'screen'
  x: number;                  // Top-left X coordinate (0 <= x < room.width)
  y: number;                  // Top-left Y coordinate (0 <= y < room.height)
  w: number;                  // Width in pixels (1 <= w, x + w <= room.width)
  h: number;                  // Height in pixels (1 <= h, y + h <= room.height)
  blocksAudio: boolean;       // Whether obstacle blocks acoustic line of sight
  attenuation: number;        // Transmission coefficient [0.0, 1.0]
}
```

### Obstacle Attenuation Semantics

In ProxiSpeak's acoustic model, the `attenuation` property represents the **fraction of sound power/amplitude that survives crossing the obstacle** (the acoustic transmission coefficient):
- `1.0`: Completely transparent (sound passes through unattenuated, e.g. open archway or air boundary).
- `0.5`: Moderate damping (50% signal survives, e.g. office dividers, desk partitions).
- `0.2`: Heavy damping (standard wall default; 20% signal survives).
- `0.12`: Dense barrier (12% signal survives, e.g. thick concrete or masonry wall).
- `0.0`: Completely opaque (complete acoustic shadow; 0% sound survives).

Values must be finite floating-point numbers between `0.0` and `1.0` inclusive.

---

## 2. Safe Atomic Backfill for Legacy Documents

To ensure seamless upgrades for existing databases that were created before Week 4 (where documents lacked `layoutRevision`), an idempotent migration routine `backfillLegacyRoomRevisions()` runs at startup and during `seed`:

```javascript
await Room.updateMany(
  {
    $or: [
      { layoutRevision: { $exists: false } },
      { layoutRevision: null },
      { layoutRevision: { $lt: 1 } },
    ],
  },
  { $set: { layoutRevision: 1 } },
);
```

Documents already possessing a valid `layoutRevision >= 1` are left untouched. On the wire and in memory, any missing `layoutRevision` safely defaults to `1`.

---

## 3. Strict Layout Validation Rules

Validation is unified across the REST API, the CLI, and Mongoose `Room` schema validation via `server/src/validators/roomLayout.js`. Requests failing validation are rejected immediately with descriptive, path-specific error messages.

Rules enforced:
1. **Root Fields**: Only allowed keys (`obstacles`, `name`, `description`, `expectedRevision`) may be present. Unknown root fields trigger an immediate validation error (mass assignment defense).
2. **Obstacle Count**: Must be an array containing between 0 and `ROOM_LAYOUT_MAX_OBSTACLES` (default `200`) items.
3. **Obstacle IDs**:
   - Must match `/^[A-Za-z0-9_-]{1,64}$/` (1..64 alphanumeric, dash, or underscore characters).
   - Must be unique within the room (duplicate IDs are rejected with `invalid_payload` at path `obstacles[i].id`).
4. **Obstacle Types**: Must match the allowed enum: `['wall', 'desk', 'plant', 'pillar', 'screen']`.
5. **Coordinates & Bounds**:
   - Coordinates `x`, `y`, `w`, `h` must be finite numbers.
   - `x >= 0` and `y >= 0`.
   - `w >= 1` and `h >= 1`.
   - `x + w <= room.width` and `y + h <= room.height`.
   - An obstacle touching the edge (`x + w === width`) is valid; an obstacle exceeding the edge by even one pixel is rejected.
6. **Audio Properties**:
   - `blocksAudio` must be a strict boolean (`true` or `false`).
   - `attenuation` must be a finite number between `0.0` and `1.0` inclusive.
7. **Mass Assignment Prevention**: Unknown keys on individual obstacle objects are rejected with path-specific errors (e.g. `obstacles[2].foo`).

---

## 4. Room Service & Revision Conflict Detection

Room updates are persisted atomically using optimistic concurrency control:

```javascript
saveLayout(roomId, { obstacles, name, description, expectedRevision }, { io })
```

### Atomic Save Mechanism

The update uses MongoDB's atomic `findOneAndUpdate`:

```javascript
const updated = await Room.findOneAndUpdate(
  {
    roomId,
    $or: [
      { layoutRevision: expectedRevision },
      // Allows backfilling unversioned legacy documents if expectedRevision === 1
      ...(expectedRevision === 1 ? [{ layoutRevision: { $exists: false } }] : []),
    ],
  },
  {
    $set: {
      obstacles,
      ...(name ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    $inc: { layoutRevision: 1 },
  },
  { new: true, runValidators: true },
);
```

### Conflict Scenarios

1. **Revision Match**: Document is updated atomically, `layoutRevision` increments by 1, in-memory cache is invalidated, and the layout is broadcast across Socket.io.
2. **Revision Mismatch (409 Conflict)**: If another process updated the room first, the atomic query filter matches 0 documents. The service queries the current document and throws `RevisionConflictError`:
   - HTTP Status: `409 Conflict`
   - Response Code: `revision_conflict`
   - Payload:
     ```json
     {
       "error": {
         "code": "revision_conflict",
         "message": "Revision conflict on room \"lobby\": expected revision M but current revision is N",
         "details": { "roomId": "lobby", "expectedRevision": M, "currentRevision": N }
       }
     }
     ```
3. **Unknown Room (404 Not Found)**: If the room ID does not exist in MongoDB, throws `RoomNotFoundError` with HTTP status `404`.
4. **Immutable Dimensions**: Room dimensions (`width`, `height`) are strictly immutable and cannot be altered by layout saves.

---

## 5. REST API & Token Guard

### Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/rooms` | Public | Returns JSON array `[{ roomId, name, layoutRevision }]` |
| `GET` | `/api/rooms/:roomId` | Public | Returns room wire object `{ roomId, name, description, width, height, layoutRevision, obstacles, spawnPoints }` |
| `PUT` | `/api/rooms/:roomId/layout` | `x-room-admin-token` | Updates room layout with revision guard and returns updated room wire object |

### Example `curl` Requests

```bash
# List persisted rooms (public)
curl -s http://127.0.0.1:4000/api/rooms

# Fetch full room layout (public)
curl -s http://127.0.0.1:4000/api/rooms/lobby

# Save an updated layout (requires ROOM_ADMIN_TOKEN)
curl -s -X PUT http://127.0.0.1:4000/api/rooms/lobby/layout \
  -H "Content-Type: application/json" \
  -H "x-room-admin-token: your-secure-token" \
  -d '{"expectedRevision":1,"obstacles":[]}'
```

### Authentication & Threat Model

The `PUT /api/rooms/:roomId/layout` endpoint is guarded by the `x-room-admin-token` HTTP header:

- **Token Storage**: Loaded from the environment variable `ROOM_ADMIN_TOKEN`.
- **Constant-Time Verification**: Comparison is performed using `crypto.timingSafeEqual` over SHA-256 digests to protect against timing attacks.
- **Editing Disabled (403)**: If `ROOM_ADMIN_TOKEN` is unset or empty in the server environment, layout edits are disabled server-wide. The endpoint responds with `403 Forbidden` (`{ code: 'editing_disabled' }`).
- **Unauthorized (401)**: If the token is missing or incorrect, the endpoint responds with `401 Unauthorized` (`{ code: 'unauthorized' }`).
- **Zero Token Leakage**: Admin tokens are strictly redacted from logs, error messages, and HTTP responses.
- **Payload Limits**: Requests are capped at 64 KB (`413 Payload Too Large`).
- **Rate Limiting**: An in-memory IP rate limiter limits layout modifications to 10 requests per minute per IP address (`429 Too Many Requests`).

---

## 6. Live Sync & Cross-Instance Cache Invalidation

When a layout is successfully saved:
1. **Room Broadcast**: Emits `room:layout` to all sockets connected to that room:
   ```javascript
   io.to(roomId).emit('room:layout', {
     roomId,
     layoutRevision: updated.layoutRevision,
     obstacles: updated.obstacles,
   });
   ```
2. **Multi-Instance Cache Invalidation**:
   - The local in-memory room cache is cleared immediately (`invalidateRoomCache(roomId)`).
   - In clustered deployments with Redis (`@socket.io/redis-adapter`), `io.serverSideEmit('room:cache:invalidate', roomId)` broadcasts the cache eviction across all running instances.
   - When sibling nodes receive `room:cache:invalidate`, they evict their local room cache so subsequent queries fetch the new revision from MongoDB.
3. **Late Joiners**:
   - Clients joining after a layout update receive the latest obstacles and `layoutRevision` in the initial `joined` snapshot event.

---

## 7. Client Live Layout Sync

The browser client applies layout updates seamlessly without requiring page reloads or canvas resets:

- **Socket Handler**: `useSocket.js` listens for `room:layout`.
- **In-Place State Update**: `updateRoomLayout(worldRef.current, payload)` updates `world.room.obstacles` and `world.room.layoutRevision` directly in the mutable world reference.
- **Zero React Re-renders**: Updates do not trigger React component re-renders. The canvas render loop (`requestAnimationFrame`) picks up the updated obstacles automatically on the very next animation frame.
- **Stale Event Protection**: Events with `layoutRevision <= currentRev` or events belonging to other rooms are dropped immediately.
- **Connection Teardown**: Sockets clean up listeners on room leave or component unmount, preventing duplicate listeners across reconnections.

---

## 8. CLI Tooling & Sample Layouts

### Command Line Interface

A Node-based CLI is available at `server/scripts/room-layout.js`:

```bash
# Inspect current room layout and revision
npm run room:show -- --room lobby

# Validate layout schema without writing to database
npm run room:save -- --room lobby --file server/layouts/valid-office.json --dry-run

# Persist layout to MongoDB and broadcast to live clients
npm run room:save -- --room lobby --file server/layouts/valid-office.json
```

### Sample Blueprints

Sample layout files are stored in `server/layouts/`:
- `valid-office.json`: Central concrete spine wall (`attenuation: 0.12`), huddle screens (`0.45`), workstation desk rows (`0.5`), atrium pillars (`0.25`), and corner fern (`0.65`).
- `quiet-zone.json`: Dense acoustic perimeter wall (`attenuation: 0.08`), focus carrels (`0.4`), sound-baffle screen (`0.35`), and rubber-plant divider (`0.7`).

### Seed Idempotency

Running `npm run seed` is completely safe and idempotent:
- Default rooms are created only if they do not already exist in the database.
- Existing rooms with custom revisions or user-edited layouts are left untouched and are never overwritten by subsequent seed runs.

---

## 9. Troubleshooting & Operations

### Common Issues

1. **`403 editing_disabled` on PUT `/api/rooms/:roomId/layout`**
   - **Cause**: `ROOM_ADMIN_TOKEN` is unset or empty in `.env`.
   - **Fix**: Set `ROOM_ADMIN_TOKEN="your-secure-token"` in `server/.env` and restart the server.
2. **`409 revision_conflict` on layout save**
   - **Cause**: The room layout was modified by another user or process since it was loaded.
   - **Fix**: Re-fetch `GET /api/rooms/:roomId` to read the current `layoutRevision`, merge obstacle changes, and submit with the updated `expectedRevision`.
3. **`413 Payload Too Large`**
   - **Cause**: Layout payload exceeds 64 KB.
   - **Fix**: Ensure the obstacle count is within `ROOM_LAYOUT_MAX_OBSTACLES` (default 200) and redundant metadata is omitted.
