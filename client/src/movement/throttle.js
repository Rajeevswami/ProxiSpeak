/**
 * Position broadcast throttle (Day 5). The local avatar moves every
 * frame, but the server only needs to hear about it at most
 * MOVE_BROADCAST_HZ times a second, and only when the position
 * actually changed.
 *
 * Pure: the clock is injectable and nothing here touches the socket,
 * React or the DOM. The caller reports the current position once per
 * frame; the throttle decides whether that frame emits a `move`.
 */
import { MOVE_SEND_INTERVAL_MS, POSITION_CHANGED_EPSILON_PX } from './movement.js';

/**
 * @param {object} options
 * @param {(x: number, y: number) => void} options.emit called with the position to send
 * @param {number} [options.intervalMs] minimum gap between two emits (default 100 = 10 Hz)
 * @param {number} [options.epsilonPx] positions closer than this to the last sent one are "unchanged"
 * @param {() => number} [options.now] injectable clock, in milliseconds
 */
export function createMoveThrottle({
  emit,
  intervalMs = MOVE_SEND_INTERVAL_MS,
  epsilonPx = POSITION_CHANGED_EPSILON_PX,
  now = Date.now,
} = {}) {
  if (typeof emit !== 'function') {
    throw new TypeError('createMoveThrottle requires an emit function');
  }
  if (!(intervalMs > 0)) {
    throw new TypeError('createMoveThrottle requires a positive intervalMs');
  }

  let sentX = null;
  let sentY = null;
  let sentAt = now();

  const changed = (x, y) =>
    sentX === null || Math.abs(x - sentX) > epsilonPx || Math.abs(y - sentY) > epsilonPx;

  return {
    /**
     * Report the current position (call once per animation frame).
     * Emits at most once per interval, and only when the position moved
     * since the last emit — so a resting avatar sends nothing, and the
     * first tick after movement stops carries the exact resting
     * position (at most one interval later) so peers see precisely
     * where the avatar came to rest.
     *
     * @returns {boolean} whether this frame emitted a `move`
     */
    update(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const at = now();
      if (at - sentAt < intervalMs) return false;
      if (!changed(x, y)) return false;
      emit(x, y);
      sentX = x;
      sentY = y;
      sentAt = at;
      return true;
    },

    /**
     * Forget the last sent position. A fresh `joined` snapshot passes
     * the server-provided position, which becomes the baseline — so an
     * avatar that never moves emits nothing (the server already knows
     * where it put us). Without arguments the baseline is unknown and
     * the next changed position re-establishes it.
     */
    reset(x = null, y = null) {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        sentX = x;
        sentY = y;
      } else {
        sentX = null;
        sentY = null;
      }
      sentAt = now();
    },
  };
}

export default createMoveThrottle;
