import test from 'node:test';
import assert from 'node:assert/strict';
import UserPresence from '../src/models/UserPresence.js';
import { computeClusters } from '../src/services/proximityService.js';

test('one final room/live roster query drops vanished bridge and empty clusters', async (t) => {
  const users = [
    { sessionId: 'A', x: 100, y: 100 }, { sessionId: 'B', x: 190, y: 100 },
    { sessionId: 'C', x: 280, y: 100 }, { sessionId: 'D', x: 1000, y: 100 },
  ];
  let queries = 0, rechecks = 0;
  t.mock.method(UserPresence, 'find', (filter) => {
    queries++;
    assert.equal(filter.roomId, 'room');
    assert.ok(filter.lastSeen.$gte instanceof Date);
    let result;
    if (filter.sessionId?.$in) {
      rechecks++;
      assert.deepEqual([...filter.sessionId.$in].sort(), ['A', 'B', 'C', 'D']);
      // B (a bridge) and D disappeared after neighbor discovery. Do not split A/C.
      result = [{ sessionId: 'A' }, { sessionId: 'C' }];
    } else if (filter.location) {
      const center = users.find((u) => u.sessionId === filter.sessionId.$ne);
      result = users.filter((u) => u !== center && Math.hypot(u.x - center.x, u.y - center.y) <= 100);
    } else result = users;
    return { sort() { return this; }, select() { return this; }, async lean() { return result; } };
  });
  assert.deepEqual(await computeClusters('room'), [['A', 'C']]);
  assert.equal(queries, 6, 'N neighbor queries + initial roster + ONE final roster query');
  assert.equal(rechecks, 1);
});

test('empty room still has a single final roster check and no empty clusters', async (t) => {
  let queries = 0;
  t.mock.method(UserPresence, 'find', () => {
    queries++;
    return { sort() { return this; }, select() { return this; }, async lean() { return []; } };
  });
  assert.deepEqual(await computeClusters('empty'), []);
  assert.equal(queries, 2);
});
