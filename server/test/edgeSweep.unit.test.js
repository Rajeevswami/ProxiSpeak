import test from 'node:test';
import assert from 'node:assert/strict';

import { startOrphanEdgeSweep } from '../src/services/edgeSweep.js';

test('orphan-edge timer does not overlap and stop drains the active sweep', async (t) => {
  let tick;
  let cleared;
  let release;
  let scans = 0;
  let unref = false;
  const handle = { unref: () => { unref = true; } };
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    assert.equal(ms, 123);
    tick = fn;
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared = timer; });
  const gate = new Promise((resolve) => { release = resolve; });
  const edgeStore = {
    async allEdges() {
      scans += 1;
      await gate;
      return [];
    },
    async trackedPairUsers() { return []; },
  };
  const io = { edgeStore, peerGraph: { rooms: new Map() } };
  const log = { child() { return this; }, info() {}, warn() {} };

  const stop = startOrphanEdgeSweep(io, { intervalMs: 123, logger: log });
  tick();
  tick();
  assert.equal(scans, 1, 'an active sweep is reused instead of starting overlapping scans');

  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  assert.equal(cleared, handle);
  assert.equal(unref, true);
  await Promise.resolve();
  assert.equal(stopped, false);

  release();
  await stopping;
  assert.equal(stopped, true);
});
