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
  const maximum = Math.hypot(config.world.width, config.world.height);
  if (!Number.isFinite(radiusPx) || radiusPx < 0 || radiusPx > maximum) {
    throw new RangeError(`radiusPx must be finite and within [0, ${maximum}]`);
  }
}

function validateRoom(roomId) {
  if (typeof roomId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(roomId)) {
    throw new TypeError('roomId must be a normalized room identifier');
  }
}

function validateUser(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new TypeError('userId must be a session identifier');
  }
}

function validateCenter(center) {
  if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y) ||
      center.x < 0 || center.x > config.world.width || center.y < 0 || center.y > config.world.height) {
    throw new TypeError('center must contain finite x/y within the configured world');
  }
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
    validateRoom(roomId);
    validateUser(userId);
    validateRadius(radiusPx);
    const live = livePresenceFilter();
    const center = await UserPresence.findOne({ roomId, sessionId: userId, ...live }).lean();
    if (!center) return [];
    return neighbors(roomId, center, radiusPx, live);
  });
}

export function nearQuery(roomId, center, radiusPx = config.proximity.radiusPx, live = livePresenceFilter()) {
  validateRoom(roomId);
  validateCenter(center);
  validateUser(center.sessionId);
  return {
    ...live, roomId, sessionId: { $ne: center.sessionId },
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

/** Query object behind countWithin (exported so the audit can explain it). */
export function geoWithinQuery(roomId, center, radiusPx = config.proximity.radiusPx, live = livePresenceFilter()) {
  validateRoom(roomId);
  validateCenter(center);
  validateRadius(radiusPx);
  return {
    roomId, ...live,
    location: { $geoWithin: geo.centerSphere(center.x, center.y, candidateRadius(radiusPx)) },
  };
}

/** Pixel centre { x, y }; includes a user at the centre itself. */
export function countWithin(roomId, center, radiusPx = config.proximity.radiusPx) {
  return timed('countWithin', async () => {
    const rows = await UserPresence.find(geoWithinQuery(roomId, center, radiusPx)).select('x y').lean();
    return rows.filter((row) => distancePx(center.x, center.y, row.x, row.y) <= radiusPx).length;
  });
}

/** Connected components, not cliques: A-B-C remains one conversation. */
export function computeClusters(roomId, radiusPx = config.proximity.radiusPx) {
  return timed('computeClusters', async () => {
    validateRoom(roomId);
    validateRadius(radiusPx);
    // One lean roster query: live presence rows of this room, projected to
    // id/x/y only. Clustering then happens exactly in memory (see grid below);
    // $near/$geoWithin remain the tools for per-user discovery and counting.
    const rows = await UserPresence.find({ roomId, ...livePresenceFilter() })
      .select('sessionId x y -_id').lean();
    const users = rows
      .map((row) => ({ id: row.sessionId, x: row.x, y: row.y }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // Union-find over connected components.
    const parent = users.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      while (parent[index] !== root) { const next = parent[index]; parent[index] = root; index = next; }
      return root;
    };
    const union = (a, b) => {
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    // In-memory spatial grid, cell size = radius: any pair within `radius`
    // must lie in the same or an adjacent cell, so only the 3x3 neighbourhood
    // of already-inserted users is checked, each with the exact pixel
    // Euclidean test (distance <= radius). Average O(n) for bounded density.
    const cell = radiusPx > 0 ? radiusPx : 1;
    const grid = new Map();
    users.forEach((user, index) => {
      const cx = Math.floor(user.x / cell);
      const cy = Math.floor(user.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const otherIndex of grid.get(`${gx},${gy}`) ?? []) {
            const other = users[otherIndex];
            if (distancePx(user.x, user.y, other.x, other.y) <= radiusPx) union(index, otherIndex);
          }
        }
      }
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(index);
    });

    const components = new Map();
    users.forEach((user, index) => {
      const root = find(index);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(user.id);
    });
    return [...components.values()].map((cluster) => cluster.sort());
  });
}

/**
 * Legacy $near-per-user clustering, kept ONLY as an independent cross-check
 * for tests and the spatial audit. Not used by the peer graph or hot paths.
 */
export function computeClustersViaNear(roomId, radiusPx = config.proximity.radiusPx) {
  return timed('computeClustersViaNear', async () => {
    validateRoom(roomId);
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
    // One final roster read drops vanished/stale ids without redesigning or
    // splitting components assembled from the earlier, eventually consistent reads.
    const remaining = await UserPresence.find({
      roomId, ...livePresenceFilter(), sessionId: { $in: clusters.flat() },
    }).select('sessionId').lean();
    const existing = new Set(remaining.map((user) => user.sessionId));
    return clusters.map((cluster) => cluster.filter((id) => existing.has(id)))
      .filter((cluster) => cluster.length > 0);
  });
}
