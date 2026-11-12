/**
 * Pure movement maths for the local avatar and remote interpolation
 * (Day 5). No React, no DOM, no socket: everything here is a plain
 * function over plain objects, unit-tested with `node --test`.
 *
 * Units: the room is a fixed pixel plane (1920x1080 by default), so
 * speeds are world pixels per second and every step is scaled by the
 * frame's delta time — the movement is identical on a 60 Hz and on a
 * 144 Hz display, because only the elapsed time decides the distance.
 */

/** Walking speed of an avatar, in world pixels per second. */
export const MOVEMENT_SPEED_PX_PER_SEC = 300;

/** How often a moving avatar reports its position: `move` events per second. */
export const MOVE_BROADCAST_HZ = 10;

/** Minimum gap between two `move` emits, in milliseconds (1 / MOVE_BROADCAST_HZ). */
export const MOVE_SEND_INTERVAL_MS = 1000 / MOVE_BROADCAST_HZ;

/**
 * Cap on one frame's delta time. A hidden tab pauses its animation
 * frames, so the first delta after it comes back is huge; applying it
 * wholesale would teleport the avatar (and could outrun the server's
 * per-event step cap). One clamped frame advances an avatar at most
 * MOVEMENT_SPEED_PX_PER_SEC * MAX_FRAME_DELTA_SECONDS = 30 px.
 */
export const MAX_FRAME_DELTA_SECONDS = 0.1;

/** Positions closer than this to the last sent one count as "unchanged". */
export const POSITION_CHANGED_EPSILON_PX = 0.01;

/**
 * Exponential smoothing rate for remote avatars, per second. The
 * smoothing factor is 1 - exp(-rate * dt), which is frame-rate
 * independent: any slicing of the same total time converges to the
 * same position.
 */
export const REMOTE_INTERPOLATION_RATE_PER_SEC = 12;

/** A remote avatar further than this from its target snaps instead of gliding. */
export const REMOTE_SNAP_PX = 200;

/** Once interpolation is within this of the target it lands exactly on it. */
export const INTERPOLATION_SNAP_PX = 0.01;

/** Movement keys: WASD and the arrow keys. y grows downward on screen. */
const KEY_DIRECTIONS = {
  KeyW: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: -1 },
  KeyS: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: 1 },
  KeyA: { x: -1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** True for the eight keys that walk the avatar. */
export function isMovementKey(code) {
  return Object.prototype.hasOwnProperty.call(KEY_DIRECTIONS, code);
}

/** The unit direction a single movement key contributes, or null. */
export function keyDirection(code) {
  return isMovementKey(code) ? KEY_DIRECTIONS[code] : null;
}

/**
 * Direction from the currently held keys, normalised so a diagonal is
 * not faster than a straight line (W+D is (0.707, -0.707), not (1, -1)).
 * Opposite keys on one axis cancel out (A+D is a standstill). Writes
 * into `out` when given, so the render loop can call this every frame
 * without allocating.
 *
 * @param {Iterable<string>} keys held key codes (a Set or an array)
 * @param {{x:number,y:number}} [out] reused result object
 * @returns {{x:number,y:number}} a unit vector, or (0, 0) when idle
 */
export function directionFromKeys(keys, out = { x: 0, y: 0 }) {
  let dx = 0;
  let dy = 0;
  if (keys && typeof keys[Symbol.iterator] === 'function') {
    for (const code of keys) {
      const direction = keyDirection(code);
      if (direction) {
        dx += direction.x;
        dy += direction.y;
      }
    }
  }
  const length = Math.hypot(dx, dy);
  out.x = length > 0 ? dx / length : 0;
  out.y = length > 0 ? dy / length : 0;
  return out;
}

/**
 * Clamp a position into the room. The server applies the same rule to
 * every `move` (x into [0, width], y into [0, height]), so predicting
 * it locally keeps the client and the server in agreement.
 */
export function clampToBounds(position, bounds) {
  position.x = Math.min(Math.max(position.x, 0), bounds.width);
  position.y = Math.min(Math.max(position.y, 0), bounds.height);
  return position;
}

/** Make one frame's delta time safe: finite, non-negative, capped. */
export function clampFrameDelta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, MAX_FRAME_DELTA_SECONDS);
}

/**
 * Advance `position` one frame in `direction` (a unit vector): distance
 * = speed * delta time, then clamped into the room. Mutates and
 * returns `position`.
 */
export function stepByDeltaTime(position, direction, deltaSeconds, speedPxPerSec, bounds) {
  if (direction) {
    position.x += direction.x * speedPxPerSec * deltaSeconds;
    position.y += direction.y * speedPxPerSec * deltaSeconds;
  }
  return clampToBounds(position, bounds);
}

/**
 * Walk `position` toward `target` at a constant speed — the click-to-move
 * step. Never overshoots: the arrival step lands exactly on the target,
 * and a target that cannot be reached (a wall in the way — bounds are
 * applied every step) reports arrival as soon as the position stops
 * changing.
 *
 * @returns {boolean} true while the target is still pending, false once
 *   the position has arrived (the caller drops the target)
 */
export function moveTowardTarget(position, target, deltaSeconds, speedPxPerSec, bounds) {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.hypot(dx, dy);
  const step = speedPxPerSec * deltaSeconds;

  if (distance <= step || distance === 0) {
    position.x = target.x;
    position.y = target.y;
    return false;
  }

  // A frame with no elapsed time moves nothing: the target stays
  // pending. (Without this, a 0 ms frame — two rAF callbacks sharing a
  // timestamp — would look like "no progress" and cancel the walk.)
  if (step <= 0) return true;

  const beforeX = position.x;
  const beforeY = position.y;
  position.x += (dx / distance) * step;
  position.y += (dy / distance) * step;
  clampToBounds(position, bounds);
  if (position.x === beforeX && position.y === beforeY) {
    // Fully clamped: the target is unreachable and this frame went
    // nowhere — treat as arrival so the avatar does not grind on a wall.
    return false;
  }
  return true;
}

/** Distance between a position and a point. */
function distanceTo(position, x, y) {
  return Math.hypot(x - position.x, y - position.y);
}

/**
 * Move `position` a frame-rate-independent fraction of the way toward
 * (targetX, targetY): the smoothing factor 1 - exp(-rate * dt) makes
 * the position after a fixed elapsed time identical no matter how that
 * time was sliced into frames. Lands exactly on the target once close
 * enough. Mutates and returns `position`.
 */
export function interpolateToward(
  position,
  targetX,
  targetY,
  deltaSeconds,
  ratePerSec = REMOTE_INTERPOLATION_RATE_PER_SEC,
) {
  const dx = targetX - position.x;
  const dy = targetY - position.y;
  const distance = Math.hypot(dx, dy);

  if (distance <= INTERPOLATION_SNAP_PX) {
    position.x = targetX;
    position.y = targetY;
    return position;
  }

  const alpha = 1 - Math.exp(-ratePerSec * deltaSeconds);
  position.x += dx * alpha;
  position.y += dy * alpha;
  return position;
}

/**
 * True when a remote avatar is too far from its last reported position
 * to glide — after a reconnect the avatar jumps (snaps) instead of
 * sweeping across the floor.
 */
export function needsSnap(position, targetX, targetY, thresholdPx = REMOTE_SNAP_PX) {
  return distanceTo(position, targetX, targetY) > thresholdPx;
}
