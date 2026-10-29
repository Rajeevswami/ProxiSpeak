/**
 * Pure, DOM-free rolling frame statistics ring buffer — Week 3 (Day 18).
 *
 * Preallocates fixed-capacity Float64Array buffers so `record(intervalMs, workMs)`
 * performs zero heap allocations on the animation hot path. `snapshot()` is
 * designed to be polled at most once per second for the `?perf=1` readout.
 */

/** Default rolling window: 240 frames (~4 seconds at 60 Hz). */
export const DEFAULT_RING_CAPACITY = 240;

/**
 * Dropped-frame threshold in milliseconds.
 * At 60 Hz one display refresh is 16.67 ms (1000 / 60). An interval strictly
 * above 25 ms (~1.5x a 60 Hz frame) means at least one full refresh was missed
 * rather than ordinary 1–2 ms vsync scheduling jitter.
 */
export const DROPPED_FRAME_MS = 25;

/**
 * Sentinel passed when a frame has no valid preceding visible frame timestamp:
 * the very first callback after mount and the first callback after returning
 * from a hidden tab (`document.hidden`). Any interval <= 0 is excluded.
 */
export const EXCLUDED_INTERVAL_MS = -1;

/**
 * Upper bound (ms) for a valid in-session frame interval. Intervals above
 * 1,000 ms come from background-tab timer throttling or OS sleep before a
 * visibility event arrives and are excluded from rolling FPS/percentile stats.
 */
export const MAX_VALID_INTERVAL_MS = 1000;

/**
 * Nearest-rank percentile (`ceil(q * n)`-th smallest, 1-indexed), matching
 * `server/src/services/spatialAudit.js`. Expects a non-empty ascending array
 * or TypedArray.
 *
 * @param {ArrayLike<number>} sortedAscending
 * @param {number} quantile in (0, 1]
 * @returns {number}
 */
export function nearestRank(sortedAscending, quantile) {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const index = Math.max(0, Math.min(n - 1, Math.ceil(quantile * n) - 1));
  return sortedAscending[index];
}

/**
 * Create a fixed-capacity ring buffer for frame intervals and callback work times.
 *
 * @param {object} [options]
 * @param {number} [options.capacity] ring capacity (positive integer, default 240)
 */
export function createFrameStats({ capacity = DEFAULT_RING_CAPACITY } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }

  const intervals = new Float64Array(capacity);
  const works = new Float64Array(capacity);
  const scratchIntervals = new Float64Array(capacity);
  const scratchWorks = new Float64Array(capacity);

  let head = 0;
  let count = 0;
  let excludeNext = false;

  return {
    /** Capacity of the underlying Float64Array ring buffer. */
    capacity,

    /**
     * Record one frame's interval (time since previous callback) and work
     * duration (time spent inside the callback), in milliseconds.
     *
     * Allocates nothing. Ignores non-finite inputs, negative work times,
     * first-frame / explicit sentinel intervals (`<= 0`, e.g. EXCLUDED_INTERVAL_MS),
     * intervals immediately following `markHidden()`, and hidden-tab gaps
     * (`> MAX_VALID_INTERVAL_MS`).
     *
     * @param {number} intervalMs
     * @param {number} workMs
     * @returns {boolean} true when the sample was stored
     */
    record(intervalMs, workMs) {
      if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) return false;
      if (typeof workMs !== 'number' || !Number.isFinite(workMs) || workMs < 0) return false;
      if (excludeNext) {
        excludeNext = false;
        return false;
      }
      if (intervalMs <= 0 || intervalMs > MAX_VALID_INTERVAL_MS) return false;

      intervals[head] = intervalMs;
      works[head] = workMs;
      head = (head + 1) % capacity;
      if (count < capacity) count += 1;
      return true;
    },

    /**
     * Mark that the tab became hidden so the next finite interval after
     * returning is excluded from statistics regardless of its duration.
     */
    markHidden() {
      excludeNext = true;
    },

    /** Clear all recorded samples. */
    reset() {
      head = 0;
      count = 0;
      excludeNext = false;
    },

    /**
     * Compute rolling summary statistics across the current buffer contents.
     * Safe on an empty buffer (returns zeros). Intended to run <= 1 Hz.
     */
    snapshot() {
      if (count === 0) {
        return {
          samples: 0,
          fps: 0,
          dropped: 0,
          interval: { p50: 0, p95: 0, max: 0 },
          work: { p50: 0, p95: 0, max: 0 },
        };
      }

      let intervalSum = 0;
      let dropped = 0;
      for (let i = 0; i < count; i += 1) {
        const iv = intervals[i];
        scratchIntervals[i] = iv;
        scratchWorks[i] = works[i];
        intervalSum += iv;
        if (iv > DROPPED_FRAME_MS) dropped += 1;
      }

      const sortedIntervals = scratchIntervals.subarray(0, count);
      const sortedWorks = scratchWorks.subarray(0, count);
      sortedIntervals.sort();
      sortedWorks.sort();

      return {
        samples: count,
        fps: intervalSum > 0 ? (1000 * count) / intervalSum : 0,
        dropped,
        interval: {
          p50: nearestRank(sortedIntervals, 0.5),
          p95: nearestRank(sortedIntervals, 0.95),
          max: sortedIntervals[count - 1],
        },
        work: {
          p50: nearestRank(sortedWorks, 0.5),
          p95: nearestRank(sortedWorks, 0.95),
          max: sortedWorks[count - 1],
        },
      };
    },
  };
}

export default createFrameStats;
