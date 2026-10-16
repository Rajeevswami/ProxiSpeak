import config from '../config/index.js';
import UserPresence from '../models/UserPresence.js';
import logger from '../utils/logger.js';

export function cleanupOnBoot(instanceId = config.server.instanceId) {
  return UserPresence.deleteMany({ instanceId });
}

export async function cleanupStale(io, { instanceId = config.server.instanceId, now = Date.now(),
  timeoutMs = config.presence.timeoutMs } = {}) {
  const cutoff = new Date(now - timeoutMs);
  const rows = await UserPresence.find({ instanceId, lastSeen: { $lt: cutoff } }).lean();
  for (const row of rows) {
    // Recheck the timestamp atomically: a concurrent heartbeat must win.
    const result = await UserPresence.deleteOne({
      _id: row._id, roomId: row.roomId, instanceId, lastSeen: { $lt: cutoff },
    });
    if (!result.deletedCount) continue;
    const socket = io.sockets?.sockets.get(row.sessionId);
    if (socket?.data.roomId === row.roomId) {
      socket.data.presenceExpired = true;
      socket.data.expiryAnnounced = true;
    }
    io.to(row.roomId).emit('user:left', { id: row.sessionId });
    // Close the transport, not socket.disconnect(true): an explicit namespace
    // disconnect disables Socket.IO's automatic reconnection on the client.
    if (socket?.data.roomId === row.roomId) socket.conn.close();
  }
}

export function startPresenceCleanup(io) {
  let running;
  const timer = setInterval(() => {
    if (running) return;
    running = cleanupStale(io).catch((err) => logger.error('presence sweep failed:', err.message))
      .finally(() => { running = null; });
  }, config.presence.cleanupIntervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
