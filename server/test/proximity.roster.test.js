import test from 'node:test';
import assert from 'node:assert/strict';
import UserPresence from '../src/models/UserPresence.js';
import { computeClusters } from '../src/services/proximityService.js';

test('computeClusters uses ONE lean roster query and an in-memory grid', async (t) => {
  const users = [
    { sessionId: 'A', x: 100, y: 100 }, { sessionId: 'B', x: 190, y: 100 },
    { sessionId: 'C', x: 280, y: 100 }, { sessionId: 'D', x: 1000, y: 100 },
  ];
  let queries = 0; let projection = null;
  t.mock.method(UserPresence, 'find', (filter) => {
    queries++;
    assert.equal(filter.roomId, 'room');
    assert.ok(filter.lastSeen.$gte instanceof Date);
    assert.equal(filter.location, undefined, 'no $near per user in fast clustering');
    return {
      select(fields) { projection = fields; return this; },
      sort() { return this; },
      async lean() { return users; },
    };
  });
  // Chain A-B-C (A..C = 180px apart) is one connected component.
  assert.deepEqual(await computeClusters('room'), [['A', 'B', 'C'], ['D']]);
  assert.equal(queries, 1, 'exactly one roster query');
  assert.match(projection, /sessionId/); assert.match(projection, /x/); assert.match(projection, /y/);
  assert.match(projection, /-_id/, 'projection is id/x/y only — not even the default _id');
});

test('empty room: still one query, no empty clusters', async (t) => {
  let queries = 0;
  t.mock.method(UserPresence, 'find', () => {
    queries++;
    return { select() { return this; }, sort() { return this; }, async lean() { return []; } };
  });
  assert.deepEqual(await computeClusters('empty'), []);
  assert.equal(queries, 1);
});
