import config from '../config/index.js';
import UserPresence from '../models/UserPresence.js';
import logger from '../utils/logger.js';

export function cleanupOnBoot(
  instanceId = config.server.instanceId,
  { presenceModel = UserPresence } = {},
) {
  return presenceModel.deleteMany({ instanceId });
}

export async function cleanupStale(
  io,
  {
    instanceId = config.server.instanceId,
    multiInstance = Boolean(io?.multiInstance),
    presenceModel = UserPresence,
    now = Date.now(),
    timeoutMs = config.presence.timeoutMs,
  } = {},
) {
  const cutoff = new Date(now - timeoutMs);
  const query = multiInstance
    ? { lastSeen: { $lt: cutoff } }
    : { instanceId, lastSeen: { $lt: cutoff } };

  const rows = await presenceModel.find(query).lean();
  for (const row of rows) {
    // Claim the stale row atomically per document so concurrent sweeps across
    // instances elect at most one winner, and a concurrent heartbeat still wins.
    const deleteFilter = multiInstance
      ? { _id: row._id, roomId: row.roomId, lastSeen: { $lt: cutoff } }
      : { _id: row._id, roomId: row.roomId, instanceId, lastSeen: { $lt: cutoff } };
    const result = await presenceModel.deleteOne(deleteFilter);
    if (!result.deletedCount) continue;

    const socket = io.sockets?.sockets.get(row.sessionId);
    if (socket?.data.roomId === row.roomId) {
      socket.data.presenceExpired = true;
      socket.data.expiryAnnounced = true;
    }

    // Drop this user's peer edges before announcing departure so remaining peers
    // receive peer:disconnect once from the single winning instance.
    try {
      await io.removePeerEdges?.(row.roomId, row.sessionId);
    } catch (err) {
      logger.error('peer graph expiry cleanup failed:', err?.message ?? err);
    }

    io.to(row.roomId).emit('user:left', { id: row.sessionId });

    // Close the transport (locally or across instances via io.serverSideEmit),
    // never socket.disconnect(true), so client auto-reconnect + session recovery run.
    if (typeof io.closeRemoteSocket === 'function') {
      io.closeRemoteSocket(row.roomId, row.sessionId);
    } else if (socket?.data.roomId === row.roomId) {
      socket.conn.close();
    }
  }
}

export function startPresenceCleanup(io, options = {}) {
  let running;
  const timer = setInterval(() => {
    if (running) return;
    running = cleanupStale(io, options)
      .catch((err) => logger.error('presence sweep failed:', err?.message ?? err))
      .finally(() => {
        running = null;
      });
  }, config.presence.cleanupIntervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
