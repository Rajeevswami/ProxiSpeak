/**
 * Pure pixel-distance audio attenuation helpers (Week 3, Day 11).
 * No browser, DOM, React or audio-node dependencies.
 */

const DEFAULT_INNER_PX = 30;
const DEFAULT_OUTER_PX = 100;

/**
 * Smoothly attenuate from full volume at innerPx to silence at outerPx.
 * Smoothstep has zero slope at both boundaries, avoiding an audible edge.
 * Invalid input is deliberately silent rather than throwing.
 *
 * @param {number} distancePx Euclidean distance in world pixels
 * @param {{innerPx?: number, outerPx?: number}} [options]
 * @returns {number} gain in [0, 1]
 */
export function gainForDistance(distancePx, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 0;
  const { innerPx = DEFAULT_INNER_PX, outerPx = DEFAULT_OUTER_PX } = options;
  if (
    typeof distancePx !== 'number' || !Number.isFinite(distancePx) || distancePx < 0 ||
    typeof innerPx !== 'number' || !Number.isFinite(innerPx) || innerPx < 0 ||
    typeof outerPx !== 'number' || !Number.isFinite(outerPx) || outerPx < 0
  ) return 0;

  if (distancePx <= innerPx) return 1;
  if (distancePx >= outerPx || innerPx >= outerPx) return 0;

  const t = (distancePx - innerPx) / (outerPx - innerPx);
  return 1 - (t * t * (3 - 2 * t));
}

/**
 * Euclidean distance between two world-pixel positions.
 * Returns NaN when either point is absent or has invalid coordinates.
 */
export function distanceBetween(a, b) {
  if (
    !a || !b ||
    typeof a.x !== 'number' || !Number.isFinite(a.x) ||
    typeof a.y !== 'number' || !Number.isFinite(a.y) ||
    typeof b.x !== 'number' || !Number.isFinite(b.x) ||
    typeof b.y !== 'number' || !Number.isFinite(b.y)
  ) return NaN;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default gainForDistance;
