import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config/index.js';
import UserPresence from '../src/models/UserPresence.js';
import { cleanupOnBoot, cleanupStale, startPresenceCleanup } from '../src/services/presenceCleanup.js';

test('cleanup query double: instance ownership, atomic age recheck, room broadcasts', async (t) => {
  const stale = new Date(0);
  const fresh = new Date(10000);
  const rows = [
    { _id: 'old', sessionId: 'old', roomId: 'a', instanceId: 'ours', lastSeen: stale },
    { _id: 'refresh', sessionId: 'refresh', roomId: 'b', instanceId: 'ours', lastSeen: stale },
    { _id: 'new', sessionId: 'new', roomId: 'b', instanceId: 'ours', lastSeen: fresh },
    { _id: 'foreign', sessionId: 'foreign', roomId: 'a', instanceId: 'theirs', lastSeen: stale },
  ];
  const deletes = [], events = [];
  t.mock.method(UserPresence, 'find', (filter) => ({ lean: async () => {
    assert.equal(filter.instanceId, 'ours');
    const candidates = rows.filter((row) => row.instanceId === filter.instanceId && row.lastSeen < filter.lastSeen.$lt).map((r) => ({ ...r }));
    rows.find((r) => r._id === 'refresh').lastSeen = fresh; // heartbeat between read and delete
    return candidates;
  } }));
  t.mock.method(UserPresence, 'deleteOne', async (filter) => {
    deletes.push(filter);
    const i = rows.findIndex((row) => row._id === filter._id && row.roomId === filter.roomId && row.instanceId === filter.instanceId && row.lastSeen < filter.lastSeen.$lt);
    if (i < 0) return { deletedCount: 0 };
    rows.splice(i, 1); return { deletedCount: 1 };
  });
  await cleanupStale({ to: (room) => ({ emit: (event, data) => events.push({ room, event, ...data }) }) },
    { instanceId: 'ours', now: 10000, timeoutMs: 5000 });
  assert.equal(deletes.length, 2);
  assert.deepEqual(events, [{ room: 'a', event: 'user:left', id: 'old' }]);
  assert.deepEqual(rows.map((r) => r._id), ['refresh', 'new', 'foreign']);
  t.mock.method(UserPresence, 'deleteMany', async (filter) => {
    assert.deepEqual(filter, { instanceId: 'ours' }); return { deletedCount: 2 };
  });
  await cleanupOnBoot('ours', { multiInstance: true });
});

test('single-instance boot cleanup removes rows from a previous random instance id', async () => {
  const filters = [];
  const presenceModel = {
    deleteMany: async (filter) => {
      filters.push(filter);
      return { deletedCount: 0 };
    },
  };

  await cleanupOnBoot('replacement-node', { presenceModel, multiInstance: false });
  await cleanupOnBoot('replacement-node', { presenceModel, multiInstance: true });

  assert.deepEqual(filters, [
    {},
    { instanceId: 'replacement-node' },
  ], 'only multi-instance boot cleanup may preserve other instances\' rows');
});

test('cleanup timer uses config, does not overlap, stops and drains in-flight sweep', async (t) => {
  let tick, cleared, release, scans = 0, unref = false;
  const handle = { unref: () => { unref = true; } };
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    assert.equal(ms, config.presence.cleanupIntervalMs); tick = fn; return handle;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared = timer; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(UserPresence, 'find', () => ({ lean: async () => { scans++; await gate; return []; } }));
  const stop = startPresenceCleanup({});
  tick(); tick();
  assert.equal(scans, 1);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  assert.equal(cleared, handle);
  assert.equal(unref, true);
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stopping; assert.equal(stopped, true);
});

test('move persistence atomically updates only its owner and never upserts', async (t) => {
  const { upsertPosition } = await import('../src/services/presenceStore.js');
  const { createGeoTransform } = await import('../src/utils/geo.js');
  t.mock.method(UserPresence, 'updateOne', async (filter, update, options) => {
    assert.deepEqual(filter, { sessionId: 'expired', roomId: 'room', instanceId: 'ours' });
    assert.equal(options.upsert, false);
    assert.equal(update.$set.sessionId, 'expired');
    return { matchedCount: 0 };
  });
  const result = await upsertPosition({ id: 'expired', roomId: 'room', instanceId: 'ours',
    x: 10, y: 10, name: 'Gone', color: '#fff' }, createGeoTransform(config.world), { upsert: false });
  assert.equal(result.matchedCount, 0);
});
