/**
 * Per-frame movement controller (Day 5). Owns everything that changes
 * between two rendered frames: the held keys, the click-to-walk target,
 * the 10 Hz `move` broadcast and the remote avatars' glide toward their
 * last reported positions.
 *
 * The controller is deliberately framework-free: it is handed the
 * socket hook's world state object (a plain mutable structure that is
 * created once and never replaced) and its `update(deltaSeconds)` is
 * called once per animation frame by the canvas component, before
 * rendering, inside the one and only rAF loop. It never calls a React
 * state setter, so movement causes zero React renders: the position
 * lives in the world state and nowhere else.
 */
import {
  MOVEMENT_SPEED_PX_PER_SEC,
  REMOTE_INTERPOLATION_RATE_PER_SEC,
  clampFrameDelta,
  clampToBounds,
  directionFromKeys,
  interpolateToward,
  isMovementKey,
  moveTowardTarget,
  needsSnap,
  stepByDeltaTime,
} from './movement.js';
import { createMoveThrottle } from './throttle.js';

/**
 * @param {object} options
 * @param {object} options.world the socket hook's world state (stable, mutated in place)
 * @param {(x: number, y: number) => void} options.emitMove sends a `move` to the server
 * @param {() => number} [options.now] injectable clock in milliseconds (tests)
 */
export function createMovementController({ world, emitMove, now = Date.now } = {}) {
  if (!world || typeof world !== 'object') {
    throw new TypeError('createMovementController requires the world state object');
  }
  if (typeof emitMove !== 'function') {
    throw new TypeError('createMovementController requires an emitMove function');
  }

  /** Held movement-key codes; anything else is ignored at the door. */
  const heldKeys = new Set();
  /** Click-to-walk target in world coordinates, or null. */
  let clickTarget = null;
  /** The world epoch we last synced against (a fresh `joined` bumps it). */
  let epoch = world.epoch ?? 0;
  /** Reused every frame so the loop allocates nothing per frame. */
  const direction = { x: 0, y: 0 };
  /** 10 Hz `move` broadcast: emits only when the position changed. */
  const throttle = createMoveThrottle({ emit: emitMove, now });

  /**
   * Advance the world by one frame. Called by the render loop with the
   * frame's delta time in seconds (it is clamped here, so a resumed
   * hidden tab cannot teleport the avatar).
   */
  const update = (deltaSeconds) => {
    const state = world;
    if (!state || !state.room || !state.selfId) return;

    const self = state.users.get(state.selfId);
    if (!self || !Number.isFinite(self.x) || !Number.isFinite(self.y)) return;

    // A fresh `joined` (first join or a re-served snapshot) restarts the
    // world from server-provided positions: drop stale input and rebase
    // the broadcast on the server's position instead of fighting it.
    if (epoch !== state.epoch) {
      epoch = state.epoch;
      heldKeys.clear();
      clickTarget = null;
      throttle.reset(self.x, self.y);
    }

    const dt = clampFrameDelta(deltaSeconds);
    const bounds = state.room;

    // --- local avatar (client-side prediction) ---------------------------
    // The avatar moves the moment a key goes down; the position lives in
    // the world state, so the next rendered frame already shows it.
    directionFromKeys(heldKeys, direction);
    if (direction.x !== 0 || direction.y !== 0) {
      clickTarget = null; // any keyboard input cancels a click target
      stepByDeltaTime(self, direction, dt, MOVEMENT_SPEED_PX_PER_SEC, bounds);
    } else if (clickTarget) {
      const walking = moveTowardTarget(self, clickTarget, dt, MOVEMENT_SPEED_PX_PER_SEC, bounds);
      if (!walking) clickTarget = null; // arrived (or walled in): stop
    }

    // --- remote avatars ----------------------------------------------------
    // Peers report their position at most 10 times a second; between two
    // reports every avatar glides the frame-rate-independent fraction of
    // the remaining way (no snapping, no teleporting). A remote that is
    // far from its target — a reconnect, a re-served snapshot — snaps.
    for (const user of state.users.values()) {
      if (user.id === state.selfId) continue;
      if (!Number.isFinite(user.tx) || !Number.isFinite(user.ty)) continue;
      if (needsSnap(user, user.tx, user.ty)) {
        user.x = user.tx;
        user.y = user.ty;
      } else {
        interpolateToward(user, user.tx, user.ty, dt, REMOTE_INTERPOLATION_RATE_PER_SEC);
      }
    }

    // --- broadcast ---------------------------------------------------------
    // At most 10 emits per second, only while the position actually
    // differs from the last one sent; after a stop, the next tick
    // carries the exact resting position. A 300 px/s avatar moves 30 px
    // between two ticks — comfortably under the server's 120 px step
    // cap, so a legitimate client is never corrected.
    throttle.update(self.x, self.y);
  };

  return {
    update,

    /** A key went down. Non-movement keys never make it in here. */
    pressKey: (code) => {
      if (isMovementKey(code)) heldKeys.add(code);
    },

    /** A key went up (releasing a key that is not held is a no-op). */
    releaseKey: (code) => {
      heldKeys.delete(code);
    },

    /** Forget every held key (window blur, unmount). */
    clearKeys: () => {
      heldKeys.clear();
    },

    /**
     * Click-to-walk: walk to a world-space point. The target is clamped
     * into the room, so a click on the letterbox band walks to the
     * nearest in-room point instead of trying to leave the floor plan.
     */
    handleWorldClick: (point) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (!world || !world.room) return;
      clickTarget = clampToBounds({ x: point.x, y: point.y }, world.room);
    },
  };
}

export default createMovementController;
