/**
 * Dependency-free token bucket, one per socket and per event family.
 *
 * A bucket starts full (`capacity` events may burst) and refills continuously
 * at `refillPerSec`, which is the standard shape for realtime input: a client
 * that briefly outruns the network is not punished, a client that floods is.
 */
export class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new Error('TokenBucket requires a positive capacity and refill rate');
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = Date.now();
  }

  /**
   * Consume one token.
   * @param {number} [now] monotonic-ish timestamp (injectable for tests)
   * @returns {boolean} true when the event is allowed to proceed
   */
  take(now = Date.now()) {
    const elapsedSeconds = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export default TokenBucket;
