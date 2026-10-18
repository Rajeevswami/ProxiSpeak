/**
 * Connection stats (Week 2, Day 9).
 *
 * Polls `pc.getStats()` about once per second per peer and keeps the two
 * numbers that prove audio is really flowing:
 *
 *   connectionState — from the RTCPeerConnection itself
 *   bytesReceived   — summed over the inbound audio RTP streams
 *
 * The Mid-Project Review "Audio Check" is exactly this: two browsers
 * connected, `bytesReceived` climbing. Plain JS, no DOM: timers and the stats
 * reader are injectable so unit tests run in Node with fakes.
 */

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs] poll interval, default ~1 s per peer
 * @param {Function} [options.setIntervalFn] injectable timer (tests)
 * @param {Function} [options.clearIntervalFn] injectable timer (tests)
 * @param {object} [options.logger] { debug, error }
 */
export function createRtcStats({
  intervalMs = 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = null,
} = {}) {
  /** peerId -> interval handle. One timer per watched peer. */
  const timers = new Map();
  /** peerId -> { connectionState, bytesReceived, updatedAt }. */
  const latest = new Map();

  const readReport = (report) => {
    let bytesReceived = 0;
    if (!report) return bytesReceived;
    // getStats() returns a Map-like report in browsers; forEach covers both
    // Map and the array shape fakes may use.
    const visit = (entry) => {
      if (!entry || typeof entry !== 'object') return;
      const audio =
        entry.kind === 'audio' || entry.mediaType === 'audio' || (!entry.kind && !entry.mediaType);
      if (entry.type === 'inbound-rtp' && audio) {
        bytesReceived += entry.bytesReceived ?? 0;
      }
    };
    if (typeof report.forEach === 'function') report.forEach(visit);
    else if (typeof report.values === 'function') for (const entry of report.values()) visit(entry);
    return bytesReceived;
  };

  const poll = async (peerId, pc) => {
    try {
      const report = await pc.getStats();
      latest.set(peerId, {
        connectionState: pc.connectionState ?? 'new',
        bytesReceived: readReport(report),
        updatedAt: Date.now(),
      });
    } catch (err) {
      // Stats are proof-of-life only: a failing read must never break audio.
      logger?.debug?.(`getStats for ${peerId} failed:`, err?.message ?? err);
    }
  };

  return {
    /** Start the ~1 s poll for one peer (replacing any previous one). */
    watch(peerId, pc) {
      this.unwatch(peerId);
      poll(peerId, pc); // first read immediately so the overlay is not empty
      const handle = setIntervalFn(() => poll(peerId, pc), intervalMs);
      timers.set(peerId, handle);
    },

    /** Stop one peer's timer and drop its stats. */
    unwatch(peerId) {
      const handle = timers.get(peerId);
      if (handle !== undefined) {
        clearIntervalFn(handle);
        timers.delete(peerId);
      }
      latest.delete(peerId);
    },

    /** Stop every timer and clear every row (closeAll). */
    stopAll() {
      for (const handle of timers.values()) clearIntervalFn(handle);
      timers.clear();
      latest.clear();
    },

    /** Latest stats row for one peer: { connectionState, bytesReceived }. */
    get(peerId) {
      return latest.get(peerId) ?? null;
    },

    /** Every row, for the status overlay. */
    snapshot() {
      return [...latest.entries()].map(([peerId, row]) => ({ peerId, ...row }));
    },

    /** How many poll timers are live — must be 0 after cleanup. */
    activeTimers() {
      return timers.size;
    },
  };
}

export default createRtcStats;
