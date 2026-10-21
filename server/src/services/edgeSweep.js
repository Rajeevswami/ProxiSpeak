/**
 * Orphan edge sweeper (`kill -9` / hard crash recovery — Week 3, Day 12).
 *
 * When a Node process dies abruptly (`SIGKILL`, OOM, host loss), its sockets
 * never run `disconnect`, leaving live `<prefix>:edge:*`, `<prefix>:gen:*`,
 * `<prefix>:user-edges:*`, and `<prefix>:user-pairs:*` keys in Redis.
 *
 * `sweepOrphanEdges` scans edge/pair keys strictly via cursor-based `SCAN`
 * (`KEYS` is never used), cross-checks active sessions in `UserPresence`,
 * removes stale edges atomically so at most one instance emits
 * `peer:disconnect` to surviving peers, and purges leftover per-user sets.
 */
import config from '../config/index.js';
import UserPresence from '../models/UserPresence.js';
import logger from '../utils/logger.js';

export async function sweepOrphanEdges(
  io,
  {
    edgeStore = io?.edgeStore,
    presenceModel = UserPresence,
    logger: baseLogger = logger,
  } = {},
) {
  if (!edgeStore) return { removedEdges: 0, cleanedUsers: 0 };
  const log = typeof baseLogger.child === 'function' ? baseLogger.child('edge-sweep') : baseLogger;

  const edges = await edgeStore.allEdges();
  const pairUsers = typeof edgeStore.trackedPairUsers === 'function'
    ? await edgeStore.trackedPairUsers()
    : [];

  const candidateIds = new Set(pairUsers);
  for (const edge of edges) {
    candidateIds.add(edge.a);
    candidateIds.add(edge.b);
  }
  if (candidateIds.size === 0) {
    return { removedEdges: 0, cleanedUsers: 0 };
  }

  const liveRows = await presenceModel
    .find({ sessionId: { $in: [...candidateIds] } })
    .lean();
  const liveSessionRooms = new Map();
  for (const row of liveRows) {
    liveSessionRooms.set(row.sessionId, row.roomId);
  }

  let removedEdges = 0;
  for (const edge of edges) {
    const aAlive = liveSessionRooms.get(edge.a) === edge.roomId;
    const bAlive = liveSessionRooms.get(edge.b) === edge.roomId;
    if (aAlive && bAlive) continue;

    // Atomic removal: across N sweeping instances, at most ONE instance receives
    // `outcome.removed === true` and emits `peer:disconnect` to survivors.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await edgeStore.removeEdgeWithRecord(edge.roomId, edge.a, edge.b);
    if (!outcome.removed || !outcome.edge) continue;

    removedEdges += 1;
    const removed = outcome.edge;
    for (const [recipient, peerId] of [[removed.a, removed.b], [removed.b, removed.a]]) {
      io?.to?.(recipient)?.emit?.('peer:disconnect', {
        peerId,
        generation: removed.generation,
      });
    }
  }

  let cleanedUsers = 0;
  for (const userId of candidateIds) {
    if (liveSessionRooms.has(userId)) continue;
    // eslint-disable-next-line no-await-in-loop
    await edgeStore.removeUser(userId);
    io?.peerGraph?.dropLocalUser?.(undefined, userId);
    cleanedUsers += 1;
  }

  if (removedEdges > 0 || cleanedUsers > 0) {
    log.info(`Swept ${removedEdges} orphan edge(s) and ${cleanedUsers} departed user keyset(s)`);
  }
  return { removedEdges, cleanedUsers };
}

export function startOrphanEdgeSweep(
  io,
  {
    intervalMs = config.redis.edgeSweepIntervalMs,
    presenceModel = UserPresence,
    logger: baseLogger = logger,
    runOnStart = true,
  } = {},
) {
  const log = typeof baseLogger.child === 'function' ? baseLogger.child('edge-sweep') : baseLogger;
  let running = null;

  const trigger = () => {
    if (running) return running;
    running = sweepOrphanEdges(io, { presenceModel, logger: baseLogger })
      .catch((err) => log.warn('orphan edge sweep failed:', err?.message ?? err))
      .finally(() => {
        running = null;
      });
    return running;
  };

  if (runOnStart) {
    void trigger();
  }

  const timer = setInterval(() => {
    void trigger();
  }, intervalMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await running;
  };
}
