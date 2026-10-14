/**
 * Per-frame movement controller (Day 5). Owns everything that changes
 * between two rendered frames: the held keys, the click-to-walk target
 * and — added with the broadcasting and interpolation commits — the
 * 10 Hz `move` throttle and the remote avatars' glide.
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
  clampFrameDelta,
  clampToBounds,
  directionFromKeys,
  isMovementKey,
  moveTowardTarget,
  stepByDeltaTime,
} from './movement.js';

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

  const syncWithWorld = () => {
    heldKeys.clear();
    clickTarget = null;
  };

  /**
   * Advance the world by one frame. Called by the render loop with the
   * frame's delta time in seconds (it is clamped here, so a resumed
   * hidden tab cannot teleport the avatar).
   */
  const update = (deltaSeconds) => {
    const state = world;
    if (!state || !state.room || !state.selfId) return;

    // A fresh `joined` (first join or a re-served snapshot) restarts the
    // world from server-provided positions: drop stale input instead of
    // fighting the server's authority.
    if (epoch !== state.epoch) {
      epoch = state.epoch;
      syncWithWorld();
    }

    const self = state.users.get(state.selfId);
    if (!self || !Number.isFinite(self.x) || !Number.isFinite(self.y)) return;

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
