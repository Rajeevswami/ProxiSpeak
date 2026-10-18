/**
 * Signal rate-limit headroom (Day 9, verification only — no server change).
 *
 * The Day 9 client opens every earshot edge at once when a user steps into a
 * cluster: up to ~10 simultaneous peer connections, each exchanging one SDP
 * message plus trickled ICE candidates. This test replays that burst against
 * the *shipped defaults* of the per-socket `signal` token bucket
 * (`SOCKET_SIGNAL_BURST` / `SOCKET_SIGNAL_EPS`) and proves they already cover
 * it — so the server code stays exactly as Day 8 left it. The flood guard is
 * re-proven as well, so a passing result cannot mean the bucket is not paying
 * attention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenBucket } from '../src/utils/rateLimiter.js';
import config from '../src/config/index.js';

const t0 = 1_000_000; // arbitrary base timestamp for the injectable clock

test('10 simultaneous peers exchange ICE without tripping the signal bucket', () => {
  const { signalBurst, signalEventsPerSec } = config.socket;

  // Per edge per side on connect: 1 SDP message (offer or answer) plus the
  // trickled candidates. Observed browsers send 2-4 candidates with one STUN
  // server (1-2 host, 0-1 srflx, 0-1 TCP); 7 is a deliberately pessimistic
  // double-count (multiple interfaces, both TCP and UDP, a spare).
  const peers = 10;
  const signalsPerEdge = 1 + 7;
  const total = peers * signalsPerEdge;
  // The whole burst lands inside half a second — the pessimistic case for a
  // token bucket, since refill only adds tokens afterwards.
  const burstWindowMs = 500;

  const bucket = new TokenBucket({ capacity: signalBurst, refillPerSec: signalEventsPerSec });
  let dropped = 0;
  for (let index = 0; index < total; index += 1) {
    const now = t0 + (index * burstWindowMs) / total;
    if (!bucket.take(now)) dropped += 1;
  }

  const budget = signalBurst + signalEventsPerSec * (burstWindowMs / 1000);
  console.log(
    `  signal bucket: capacity ${signalBurst}, refill ${signalEventsPerSec}/s -> ` +
      `${budget} signals fit in ${burstWindowMs} ms; a 10-peer connect sends ${total} ` +
      `(${signalsPerEdge} per edge), dropped: ${dropped}`,
  );

  assert.equal(
    dropped,
    0,
    `${total} signals in ${burstWindowMs} ms must fit the default bucket ` +
      `(burst ${signalBurst} + ${signalEventsPerSec}/s refill = ${budget}) — ` +
      'if this fails, raise SOCKET_SIGNAL_BURST and update the numbers here',
  );
  assert.ok(
    total <= signalBurst,
    'the whole burst even fits inside the burst capacity alone, before any refill',
  );
});

test('the same bucket still stops a flood (this proof is not vacuous)', () => {
  const { signalBurst, signalEventsPerSec } = config.socket;
  const bucket = new TokenBucket({ capacity: signalBurst, refillPerSec: signalEventsPerSec });

  let dropped = 0;
  const flood = signalBurst * 3;
  for (let index = 0; index < flood; index += 1) {
    if (!bucket.take(t0)) dropped += 1; // all at the same instant: no refill
  }
  assert.equal(dropped, flood - signalBurst, 'anything beyond the burst is dropped');
});
