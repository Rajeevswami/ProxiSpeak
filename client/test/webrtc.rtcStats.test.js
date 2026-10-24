/**
 * Connection stats tests (Day 9): the ~1 s `getStats()` poll, the bytes and
 * state it exposes, and the "no timer left behind" cleanup rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRtcStats } from '../src/webrtc/rtcStats.js';

/** Interval recorder: nothing runs on its own, tests fire callbacks manually. */
function createFakeTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    intervals,
    setIntervalFn: (fn, ms) => {
      const id = next++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearIntervalFn: (id) => {
      intervals.delete(id);
    },
    async fireAll() {
      for (const { fn } of [...intervals.values()]) await fn();
    },
  };
}

const fakePc = (report, connectionState = 'connected') => ({
  connectionState,
  getStats: async () => report,
});

const reportWith = (...entries) => {
  const map = new Map();
  entries.forEach((entry, index) => map.set(index, entry));
  return map;
};

test('the poll exposes connectionState and inbound audio bytesReceived', async () => {
  const timers = createFakeTimers();
  const stats = createRtcStats({ setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });

  const pc = fakePc(
    reportWith(
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 1234 },
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 766 },
      { type: 'inbound-rtp', kind: 'video', bytesReceived: 999999 }, // never counted
      { type: 'outbound-rtp', kind: 'audio', bytesSent: 42 },
    ),
    'connected',
  );

  stats.watch('bob', pc);
  await new Promise((resolve) => setImmediate(resolve)); // the immediate first read

  const row = stats.get('bob');
  assert.equal(row.connectionState, 'connected');
  assert.equal(row.bytesReceived, 2000, 'audio inbound-rtp only, summed');
  assert.equal(stats.activeTimers(), 1);
  assert.deepEqual(timers.intervals.get(1).ms, 1000, 'about once per second per peer');
});

test('bytes accumulate on every poll and stop when the peer is unwatched', async () => {
  const timers = createFakeTimers();
  const stats = createRtcStats({ setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });

  let bytes = 100;
  const pc = fakePc(null);
  pc.getStats = async () => reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: (bytes *= 2) });

  stats.watch('bob', pc);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats.get('bob').bytesReceived, 200);

  await timers.fireAll();
  assert.equal(stats.get('bob').bytesReceived, 400);

  stats.unwatch('bob');
  assert.equal(stats.activeTimers(), 0);
  assert.equal(stats.get('bob'), null);
  assert.deepEqual(stats.snapshot(), []);
});

test('stopAll leaves zero timers and zero rows — closeAll leaves nothing behind', async () => {
  const timers = createFakeTimers();
  const stats = createRtcStats({ setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });

  stats.watch('bob', fakePc(reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 1 })));
  stats.watch('cat', fakePc(reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 2 })));
  assert.equal(stats.activeTimers(), 2);

  stats.stopAll();
  assert.equal(stats.activeTimers(), 0);
  assert.equal(timers.intervals.size, 0, 'every interval handle is cleared');
  assert.deepEqual(stats.snapshot(), []);
});

test('late getStats reads cannot revive stopped rows or overwrite a replacement peer', async () => {
  const timers = createFakeTimers();
  const stats = createRtcStats({ setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  let resolveOld;
  let resolveNew;
  const oldPc = fakePc(null);
  const newPc = fakePc(null);
  oldPc.getStats = () => new Promise((resolve) => { resolveOld = resolve; });
  newPc.getStats = () => new Promise((resolve) => { resolveNew = resolve; });

  stats.watch('bob', oldPc);
  stats.watch('bob', newPc);
  resolveNew(reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 200 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats.get('bob').bytesReceived, 200);

  resolveOld(reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 100 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats.get('bob').bytesReceived, 200, 'the old pc cannot overwrite current metrics');

  let resolveStopped;
  const stoppedPc = fakePc(null);
  stoppedPc.getStats = () => new Promise((resolve) => { resolveStopped = resolve; });
  stats.watch('cat', stoppedPc);
  stats.stopAll();
  resolveStopped(reportWith({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 300 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stats.snapshot(), [], 'stopAll stays final even when an old read resolves');
  assert.equal(stats.activeTimers(), 0);
});

test('a failing getStats is logged and never breaks the poll', async () => {
  const timers = createFakeTimers();
  const debugs = [];
  const stats = createRtcStats({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logger: { debug: (...args) => debugs.push(args) },
  });

  const pc = fakePc(reportWith());
  pc.getStats = () => Promise.reject(new Error('stats exploded'));
  stats.watch('bob', pc);
  await new Promise((resolve) => setImmediate(resolve));
  await timers.fireAll();

  assert.equal(debugs.length, 2);
  assert.match(String(debugs[0].join(' ')), /stats exploded/);
  assert.equal(stats.activeTimers(), 1, 'the poll keeps running');
});
