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
import { distancePx } from '../utils/geo.js';

export async function sweepOrphanEdges(
  io,
  {
    edgeStore = io?.edgeStore,
    presenceModel = UserPresence,
    logger: baseLogger = logger,
    validationLimit = 100,
    validationOffset = 0,
    dropRadiusPx = io?.peerGraph?.dropRadiusPx ?? config.proximity.peerDisconnectRadiusPx,
  } = {},
) {
  if (!edgeStore) return { removedEdges: 0, cleanedUsers: 0, validationRemovals: 0, nextValidationOffset: 0 };
  const batchLimit = Number.isInteger(validationLimit)
    ? Math.max(0, Math.min(100, validationLimit))
    : 100;
  const batchOffset = Number.isInteger(validationOffset) && validationOffset > 0 ? validationOffset : 0;
  const log = typeof baseLogger.child === 'function' ? baseLogger.child('edge-sweep') : baseLogger;

  const edges = await edgeStore.allEdges();
  const pairUsers = typeof edgeStore.trackedPairUsers === 'function'
    ? await edgeStore.trackedPairUsers()
    : [];

  // Keep the existing "empty store means reconcile" trigger unchanged. Revision
  // keys are removed by removeUser and otherwise expire under the same TTL.
  const candidateIds = new Set(pairUsers);
  for (const edge of edges) {
    candidateIds.add(edge.a);
    candidateIds.add(edge.b);
  }
  if (candidateIds.size === 0) {
    if (io?.peerGraph?.rooms?.size) {
      await io.peerGraph.reconcileLocalUsers();
    }
    return { removedEdges: 0, cleanedUsers: 0, validationRemovals: 0, nextValidationOffset: 0 };
  }

  // Revisions are read before positions: accepted moves write presence first
  // and bump second. A later position/revision change therefore makes the
  // fenced remove stale instead of deleting an edge that has become valid.
  const positionRevisions = typeof edgeStore.getPositionRevisions === 'function'
    ? await edgeStore.getPositionRevisions([...candidateIds])
    : null;
  const liveRows = await presenceModel
    .find({ sessionId: { $in: [...candidateIds] } })
    .lean();
  const liveSessionRooms = new Map();
  const livePresenceById = new Map();
  for (const row of liveRows) {
    liveSessionRooms.set(row.sessionId, row.roomId);
    livePresenceById.set(row.sessionId, row);
  }

  const emitDisconnect = (removed) => {
    for (const [recipient, peerId] of [[removed.a, removed.b], [removed.b, removed.a]]) {
      io?.to?.(recipient)?.emit?.('peer:disconnect', {
        peerId,
        generation: removed.generation,
      });
    }
  };

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
    emitDisconnect(outcome.edge);
  }

  // Bounded safety net for the stale-read race. `edges` came from the store's
  // SCAN-based reader; only this rotating slice performs distance validation.
  const liveEdges = edges.filter((edge) =>
    liveSessionRooms.get(edge.a) === edge.roomId && liveSessionRooms.get(edge.b) === edge.roomId);
  const validationStart = liveEdges.length > 0 ? batchOffset % liveEdges.length : 0;
  const validationBatch = [];
  for (let index = 0; index < Math.min(batchLimit, liveEdges.length); index += 1) {
    validationBatch.push(liveEdges[(validationStart + index) % liveEdges.length]);
  }
  let validationRemovals = 0;
  for (const edge of validationBatch) {
    const a = livePresenceById.get(edge.a);
    const b = livePresenceById.get(edge.b);
    if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) continue;
    if (distancePx(a.x, a.y, b.x, b.y) <= dropRadiusPx) continue;
    const expectedRevisions = positionRevisions
      ? {
          [edge.a]: positionRevisions.get(edge.a) ?? 0,
          [edge.b]: positionRevisions.get(edge.b) ?? 0,
        }
      : undefined;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await edgeStore.removeEdgeWithRecord(
      edge.roomId,
      edge.a,
      edge.b,
      expectedRevisions ? { expectedRevisions } : undefined,
    );
    if (!outcome.removed || !outcome.edge) continue;
    validationRemovals += 1;
    removedEdges += 1;
    if (io?.peerGraph?.meshCounters) {
      const counters = io.peerGraph.meshCounters;
      counters.validationRemovals = (counters.validationRemovals ?? 0) + 1;
    }
    emitDisconnect(outcome.edge);
  }
  const nextValidationOffset = liveEdges.length > 0
    ? (validationStart + validationBatch.length) % liveEdges.length
    : 0;

  let cleanedUsers = 0;
  for (const userId of candidateIds) {
    if (liveSessionRooms.has(userId)) continue;
    // eslint-disable-next-line no-await-in-loop
    await edgeStore.removeUser(userId);
    io?.peerGraph?.dropLocalUser?.(undefined, userId);
    cleanedUsers += 1;
  }

  if (removedEdges > 0 || cleanedUsers > 0) {
    log.info(`Swept ${removedEdges - validationRemovals} orphan edge(s), ${validationRemovals} out-of-range edge(s), `
      + `and ${cleanedUsers} departed user keyset(s)`);
  }
  return { removedEdges, cleanedUsers, validationRemovals, nextValidationOffset };
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
  let validationOffset = 0;

  const trigger = () => {
    if (running) return running;
    running = sweepOrphanEdges(io, { presenceModel, logger: baseLogger, validationOffset })
      .then((result) => {
        validationOffset = result.nextValidationOffset ?? 0;
        return result;
      })
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
