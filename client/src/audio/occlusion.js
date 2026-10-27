/**
 * Pure 2D line-of-sight geometry for sound-blocking obstacles — Week 3 (Day 16).
 * No browser, DOM, React or Web Audio dependencies; zero allocations in the hot path.
 */

/**
 * Relative parametric tolerance (4 ULPs in t-space, ~8.88e-16) for Liang-Barsky
 * division comparisons so segments grazing a corner in IEEE-754 float64 are not
 * rejected by 1-2 ULP rounding.
 */
export const PARAM_EPSILON = 4 * Number.EPSILON;

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
