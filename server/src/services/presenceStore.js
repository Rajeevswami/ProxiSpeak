/**
 * Avatar position persistence (Day-2 slice of the presence store).
 *
 * The geospatial schema only needs two MongoDB writes to be useful: upsert one
 * avatar's position (pixel coordinates plus the projected GeoJSON point that
 * the 2dsphere index is built on) and remove one avatar.
 *
 * The in-memory hot path, the batched flush interval and the stale-presence
 * sweeps arrive with the Socket.io presence day; the $near / $geoWithin reads
 * arrive with the proximity services. Nothing here queries by location yet.
 */
import { livePresenceFilter } from './proximityService.js';
import UserPresence from '../models/UserPresence.js';

/** Everything needed to rebuild a MongoDB document for one user. */
export function toPresenceDocument(user, transform) {
  const [lon, lat] = transform.pixelToGeo(user.x, user.y);
  return {
    sessionId: user.id,
    instanceId: user.instanceId ?? '',
    roomId: user.roomId,
    name: user.name,
    color: user.color,
    avatar: user.avatar ?? 'circle',
    x: user.x,
    y: user.y,
    angle: user.angle ?? 0,
    location: { type: 'Point', coordinates: [lon, lat] },
    micEnabled: user.micEnabled !== false,
    lastSeen: new Date(user.lastSeen ?? Date.now()),
  };
}

/**
 * Upsert one user's position. The filter is the unique (sessionId, roomId)
 * pair. Joins may insert; moves must pass { upsert: false } and inspect
 * matchedCount so an expired session cannot silently re-admit itself. The
 * GeoJSON point always agrees with the authoritative x/y pixels.
 */
export async function upsertPosition(user, transform, { upsert = true } = {}) {
  const doc = toPresenceDocument(user, transform);
  return UserPresence.updateOne(
    { sessionId: doc.sessionId, roomId: doc.roomId, ...(!upsert ? { instanceId: doc.instanceId } : {}) },
    { $set: doc },
    { upsert },
  );
}

/**
 * Delete a user's presence document (called when the socket disconnects).
 * `sessionId` is the socket id, which is unique per connection, so a
 * disconnect can only ever remove its own document — a reconnect (new socket
 * id) has a document of its own and survives this call.
 */
export async function removeUser(sessionId) {
  return UserPresence.deleteOne({ sessionId });
}

/**
 * Every presence row of one room, oldest first. The socket layer uses this to
 * answer a `join` with the room as it currently stands. Callers map the rows
 * to the wire format, so database-only fields never leave the server.
 */
export async function listPresenceByRoom(roomId) {
  return UserPresence.find({ roomId, ...livePresenceFilter() }).sort({ createdAt: 1, _id: 1 }).lean();
}

/** Engine.IO pong refresh; never recreate a row already removed by cleanup. */
export function refreshLastSeen(sessionId, roomId, instanceId, now = Date.now()) {
  return UserPresence.updateOne({ sessionId, roomId, instanceId }, { $set: { lastSeen: new Date(now) } });
}
