import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config/index.js';
import { findNearby, countWithin, computeClusters, nearQuery } from '../src/services/proximityService.js';

test('proximity rejects operator objects and malformed identifiers before querying', async () => {
  for (const room of [{ $ne: null }, ['room'], '', 'ROOM', 'a'.repeat(49)]) {
    await assert.rejects(findNearby(room, 'self'), /roomId/);
    await assert.rejects(countWithin(room, { x: 0, y: 0 }), /roomId/);
    await assert.rejects(computeClusters(room), /roomId/);
  }
  for (const id of [{ $ne: null }, ['self'], '', 'x'.repeat(129)]) {
    await assert.rejects(findNearby('room', id), /userId/);
  }
});

test('proximity rejects nonfinite, negative, and beyond-world radii before querying', async () => {
  for (const radius of [NaN, Infinity, -1, 1e100, Math.hypot(config.world.width, config.world.height) + 1]) {
    await assert.rejects(findNearby('room', 'self', radius), /radiusPx/);
    await assert.rejects(countWithin('room', { x: 0, y: 0 }, radius), /radiusPx/);
    await assert.rejects(computeClusters('room', radius), /radiusPx/);
  }
});

test('query builder validates centre and identifiers without MongoDB', () => {
  for (const center of [null, {}, { x: NaN, y: 0 }, { x: -1, y: 0 },
    { x: 0, y: config.world.height + 1 }]) {
    assert.throws(() => nearQuery('room', center), /center/);
  }
  assert.throws(() => nearQuery({ $ne: null }, { x: 0, y: 0, sessionId: 'self' }), /roomId/);
  assert.throws(() => nearQuery('room', { x: 0, y: 0, sessionId: { $ne: null } }), /userId/);
  assert.ok(nearQuery('room', { x: 0, y: 0, sessionId: 'self' }, 0));
});
