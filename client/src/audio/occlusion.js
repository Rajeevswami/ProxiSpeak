/**
 * Pure 2D line-of-sight geometry and sound transmission through blocking
 * obstacles — Week 3 (Day 16).
 * No browser, DOM, React or Web Audio dependencies; zero allocations in the hot path.
 */
import { distanceBetween, gainForDistance } from './attenuation.js';

/**
 * Relative parametric tolerance (4 ULPs in t-space, ~8.88e-16) for Liang-Barsky
 * division comparisons so segments grazing a corner in IEEE-754 float64 are not
 * rejected by 1-2 ULP rounding.
 */
export const PARAM_EPSILON = 4 * Number.EPSILON;

const PREPARED_SET = new WeakSet();
const EMPTY_PREPARED = Object.freeze([]);
PREPARED_SET.add(EMPTY_PREPARED);

let moduleCachedRevision = null;
let moduleCachedPrepared = EMPTY_PREPARED;

/**
 * Exact Liang-Barsky test on already-validated, canonicalized endpoints (ax <= bx)
 * whose bounding box is already known to overlap [minX, maxX] x [minY, maxY].
 */
function clipCanonicalSegmentToBounds(ax, ay, bx, by, minX, minY, maxX, maxY) {
  const dx = bx - ax;
  const dy = by - ay;

  // Vertical, horizontal and zero-length segments whose closed bounding box
  // overlaps [minX, maxX] x [minY, maxY] necessarily intersect the closed
  // rectangle; return immediately without any division.
  if (dx === 0 || dy === 0) return true;

  let t0 = 0;
  let t1 = 1;

  // Canonicalization guarantees dx > 0: left edge enters, right edge exits.
  const txEnter = (minX - ax) / dx;
  const txExit = (maxX - ax) / dx;
  if (txEnter > t0) t0 = txEnter;
  if (txExit < t1) t1 = txExit;
  if (t0 > t1 + PARAM_EPSILON) return false;

  let tyEnter;
  let tyExit;
  if (dy > 0) {
    tyEnter = (minY - ay) / dy;
    tyExit = (maxY - ay) / dy;
  } else {
    tyEnter = (maxY - ay) / dy;
    tyExit = (minY - ay) / dy;
  }
  if (tyEnter > t0) t0 = tyEnter;
  if (tyExit < t1) t1 = tyExit;

  return t0 <= t1 + PARAM_EPSILON;
}

/**
 * Test whether the CLOSED line segment [(ax, ay), (bx, by)] intersects the
 * CLOSED axis-aligned rectangle [rect.x, rect.x + rect.w] x [rect.y, rect.y + rect.h].
 *
 * Semantics:
 * - Touching an edge or corner counts as intersecting.
 * - Either or both endpoints inside the rectangle counts as intersecting.
 * - A zero-length segment (ax === bx && ay === by) intersects iff the point lies
 *   inside or on the boundary of the rectangle.
 * - Canonicalizes endpoint order first so swapping A and B produces identical results.
 * - Invalid coordinates or non-positive rectangle dimensions return false without throwing.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {boolean}
 */
export function segmentIntersectsRect(ax, ay, bx, by, rect) {
  if (
    !rect ||
    typeof ax !== 'number' || !Number.isFinite(ax) ||
    typeof ay !== 'number' || !Number.isFinite(ay) ||
    typeof bx !== 'number' || !Number.isFinite(bx) ||
    typeof by !== 'number' || !Number.isFinite(by) ||
    typeof rect.x !== 'number' || !Number.isFinite(rect.x) ||
    typeof rect.y !== 'number' || !Number.isFinite(rect.y) ||
    typeof rect.w !== 'number' || !Number.isFinite(rect.w) || rect.w <= 0 ||
    typeof rect.h !== 'number' || !Number.isFinite(rect.h) || rect.h <= 0
  ) {
    return false;
  }

  const minX = rect.x;
  const maxX = minX + rect.w;
  const minY = rect.y;
  const maxY = minY + rect.h;
  if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) return false;

  if (ax > bx || (ax === bx && ay > by)) {
    const tmpX = ax;
    ax = bx;
    bx = tmpX;
    const tmpY = ay;
    ay = by;
    by = tmpY;
  }

  // Closed bounding-box pre-check (ax <= bx after canonicalization).
  if (bx < minX || ax > maxX) return false;
  const segMinY = ay <= by ? ay : by;
  const segMaxY = ay <= by ? by : ay;
  if (segMaxY < minY || segMinY > maxY) return false;

  return clipCanonicalSegmentToBounds(ax, ay, bx, by, minX, minY, maxX, maxY);
}

/**
 * Normalize a room's obstacle list into a compact array of valid sound-blocking
 * rectangles (`blocksAudio === true`, finite x/y/w/h, w > 0, h > 0, finite
 * attenuation clamped to [0, 1]). Invalid or non-blocking entries are skipped
 * without throwing, and duplicate obstacle references or duplicate string IDs
 * are deduplicated so each obstacle is counted at most once.
 *
 * When a finite `layoutRevision` is supplied, the normalized array is cached by
 * revision so repeated calls on the same revision reuse the prepared array.
 *
 * @param {Array<object>|null|undefined} obstacles
 * @param {number} [layoutRevision]
 * @returns {ReadonlyArray<{id: string|null, x: number, y: number, w: number, h: number, maxX: number, maxY: number, attenuation: number}>}
 */
export function prepareObstacles(obstacles, layoutRevision) {
  const hasRevision = typeof layoutRevision === 'number' && Number.isFinite(layoutRevision);
  if (hasRevision && moduleCachedRevision === layoutRevision) {
    return moduleCachedPrepared;
  }

  if (PREPARED_SET.has(obstacles)) {
    if (hasRevision) {
      moduleCachedRevision = layoutRevision;
      moduleCachedPrepared = obstacles;
    }
    return obstacles;
  }

  if (!Array.isArray(obstacles) || obstacles.length === 0) {
    if (hasRevision) {
      moduleCachedRevision = layoutRevision;
      moduleCachedPrepared = EMPTY_PREPARED;
    }
    return EMPTY_PREPARED;
  }

  const normalized = [];
  const seenObjects = new Set();
  const seenIds = new Set();

  for (let i = 0; i < obstacles.length; i += 1) {
    const item = obstacles[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (seenObjects.has(item)) continue;
    seenObjects.add(item);

    if (item.blocksAudio !== true) continue;

    const { x, y, w, h, attenuation: rawAttenuation } = item;
    if (
      typeof x !== 'number' || !Number.isFinite(x) ||
      typeof y !== 'number' || !Number.isFinite(y) ||
      typeof w !== 'number' || !Number.isFinite(w) || w <= 0 ||
      typeof h !== 'number' || !Number.isFinite(h) || h <= 0 ||
      typeof rawAttenuation !== 'number' || !Number.isFinite(rawAttenuation)
    ) {
      continue;
    }

    const maxX = x + w;
    const maxY = y + h;
    if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) continue;

    let id = null;
    if (typeof item.id === 'string' && item.id.length > 0) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      id = item.id;
    }

    const attenuation = rawAttenuation < 0 ? 0 : rawAttenuation > 1 ? 1 : rawAttenuation;
    normalized.push({ id, x, y, w, h, maxX, maxY, attenuation });
  }

  const result = normalized.length === 0 ? EMPTY_PREPARED : Object.freeze(normalized);
  PREPARED_SET.add(result);

  if (hasRevision) {
    moduleCachedRevision = layoutRevision;
    moduleCachedPrepared = result;
  }

  return result;
}

/**
 * Create an isolated per-mixer obstacle cache keyed by room identity and
 * `layoutRevision` so `prepareObstacles` runs only when a layout changes.
 */
export function createObstacleCache() {
  let cachedRoomId = null;
  let cachedRevision = null;
  let cachedObstaclesRef = null;
  let cachedPrepared = EMPTY_PREPARED;
  let prepareCount = 0;

  return {
    resolve(roomOrObstacles) {
      if (!roomOrObstacles) return EMPTY_PREPARED;

      if (PREPARED_SET.has(roomOrObstacles)) return roomOrObstacles;

      if (Array.isArray(roomOrObstacles)) {
        if (roomOrObstacles.length === 0) return EMPTY_PREPARED;
        if (cachedRevision === null && cachedRoomId === null && cachedObstaclesRef === roomOrObstacles) {
          return cachedPrepared;
        }
        cachedRoomId = null;
        cachedRevision = null;
        cachedObstaclesRef = roomOrObstacles;
        cachedPrepared = prepareObstacles(roomOrObstacles);
        prepareCount += 1;
        return cachedPrepared;
      }

      if (typeof roomOrObstacles !== 'object') return EMPTY_PREPARED;

      const roomId = typeof roomOrObstacles.roomId === 'string' ? roomOrObstacles.roomId : null;
      const revision = typeof roomOrObstacles.layoutRevision === 'number' && Number.isFinite(roomOrObstacles.layoutRevision)
        ? roomOrObstacles.layoutRevision
        : null;

      if (revision !== null) {
        if (cachedRevision === revision && cachedRoomId === roomId) {
          return cachedPrepared;
        }
      } else if (cachedRevision === null && cachedRoomId === roomId && cachedObstaclesRef === roomOrObstacles.obstacles) {
        return cachedPrepared;
      }

      cachedRoomId = roomId;
      cachedRevision = revision;
      cachedObstaclesRef = roomOrObstacles.obstacles ?? null;
      cachedPrepared = prepareObstacles(roomOrObstacles.obstacles);
      prepareCount += 1;
      return cachedPrepared;
    },
    clear() {
      cachedRoomId = null;
      cachedRevision = null;
      cachedObstaclesRef = null;
      cachedPrepared = EMPTY_PREPARED;
    },
    stats() {
      return { prepareCount, revision: cachedRevision, roomId: cachedRoomId };
    },
  };
}

/**
 * Compute total acoustic transmission T in [0, 1] along the closed line-of-sight
 * segment between `listener` and `speaker` across `prepared` obstacles.
 *
 * Uses a fast bounding-box pre-check per obstacle before the exact Liang-Barsky
 * clipping test. Multiplies `attenuation` across all intersected blocking
 * obstacles (each counted once) and clamps to [0, 1]. Canonicalizes endpoint
 * order so swapping `listener` and `speaker` produces identical results.
 *
 * Zero heap allocations when `prepared` was produced by `prepareObstacles`.
 *
 * @param {{x: number, y: number}} listener
 * @param {{x: number, y: number}} speaker
 * @param {ReadonlyArray<object>|Array<object>|null|undefined} prepared
 * @returns {number} transmission factor in [0, 1]
 */
export function transmissionBetween(listener, speaker, prepared) {
  if (
    !listener || !speaker ||
    typeof listener.x !== 'number' || !Number.isFinite(listener.x) ||
    typeof listener.y !== 'number' || !Number.isFinite(listener.y) ||
    typeof speaker.x !== 'number' || !Number.isFinite(speaker.x) ||
    typeof speaker.y !== 'number' || !Number.isFinite(speaker.y)
  ) {
    return 1;
  }

  if (!prepared) return 1;
  const list = PREPARED_SET.has(prepared) ? prepared : prepareObstacles(prepared);
  const len = list.length;
  if (len === 0) return 1;

  let ax = listener.x;
  let ay = listener.y;
  let bx = speaker.x;
  let by = speaker.y;

  // Canonicalize endpoints once so listener <-> speaker is bit-for-bit symmetric.
  if (ax > bx || (ax === bx && ay > by)) {
    const tmpX = ax;
    ax = bx;
    bx = tmpX;
    const tmpY = ay;
    ay = by;
    by = tmpY;
  }

  const segMinX = ax;
  const segMaxX = bx;
  const segMinY = ay <= by ? ay : by;
  const segMaxY = ay <= by ? by : ay;

  let transmission = 1;
  for (let i = 0; i < len; i += 1) {
    const obs = list[i];
    // Fast bounding-box rejection before exact clipping.
    if (segMaxX < obs.x || segMinX > obs.maxX || segMaxY < obs.y || segMinY > obs.maxY) {
      continue;
    }
    if (clipCanonicalSegmentToBounds(ax, ay, bx, by, obs.x, obs.y, obs.maxX, obs.maxY)) {
      transmission *= obs.attenuation;
      if (transmission <= 0) return 0;
    }
  }

  if (transmission < 0) return 0;
  if (transmission > 1) return 1;
  return transmission;
}

/**
 * Format a peer's output volume and line-of-sight transmission percentage for
 * the read-only audio status overlay (e.g. `volume 4% (blocked 12%)` when
 * occluded, or `volume 39% (100%)` when unobstructed).
 *
 * @param {number|null|undefined} volumePercent
 * @param {number|null|undefined} [transmission=1]
 * @returns {string}
 */
export function formatPeerVolume(volumePercent, transmission = 1) {
  const vol = typeof volumePercent === 'number' && Number.isFinite(volumePercent)
    ? Math.max(0, Math.min(100, Math.round(volumePercent)))
    : 0;
  const clampedT = typeof transmission === 'number' && Number.isFinite(transmission)
    ? Math.max(0, Math.min(1, transmission))
    : 1;
  const transmissionPercent = Math.round(clampedT * 100);
  if (clampedT < 1) {
    return `volume ${vol}% (blocked ${transmissionPercent}%)`;
  }
  return `volume ${vol}% (${transmissionPercent}%)`;
}

/**
 * Pure derivation of distance, transmission, combined target gain, and formatted
 * overlay volume text from known listener/speaker positions and room obstacles.
 *
 * @param {{x: number, y: number}|null|undefined} localPos
 * @param {{x: number, y: number}|null|undefined} remotePos
 * @param {ReadonlyArray<object>|Array<object>|null|undefined} obstacles
 * @param {{innerPx?: number, outerPx?: number}} [options]
 */
export function derivePeerVolume(localPos, remotePos, obstacles, options = {}) {
  const distancePx = distanceBetween(localPos, remotePos);
  if (!Number.isFinite(distancePx)) {
    return {
      distancePx: null,
      distanceGain: 0,
      transmission: 1,
      gain: 0,
      volumePercent: 0,
      transmissionPercent: 100,
      blocked: false,
      text: formatPeerVolume(0, 1),
    };
  }
  const distanceGain = gainForDistance(distancePx, options);
  const transmission = transmissionBetween(localPos, remotePos, obstacles);
  const rawGain = distanceGain * transmission;
  const gain = rawGain <= 0 ? 0 : rawGain >= 1 ? 1 : rawGain;
  const volumePercent = Math.round(gain * 100);
  const transmissionPercent = Math.round(transmission * 100);
  const blocked = transmission < 1;
  return {
    distancePx,
    distanceGain,
    transmission,
    gain,
    volumePercent,
    transmissionPercent,
    blocked,
    text: formatPeerVolume(volumePercent, transmission),
  };
}
