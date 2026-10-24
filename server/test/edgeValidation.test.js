import test from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';

import { MemoryEdgeStore } from '../src/services/edgeStore.js';
import { RedisEdgeStore } from '../src/services/redisEdgeStore.js';
import { sweepOrphanEdges } from '../src/services/edgeSweep.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();
const redisOpts = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST to run Redis edge-distance sweep validation' };
const ROOM = 'lobby';
const DROP = 115;

function presenceModel(rows) {
  return {
    find(filter = {}) {
      const ids = filter.sessionId?.$in;
      return {
        lean: async () => rows.filter((row) => !ids || ids.includes(row.sessionId)).map((row) => ({ ...row })),
      };
    },
  };
}

function makeIo(store, rows) {
  const events = [];
  const io = {
    edgeStore: store,
    peerGraph: {
      dropRadiusPx: DROP,
      rooms: new Map([[ROOM, { users: new Map() }]]),
      meshCounters: { validationRemovals: 0 },
    },
    to(recipient) {
      return { emit: (event, payload) => events.push({ recipient, event, payload }) };
    },
  };
  return { io, events, presenceModel: presenceModel(rows) };
}

function row(id, x, y = 0) {
  return { sessionId: id, roomId: ROOM, x, y };
}

async function exerciseValidationContract(store) {
  const rows = [
    row('near_a', 0), row('near_b', 50),
    row('band_a', 200), row('band_b', 310),
    row('exact_a', 400), row('exact_b', 515),
    row('far_a', 600), row('far_b', 760),
  ];
  for (const [a, b] of [['near_a', 'near_b'], ['band_a', 'band_b'], ['exact_a', 'exact_b'], ['far_a', 'far_b']]) {
    // Active socket joins initialize both endpoint revisions before syncing.
    // eslint-disable-next-line no-await-in-loop
    await store.bumpPositionRevision(a);
    // eslint-disable-next-line no-await-in-loop
    await store.bumpPositionRevision(b);
    // eslint-disable-next-line no-await-in-loop
    await store.createEdge(ROOM, a, b);
  }
  const { io, events, presenceModel: model } = makeIo(store, rows);
  const result = await sweepOrphanEdges(io, { presenceModel: model, validationLimit: 100 });

  assert.equal(result.validationRemovals, 1);
  assert.equal(result.removedEdges, 1);
  assert.equal(result.cleanedUsers, 0);
  assert.equal(io.peerGraph.meshCounters.validationRemovals, 1);
  assert.ok(await store.getEdge('near_a', 'near_b'), 'near edge remains');
  assert.ok(await store.getEdge('band_a', 'band_b'), 'hysteresis-band edge remains');
  assert.ok(await store.getEdge('exact_a', 'exact_b'), 'exactly-at-drop edge remains');
  assert.equal(await store.getEdge('far_a', 'far_b'), null, 'beyond-drop edge is removed');
  assert.equal(events.length, 2, 'both endpoints receive one normal disconnect');
  assert.deepEqual([...new Set(events.map((entry) => entry.event))], ['peer:disconnect']);
  assert.deepEqual(events.map((entry) => entry.recipient).sort(), ['far_a', 'far_b']);
  assert.ok(events.every((entry) => entry.payload.generation === 1));
}

test('[MemoryEdgeStore] sweep validates stored positions and preserves the exact drop boundary', async () => {
  await exerciseValidationContract(new MemoryEdgeStore({ maxPeersPerUser: 0 }));
});

test('[RedisEdgeStore] SCAN-based sweep validates stored positions and preserves the exact drop boundary', redisOpts, async () => {
  const client = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await client.connect();
  const keyPrefix = `edge_validation_${process.pid}`;
  const store = new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120, maxPeersPerUser: 0 });
  try {
    await exerciseValidationContract(store);
  } finally {
    const keys = await store.scanKeys(`${keyPrefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit().catch(() => client.disconnect(false));
  }
});

test('distance validation is batch-limited and successive passes cover the remaining edges', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  const rows = [];
  for (let index = 0; index < 5; index += 1) {
    const a = `batch_a_${index}`;
    const b = `batch_b_${index}`;
    rows.push(row(a, index * 300), row(b, index * 300 + 200));
    // eslint-disable-next-line no-await-in-loop
    await store.bumpPositionRevision(a);
    // eslint-disable-next-line no-await-in-loop
    await store.bumpPositionRevision(b);
    // eslint-disable-next-line no-await-in-loop
    await store.createEdge(ROOM, a, b);
  }
  const { io, events, presenceModel: model } = makeIo(store, rows);
  const removals = [];
  let offset = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sweepOrphanEdges(io, {
      presenceModel: model,
      validationLimit: 2,
      validationOffset: offset,
    });
    assert.ok(result.validationRemovals <= 2, 'a pass never exceeds its batch limit');
    removals.push(result.validationRemovals);
    offset = result.nextValidationOffset;
  }
  assert.equal(removals.reduce((sum, count) => sum + count, 0), 5);
  assert.equal((await store.allEdges(ROOM)).length, 0);
  assert.equal(events.length, 10);
  assert.equal(io.peerGraph.meshCounters.validationRemovals, 5);
});

test('concurrent distance sweeps elect one remover and emit no duplicate disconnects', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  await store.bumpPositionRevision('concurrent_a');
  await store.bumpPositionRevision('concurrent_b');
  await store.createEdge(ROOM, 'concurrent_a', 'concurrent_b');
  const rows = [row('concurrent_a', 0), row('concurrent_b', 460)];
  const first = makeIo(store, rows);
  const second = makeIo(store, rows);
  const results = await Promise.all([
    sweepOrphanEdges(first.io, { presenceModel: first.presenceModel }),
    sweepOrphanEdges(second.io, { presenceModel: second.presenceModel }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.validationRemovals, 0), 1);
  assert.equal(first.events.length + second.events.length, 2);
  assert.equal(await store.getEdge('concurrent_a', 'concurrent_b'), null);
});

async function exerciseValidationRemovalFencing(store) {
  await store.bumpPositionRevision('fenced_a');
  await store.bumpPositionRevision('fenced_b');
  await store.createEdge(ROOM, 'fenced_a', 'fenced_b');
  const rows = [row('fenced_a', 0), row('fenced_b', 460)];
  const { io, events, presenceModel: model } = makeIo(store, rows);
  const originalRemove = store.removeEdgeWithRecord.bind(store);
  let armed = true;
  store.removeEdgeWithRecord = async (...args) => {
    if (armed) {
      armed = false;
      // The accepted move writes its near position and bumps before the
      // atomic remove. The sweep's old expected revision must lose this race.
      rows[1].x = 40;
      await store.bumpPositionRevision('fenced_b');
    }
    return originalRemove(...args);
  };

  const result = await sweepOrphanEdges(io, { presenceModel: model });
  assert.equal(result.validationRemovals, 0);
  assert.equal(result.removedEdges, 0);
  assert.equal(events.length, 0, 'a valid edge is not disconnected by a stale sweep');
  assert.ok(await store.getEdge('fenced_a', 'fenced_b'));
}

test('[MemoryEdgeStore] distance removal is fenced against a completed position/revision change', async () => {
  await exerciseValidationRemovalFencing(new MemoryEdgeStore({ maxPeersPerUser: 0 }));
});

test('[RedisEdgeStore] distance removal is fenced against a completed position/revision change', redisOpts, async () => {
  const client = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await client.connect();
  const keyPrefix = `edge_validation_fence_${process.pid}`;
  const store = new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120, maxPeersPerUser: 0 });
  try {
    await exerciseValidationRemovalFencing(store);
  } finally {
    const keys = await store.scanKeys(`${keyPrefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit().catch(() => client.disconnect(false));
  }
});
