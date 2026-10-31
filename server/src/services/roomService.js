/**
 * Room persistence (Week 4 - Room Persistence): blueprint persistence,
 * optimistic revision concurrency, atomic layout saves, and multi-node sync.
 */
import Room from '../models/Room.js';
import config from '../config/index.js';
import { validateLayoutPayload } from '../validators/roomLayout.js';
import { RoomNotFoundError, RevisionConflictError, ValidationError } from '../utils/errors.js';

const cache = new Map(); // roomId -> room document (plain object)

/** Deterministic blueprint so every instance builds the same default room. */
export function buildDefaultRoom(roomId, world = config.world) {
  const { width: w, height: h } = world;
  const obstacles = [
    // Heavy concrete spine across the middle of the floor.
    { id: 'wall-core', type: 'wall', x: w / 2 - 20, y: h / 2 - 150, w: 40, h: 300, blocksAudio: true, attenuation: 0.12 },
    // Meeting room: light screen, sound leaks.
    { id: 'screen-1', type: 'screen', x: w * 0.18, y: h * 0.22, w: 180, h: 14, blocksAudio: true, attenuation: 0.45 },
    { id: 'screen-2', type: 'screen', x: w * 0.18, y: h * 0.55, w: 180, h: 14, blocksAudio: true, attenuation: 0.45 },
    // Desk clusters: noticeably deaden sound, still talkable.
    { id: 'desk-a', type: 'desk', x: w * 0.68, y: h * 0.2, w: 150, h: 70, blocksAudio: true, attenuation: 0.5 },
    { id: 'desk-b', type: 'desk', x: w * 0.68, y: h * 0.32, w: 150, h: 70, blocksAudio: true, attenuation: 0.5 },
    { id: 'desk-c', type: 'desk', x: w * 0.22, y: h * 0.72, w: 200, h: 60, blocksAudio: true, attenuation: 0.5 },
    // Structural pillars + soft blockers.
    { id: 'pillar-1', type: 'pillar', x: w * 0.45, y: h * 0.2, w: 34, h: 34, blocksAudio: true, attenuation: 0.25 },
    { id: 'pillar-2', type: 'pillar', x: w * 0.6, y: h * 0.68, w: 34, h: 34, blocksAudio: true, attenuation: 0.25 },
    { id: 'plant-1', type: 'plant', x: w * 0.85, y: h * 0.66, w: 26, h: 26, blocksAudio: true, attenuation: 0.65 },
    { id: 'plant-2', type: 'plant', x: w * 0.08, y: h * 0.42, w: 26, h: 26, blocksAudio: true, attenuation: 0.65 },
  ];

  const spawnPoints = Array.from({ length: 24 }, (_, i) => {
    const cols = 6;
    return {
      x: Math.round(w * 0.12 + (i % cols) * (w * 0.15)),
      y: Math.round(h * 0.12 + Math.floor(i / cols) * (h * 0.2)),
    };
  }).map((p) => ({ x: Math.min(p.x, w - 40), y: Math.min(p.y, h - 40) }));

  return {
    roomId,
    name: prettyRoomName(roomId),
    description: 'Default office blueprint generated on first join.',
    width: w,
    height: h,
    layoutRevision: 1,
    obstacles,
    spawnPoints,
  };
}

const prettyRoomName = (roomId) =>
  roomId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ') || 'Lobby';

/** Normalise a mongoose doc / plain object into the wire format used by clients. */
function toRoomWire(doc) {
  return {
    roomId: doc.roomId,
    name: doc.name,
    description: doc.description ?? '',
    width: doc.width,
    height: doc.height,
    layoutRevision: doc.layoutRevision ?? 1,
    obstacles: doc.obstacles.map((o) => ({
      id: o.id,
      type: o.type,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      blocksAudio: o.blocksAudio !== false,
      attenuation: o.attenuation ?? 0.2,
    })),
    spawnPoints: (doc.spawnPoints ?? []).map((p) => ({ x: p.x, y: p.y })),
  };
}

/** Upsert a room blueprint and refresh the cache. Idempotent. */
export async function persistRoom(room) {
  const doc = await Room.findOneAndUpdate(
    { roomId: room.roomId },
    { $set: room },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const wire = toRoomWire(doc);
  cache.set(room.roomId, wire);
  return wire;
}

/**
 * Read one room in wire format (cache first, then MongoDB). Returns `null` when
 * the room does not exist: rooms are never created implicitly, so a `join` for
 * an unknown room is rejected instead of inventing a blueprint for it.
 */
export async function getRoom(roomId) {
  const key = String(roomId).toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const doc = await Room.findOne({ roomId: key }).lean();
  if (!doc) return null;

  const wire = toRoomWire(doc);
  cache.set(key, wire);
  return wire;
}

/** Ids of every persisted room — used for the boot log and diagnostics. */
export async function listRoomIds() {
  const docs = await Room.find({}, { roomId: 1, _id: 0 }).sort({ roomId: 1 }).lean();
  return docs.map((doc) => doc.roomId);
}

/**
 * Returns summary list of all persisted rooms (ids, names, revisions).
 * Used by GET /api/rooms.
 */
export async function listRooms() {
  const docs = await Room.find({}, { roomId: 1, name: 1, layoutRevision: 1, _id: 0 })
    .sort({ roomId: 1 })
    .lean();
  return docs.map((doc) => ({
    roomId: doc.roomId,
    name: doc.name,
    layoutRevision: doc.layoutRevision ?? 1,
  }));
}

/**
 * Broadcast layout updates to a room channel and invalidate cache across nodes.
 */
export function notifyLayoutBroadcast(io, roomWire) {
  if (!io) return;
  io.to(roomWire.roomId).emit('room:layout', {
    roomId: roomWire.roomId,
    layoutRevision: roomWire.layoutRevision,
    obstacles: roomWire.obstacles,
  });
  invalidateRoomCache(roomWire.roomId);
  // serverSideEmit is supported across multiple server instances with RedisAdapter
  const adapter = io.of?.('/')?.adapter;
  if (typeof io.serverSideEmit === 'function' && (adapter?.pubClient || adapter?.allRooms)) {
    try {
      io.serverSideEmit('room:cache:invalidate', roomWire.roomId);
    } catch {
      // safe fallback if adapter cannot deliver
    }
  }
}

/**
 * Atomically saves an updated layout for an existing room with revision conflict detection.
 *
 * @param {string} roomId
 * @param {object} payload - { expectedRevision, obstacles, name?, description? }
 * @param {object} [options]
 * @param {object} [options.io] - optional Socket.io instance for live sync broadcast
 * @returns {Promise<object>} updated room in wire format
 */
export async function saveLayout(roomId, payload, { io = null } = {}) {
  const key = String(roomId ?? '').trim().toLowerCase();
  if (!key) {
    throw new ValidationError('"roomId" is required', { path: 'roomId' });
  }

  // 1. Verify existence and retrieve immutable room dimensions
  const existing = await Room.findOne({ roomId: key }).lean();
  if (!existing) {
    throw new RoomNotFoundError(key);
  }

  // 2. Validate payload using shared validator against room dimensions
  const validated = validateLayoutPayload(payload, {
    room: existing,
    maxObstacles: config.room.maxObstacles,
    requireExpectedRevision: true,
  });

  const expectedRevision = validated.expectedRevision;

  // 3. Atomic MongoDB update with revision in filter
  // Handles legacy documents without a valid layoutRevision as revision 1
  const revisionFilter = expectedRevision === 1
    ? {
        $or: [
          { layoutRevision: 1 },
          { layoutRevision: { $exists: false } },
          { layoutRevision: null },
          { layoutRevision: { $lt: 1 } },
        ],
      }
    : { layoutRevision: expectedRevision };

  const updateSet = {
    obstacles: validated.obstacles,
    layoutRevision: expectedRevision + 1,
  };
  if (validated.name !== undefined) updateSet.name = validated.name;
  if (validated.description !== undefined) updateSet.description = validated.description;

  const updatedDoc = await Room.findOneAndUpdate(
    { roomId: key, ...revisionFilter },
    { $set: updateSet },
    { new: true, runValidators: true },
  ).lean();

  if (!updatedDoc) {
    // Determine if room disappeared or if revision conflicted
    const current = await Room.findOne({ roomId: key }).lean();
    if (!current) {
      throw new RoomNotFoundError(key);
    }
    const currentRevision = current.layoutRevision ?? 1;
    throw new RevisionConflictError(key, expectedRevision, currentRevision);
  }

  const wire = toRoomWire(updatedDoc);
  cache.set(key, wire);

  if (io) {
    notifyLayoutBroadcast(io, wire);
  }

  return wire;
}

export function invalidateRoomCache(roomId) {
  if (roomId) cache.delete(roomId);
  else cache.clear();
}

/**
 * Safely backfill legacy room documents that lack `layoutRevision`.
 * Idempotent, atomic across instances, and prevents duplicate-write races.
 */
export async function backfillLegacyRoomRevisions() {
  const result = await Room.updateMany(
    {
      $or: [
        { layoutRevision: { $exists: false } },
        { layoutRevision: null },
        { layoutRevision: { $lt: 1 } },
      ],
    },
    { $set: { layoutRevision: 1 } },
  );
  return { modifiedCount: result.modifiedCount ?? 0 };
}

