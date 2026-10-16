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
