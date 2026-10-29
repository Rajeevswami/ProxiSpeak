import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_RING_CAPACITY,
  DROPPED_FRAME_MS,
  EXCLUDED_INTERVAL_MS,
  MAX_VALID_INTERVAL_MS,
  createFrameStats,
  nearestRank,
} from '../src/perf/frameStats.js';

test('empty snapshot returns zeroed metrics without dividing by zero', () => {
  const stats = createFrameStats();
  assert.equal(stats.capacity, DEFAULT_RING_CAPACITY);
  assert.deepEqual(stats.snapshot(), {
    samples: 0,
    fps: 0,
    dropped: 0,
    interval: { p50: 0, p95: 0, max: 0 },
    work: { p50: 0, p95: 0, max: 0 },
  });
});

test('nearestRank matches ceil(q * n) - 1 on known sorted inputs', () => {
  const oneToHundred = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(nearestRank(oneToHundred, 0.5), 50);
  assert.equal(nearestRank(oneToHundred, 0.95), 95);
  assert.equal(nearestRank(oneToHundred, 1), 100);
  assert.equal(nearestRank(Float64Array.of(42), 0.5), 42);
  assert.equal(nearestRank(Float64Array.of(42), 0.95), 42);
  assert.equal(nearestRank(new Float64Array(0), 0.95), 0);

  const stats = createFrameStats({ capacity: 240 });
  // Push 1..100 in reverse order to verify snapshot sorts into its scratch buffer.
  for (let i = 100; i >= 1; i -= 1) {
    assert.equal(stats.record(i, i * 0.1), true);
  }
  const snap = stats.snapshot();
  assert.equal(snap.samples, 100);
  assert.equal(snap.interval.p50, 50);
  assert.equal(snap.interval.p95, 95);
  assert.equal(snap.interval.max, 100);
  assert.ok(Math.abs(snap.work.p50 - 5.0) < 1e-9);
  assert.ok(Math.abs(snap.work.p95 - 9.5) < 1e-9);
  assert.ok(Math.abs(snap.work.max - 10.0) < 1e-9);
  // Mean interval across 1..100 is 50.5 ms -> fps = 1000 / 50.5
  assert.ok(Math.abs(snap.fps - 1000 / 50.5) < 1e-9);
});

test('ring buffer wraps cleanly at capacity and evicts overwritten samples', () => {
  const stats = createFrameStats({ capacity: 10 });
  // First 10 frames are slow (40 ms, dropped), next 10 frames are steady 16 ms (not dropped).
  for (let i = 0; i < 10; i += 1) {
    stats.record(40, 5);
  }
  assert.equal(stats.snapshot().dropped, 10);

  for (let i = 0; i < 10; i += 1) {
    stats.record(16, 0.5);
  }
  const snap = stats.snapshot();
  assert.equal(snap.samples, 10);
  assert.equal(snap.dropped, 0);
  assert.equal(snap.interval.p50, 16);
  assert.equal(snap.interval.p95, 16);
  assert.equal(snap.interval.max, 16);
  assert.equal(snap.work.max, 0.5);
  assert.ok(Math.abs(snap.fps - 62.5) < 1e-9);

  // Also verify default 240-sample ring over 600 frames.
  const fullRing = createFrameStats();
  for (let i = 0; i < 600; i += 1) {
    fullRing.record(16.6, 0.3);
  }
  assert.equal(fullRing.snapshot().samples, 240);
});

test('dropped-frame boundary at DROPPED_FRAME_MS = 25 ms is strictly greater-than', () => {
  assert.equal(DROPPED_FRAME_MS, 25);

  const exact25 = createFrameStats({ capacity: 16 });
  exact25.record(25.0, 0.4);
  assert.equal(exact25.snapshot().dropped, 0, '25.0 ms must not count as dropped');

  const justOver25 = createFrameStats({ capacity: 16 });
  justOver25.record(25.0, 0.4);
  justOver25.record(25.1, 0.4);
  const snap = justOver25.snapshot();
  assert.equal(snap.dropped, 1, '25.1 ms must count as dropped');
});

test('excludes first-frame sentinel, markHidden() post-hidden intervals, and >1s stalls', () => {
  const stats = createFrameStats({ capacity: 32 });

  // First rendered frame has no prior frame timestamp: excluded cleanly.
  assert.equal(stats.record(EXCLUDED_INTERVAL_MS, 0.8), false);
  assert.equal(stats.snapshot().samples, 0);

  // Normal steady 60 Hz frames.
  assert.equal(stats.record(16.5, 0.4), true);
  assert.equal(stats.record(16.7, 0.5), true);

  // Simulate returning from a hidden tab via markHidden(): next interval is ignored even if <= 1000 ms.
  stats.markHidden();
  assert.equal(stats.record(400, 0.6), false);

  // Unannounced > MAX_VALID_INTERVAL_MS gap is also excluded from interval stats.
  assert.equal(stats.record(MAX_VALID_INTERVAL_MS + 50, 0.7), false);

  // Subsequent normal frame is recorded again.
  assert.equal(stats.record(16.6, 0.45), true);

  const snap = stats.snapshot();
  assert.equal(snap.samples, 3);
  assert.equal(snap.dropped, 0, 'excluded first/hidden intervals must not inflate dropped count');
  assert.equal(snap.interval.max, 16.7);
  assert.equal(snap.work.max, 0.5);
});

test('ignores non-finite and negative work inputs and resets cleanly', () => {
  const stats = createFrameStats({ capacity: 16 });
  assert.equal(stats.record(Number.NaN, 0.5), false);
  assert.equal(stats.record(Number.POSITIVE_INFINITY, 0.5), false);
  assert.equal(stats.record(16.7, Number.NaN), false);
  assert.equal(stats.record(16.7, Number.NEGATIVE_INFINITY), false);
  assert.equal(stats.record(16.7, -0.1), false);
  assert.equal(stats.record(undefined, undefined), false);
  assert.equal(stats.snapshot().samples, 0);

  assert.equal(stats.record(16.7, 0.4), true);
  assert.equal(stats.snapshot().samples, 1);
  stats.reset();
  assert.equal(stats.snapshot().samples, 0);
});

test('100,000 record() calls allocate zero steady-state objects under --expose-gc', () => {
  const script = `
    import { createFrameStats } from ${JSON.stringify(new URL('../src/perf/frameStats.js', import.meta.url).href)};
    import inspector from 'node:inspector';

    const stats = createFrameStats({ capacity: 240 });
    for (let i = 0; i < 10000; i += 1) stats.record(16.67, 0.4);
    process.memoryUsage(); // warm lazy RSS/heapUsed object shape before measuring

    globalThis.gc();
    globalThis.gc();
    const m0 = process.memoryUsage().heapUsed;
    const m1 = process.memoryUsage().heapUsed;
    const callOverhead = Math.max(0, m1 - m0);

    globalThis.gc();
    globalThis.gc();
    const beforeNoGc = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100000; i += 1) {
      stats.record(16.67, 0.42);
    }
    const afterNoGc = process.memoryUsage().heapUsed;
    const preGcNetBytes = Math.max(0, afterNoGc - beforeNoGc - callOverhead);

    const session = new inspector.Session();
    session.connect();
    await new Promise((r) => session.post('HeapProfiler.enable', () =>
      session.post('HeapProfiler.startSampling', { samplingInterval: 32 }, r)
    ));
    for (let i = 0; i < 100000; i += 1) {
      stats.record(16.67, 0.42);
    }
    const profile = await new Promise((r) =>
      session.post('HeapProfiler.stopSampling', (_, res) => r(res.profile))
    );
    session.disconnect();
    function sum(node) {
      let total = node.selfSize || 0;
      for (const c of node.children || []) total += sum(c);
      return total;
    }
    process.stdout.write(JSON.stringify({
      preGcNetBytes,
      sampledBytes: sum(profile.head),
      samples: stats.snapshot().samples,
    }));
  `;

  const raw = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const result = JSON.parse(raw);
  assert.equal(result.samples, 240);
  assert.ok(
    result.preGcNetBytes < 16384,
    `expected zero young-gen allocations over 100k record() calls without GC, got ${result.preGcNetBytes} B`,
  );
  assert.ok(
    result.sampledBytes < 16384,
    `expected near-zero sampled allocations over 100k record() calls, got ${result.sampledBytes} B`,
  );
});
