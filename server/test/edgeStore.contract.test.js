/**
 * Parametric contract test suite shared 1-for-1 between `MemoryEdgeStore`
 * and `RedisEdgeStore` (Week 3, Day 12).
 *
 * When `REDIS_URL_TEST` is unset, the Memory suite runs in full and the Redis
 * suite emits a loud `NOT VERIFIED` banner and marks each Redis subtest skipped.
 * When `REDIS_URL_TEST` is set, ZERO tests are skipped.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';

import {
  MemoryEdgeStore,
  decodePairToken,
  edgeKey,
  encodePairToken,
  validateKeyPrefix,
  validateRoomId,
  validateUserId,
} from '../src/services/edgeStore.js';
import { RedisEdgeStore } from '../src/services/redisEdgeStore.js';
import { redactRedisUrl } from '../src/db/redis.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();

if (!REDIS_URL_TEST) {
  console.error([
    '# =====================================================================',
    '#  Day 12 RedisEdgeStore contract tests: NOT VERIFIED',
    '#  REDIS_URL_TEST is unset. Start Redis and re-run:',
    '#    REDIS_URL_TEST="redis://127.0.0.1:6379" npm test',
    '# =====================================================================',
  ].join('\n'));
}

test('ID, room, prefix validators and canonical pair token encoding reject unsafe inputs and prevent collisions', () => {
  for (const badId of ['', '   ', 'user:1', 'user*1', 'user?1', 'user\r\nPING', 'a'.repeat(129)]) {
    assert.throws(() => validateUserId(badId), /userId/);
  }
  for (const badRoom of ['', 'Lobby', 'room:1', 'room*', '-leading', 'a'.repeat(49)]) {
    assert.throws(() => validateRoomId(badRoom), /roomId/);
  }
  for (const badPrefix of ['', 'prefix:colon', 'prefix*', 'prefix space', 'a'.repeat(49)]) {
    assert.throws(() => validateKeyPrefix(badPrefix), /keyPrefix/);
  }

  const t1 = encodePairToken('ab_c', 'def');
  const t2 = encodePairToken('ab', 'c_def');
  assert.notEqual(t1, t2, 'length-prefixed canonical encoding is immune to delimiter shifts');
  assert.deepEqual(decodePairToken(t1), { a: 'ab_c', b: 'def' });
  assert.deepEqual(decodePairToken(t2), { a: 'ab', b: 'c_def' });
  assert.equal(encodePairToken('zeta', 'alpha'), encodePairToken('alpha', 'zeta'));
});

function defineEdgeStoreContractSuite(label, { skipReason = false, makeCluster } = {}) {
  const testOpts = skipReason ? { skip: skipReason } : {};

  test(`[${label}] symmetry, deterministic initiator, and delimiter non-collision`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      const [s1, s2] = cluster.stores;

      const created = await s1.createEdge('lobby', 'zed', 'amy');
      assert.deepEqual(created, { created: true, generation: 1 });

      const duplicate = await s2.createEdge('lobby', 'amy', 'zed');
      assert.deepEqual(duplicate, { created: false, generation: 1 });

      const edge = await s2.getEdge('zed', 'amy');
      assert.deepEqual(edge, {
        key: edgeKey('amy', 'zed'),
        roomId: 'lobby',
        a: 'amy',
        b: 'zed',
        generation: 1,
        initiator: 'amy',
      });

      // Distinct tricky IDs cannot collide on the same Redis/Memory key
      const left = await s1.createEdge('lobby', 'ab_c', 'def');
      const right = await s2.createEdge('lobby', 'ab', 'c_def');
      assert.equal(left.created, true);
      assert.equal(right.created, true);
      assert.notEqual((await s1.getEdge('ab_c', 'def')).key, (await s2.getEdge('ab', 'c_def')).key);
    } finally {
      await cluster.cleanup();
    }
  });

  test(`[${label}] 200 concurrent createEdge calls elect exactly ONE winner and identical generation`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 200 }, (_, i) => {
          const store = cluster.stores[i % cluster.stores.length];
          const [first, second] = i % 2 === 0 ? ['peer_alpha', 'peer_beta'] : ['peer_beta', 'peer_alpha'];
          return store.createEdge('lobby', first, second);
        }),
      );

      const winners = outcomes.filter((o) => o.created === true);
      const losers = outcomes.filter((o) => o.created === false);
      assert.equal(winners.length, 1, 'at most and at least one concurrent caller wins createEdge');
      assert.equal(losers.length, 199);
      assert.equal(winners[0].generation, 1);
      assert.ok(outcomes.every((o) => o.generation === 1), 'every caller sees generation 1');
    } finally {
      await cluster.cleanup();
    }
  });

  test(`[${label}] 50 concurrent removeEdge calls return strict boolean true for ONLY ONE winner`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      await cluster.stores[0].createEdge('lobby', 'alice', 'bob');

      // Wrong room does not delete
      const wrongRoom = await cluster.stores[1].removeEdge('garden', 'alice', 'bob');
      assert.strictEqual(wrongRoom, false);

      const removals = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          cluster.stores[i % cluster.stores.length].removeEdge(
            'lobby',
            i % 2 === 0 ? 'alice' : 'bob',
            i % 2 === 0 ? 'bob' : 'alice',
          ),
        ),
      );
      assert.ok(removals.every((r) => typeof r === 'boolean'));
      assert.equal(removals.filter((r) => r === true).length, 1);
      assert.equal(removals.filter((r) => r === false).length, 49);
      assert.equal(await cluster.stores[0].getEdge('alice', 'bob'), null);
    } finally {
      await cluster.cleanup();
    }
  });

  test(`[${label}] monotonic per-pair generation across instances (1..6) independent of other pairs`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      const seenGenerations = [];
      for (let cycle = 0; cycle < 6; cycle += 1) {
        const creator = cluster.stores[cycle % cluster.stores.length];
        const remover = cluster.stores[(cycle + 1) % cluster.stores.length];
        // eslint-disable-next-line no-await-in-loop
        const res = await creator.createEdge('lobby', 'u_one', 'u_two');
        assert.equal(res.created, true);
        seenGenerations.push(res.generation);
        // eslint-disable-next-line no-await-in-loop
        const removed = await remover.removeEdge('lobby', 'u_two', 'u_one');
        assert.strictEqual(removed, true);
      }
      assert.deepEqual(seenGenerations, [1, 2, 3, 4, 5, 6]);

      const unrelated = await cluster.stores[0].createEdge('lobby', 'u_one', 'u_three');
      assert.deepEqual(unrelated, { created: true, generation: 1 });
    } finally {
      await cluster.cleanup();
    }
  });

  test(`[${label}] edgesOf, removeUser atomicity, and zero leftover keys after session teardown`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      const [s1, s2] = cluster.stores;
      await s1.createEdge('lobby', 'hub', 'spoke_a');
      await s2.createEdge('lobby', 'spoke_b', 'hub');
      await s1.createEdge('garden', 'hub', 'spoke_c');
      await s2.createEdge('lobby', 'spoke_a', 'spoke_b');

      const hubEdges = await s2.edgesOf('hub');
      assert.equal(hubEdges.length, 3);

      const removed = await s1.removeUser('hub');
      assert.equal(removed.length, 3);
      assert.deepEqual(await s2.edgesOf('hub'), []);
      assert.equal((await s1.edgesOf('spoke_a')).length, 1, 'unrelated edge spoke_a <-> spoke_b stays intact');

      await s2.removeUser('spoke_a');
      await s1.removeUser('spoke_b');
      await s2.removeUser('spoke_c');

      assert.equal(await cluster.countKeys(), 0, 'zero leftover keys remain in store');
    } finally {
      await cluster.cleanup();
    }
  });

  test(`[${label}] reconnecting peer after removeUser advances generation strictly past surviving peer floor`, testOpts, async () => {
    const cluster = await makeCluster();
    try {
      const [s1, s2] = cluster.stores;
      const initial = await s1.createEdge('lobby', 'dana_old', 'bob_live');
      assert.deepEqual(initial, { created: true, generation: 1 });

      await s1.removeUser('dana_old');
      const reconnected = await s1.createEdge('lobby', 'dana_fresh', 'bob_live');
      assert.equal(reconnected.created, true);
      assert.ok(reconnected.generation > initial.generation, 'reconnect edge strictly exceeds departed generation');

      await s2.removeUser('dana_fresh');
      await s1.removeUser('bob_live');
      assert.equal(await cluster.countKeys(), 0);
    } finally {
      await cluster.cleanup();
    }
  });
}

// 1. Always verify MemoryEdgeStore
defineEdgeStoreContractSuite('MemoryEdgeStore', {
  async makeCluster() {
    const shared = new MemoryEdgeStore();
    return {
      stores: [shared, shared],
      countKeys: async () => shared.countStoreKeys(),
      cleanup: async () => {},
    };
  },
});

// 2. Verify RedisEdgeStore across independent ioredis clients sharing Redis
let redisPool = [];
before(async () => {
  if (!REDIS_URL_TEST) return;
  const c1 = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  const c2 = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  const c3 = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await Promise.all([c1.connect(), c2.connect(), c3.connect()]);
  redisPool = [c1, c2, c3];
});

after(async () => {
  await Promise.all(redisPool.map((c) => c.quit().catch(() => c.disconnect(false))));
});

let prefixCounter = 0;
defineEdgeStoreContractSuite('RedisEdgeStore', {
  skipReason: REDIS_URL_TEST
    ? false
    : 'NOT VERIFIED — set REDIS_URL_TEST="redis://127.0.0.1:6379" to run RedisEdgeStore contract suite',
  async makeCluster() {
    prefixCounter += 1;
    const keyPrefix = `contract_${process.pid}_${prefixCounter}`;
    const stores = redisPool.map(
      (client) => new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120 }),
    );
    return {
      stores,
      countKeys: () => stores[0].countStoreKeys(),
      cleanup: async () => {
        const keys = await stores[0].scanKeys(`${keyPrefix}:*`);
        if (keys.length) await redisPool[0].del(...keys);
      },
    };
  },
});

test('Redis test target URL redacts credentials cleanly when logged', () => {
  assert.equal(
    redactRedisUrl('redis://alice:s3cr3t@redis.example.com:6379/0'),
    'redis://***:***@redis.example.com:6379/0',
  );
});
