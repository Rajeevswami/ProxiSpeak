import { performance } from 'node:perf_hooks';
import config from '../config/index.js';
import UserPresence from '../models/UserPresence.js';
import { createGeoTransform, distancePx } from '../utils/geo.js';
import logger from '../utils/logger.js';

const geo = createGeoTransform(config.world);
export const livePresenceFilter = (now = Date.now()) => ({
  lastSeen: { $gte: new Date(now - config.presence.timeoutMs) },
});

function validateRadius(radiusPx) {
  if (!Number.isFinite(radiusPx) || radiusPx < 0) throw new RangeError('radiusPx must be finite and nonnegative');
}

// Equirectangular longitude scale varies with latitude. Overselect candidates
// using the worst scale across this world's latitude span, plus numeric slack.
// Authoritative pixel filtering below removes the resulting false positives.
function candidateRadius(radiusPx) {
  validateRadius(radiusPx);
  const latitudes = [geo.pixelToGeo(0, 0)[1], geo.pixelToGeo(0, config.world.height)[1]];
  const scale = Math.max(1, ...latitudes.map((lat) =>
    Math.abs(Math.cos(lat * Math.PI / 180) / Math.cos(config.world.centerLat * Math.PI / 180))));
  return radiusPx * scale + 0.01;
}

async function timed(name, operation) {
  const start = performance.now();
  try { return await operation(); }
  finally { logger.debug(`${name} query time: ${(performance.now() - start).toFixed(3)} ms`); }
}

/** Session ids are the public user ids; distancePx is authoritative. */
export function findNearby(roomId, userId, radiusPx = config.proximity.radiusPx) {
  return timed('findNearby', async () => {
    validateRadius(radiusPx);
    const live = livePresenceFilter();
    const center = await UserPresence.findOne({ roomId, sessionId: userId, ...live }).lean();
    if (!center) return [];
    return neighbors(roomId, center, radiusPx, live);
  });
}

export function nearQuery(roomId, center, radiusPx = config.proximity.radiusPx, live = livePresenceFilter()) {
  return {
    roomId, ...live, sessionId: { $ne: center.sessionId },
    location: { $near: {
      $geometry: geo.point(center.x, center.y),
      $maxDistance: geo.maxDistanceMeters(candidateRadius(radiusPx)),
    } },
  };
}

async function neighbors(roomId, center, radiusPx, live) {
  const rows = await UserPresence.find(nearQuery(roomId, center, radiusPx, live)).lean();
  return rows.map((row) => ({
    id: row.sessionId, distancePx: distancePx(center.x, center.y, row.x, row.y),
  })).filter((row) => row.distancePx <= radiusPx)
    .sort((a, b) => a.distancePx - b.distancePx || a.id.localeCompare(b.id));
}

/** Pixel centre { x, y }; includes a user at the centre itself. */
export function countWithin(roomId, center, radiusPx = config.proximity.radiusPx) {
  return timed('countWithin', async () => {
    if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) throw new TypeError('center must contain finite x/y');
    const rows = await UserPresence.find({
      roomId, ...livePresenceFilter(),
      location: { $geoWithin: geo.centerSphere(center.x, center.y, candidateRadius(radiusPx)) },
    }).select('x y').lean();
    return rows.filter((row) => distancePx(center.x, center.y, row.x, row.y) <= radiusPx).length;
  });
}

/** Connected components, not cliques: A-B-C remains one conversation. */
export function computeClusters(roomId, radiusPx = config.proximity.radiusPx) {
  return timed('computeClusters', async () => {
    validateRadius(radiusPx);
    const live = livePresenceFilter();
    const users = await UserPresence.find({ roomId, ...live }).sort({ sessionId: 1 }).lean();
    const graph = new Map(await Promise.all(users.map(async (user) => [
      user.sessionId, await neighbors(roomId, user, radiusPx, live),
    ])));
    const visited = new Set();
    const clusters = [];
    for (const user of users) {
      if (visited.has(user.sessionId)) continue;
      const cluster = [], queue = [user.sessionId];
      visited.add(user.sessionId);
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        cluster.push(id);
        for (const neighbor of graph.get(id) ?? []) {
          if (!graph.has(neighbor.id) || visited.has(neighbor.id)) continue;
          visited.add(neighbor.id);
          queue.push(neighbor.id);
        }
      }
      clusters.push(cluster.sort());
    }
    return clusters;
  });
}
