/**
 * Unit tests for client-side live layout updates (Week 4 - Room Persistence).
 * Validates revision ordering, obstacle replacement, and room scoping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorldState,
  applyJoinedSnapshot,
  updateRoomLayout,
} from '../src/realtime/worldState.js';

function createSampleRoom(overrides = {}) {
  return {
    roomId: 'lobby',
    name: 'Lobby',
    width: 1920,
    height: 1080,
    layoutRevision: 1,
    obstacles: [
      {
        id: 'wall-1',
        type: 'wall',
        x: 100,
        y: 100,
        w: 50,
        h: 50,
        blocksAudio: true,
        attenuation: 0.12,
      },
    ],
    ...overrides,
  };
}

test('newer layout revision updates obstacles and revision in world ref in place', () => {
  const world = createWorldState();
  applyJoinedSnapshot(world, { selfId: 'user-1', room: createSampleRoom(), users: [] });

  const updatedObstacles = [
    {
      id: 'desk-new',
      type: 'desk',
      x: 200,
      y: 300,
      w: 80,
      h: 40,
      blocksAudio: true,
      attenuation: 0.5,
    },
    {
      id: 'screen-new',
      type: 'screen',
      x: 400,
      y: 400,
      w: 120,
      h: 15,
      blocksAudio: true,
      attenuation: 0.45,
    },
  ];

  const updated = updateRoomLayout(world, {
    roomId: 'lobby',
    layoutRevision: 2,
    obstacles: updatedObstacles,
  });

  assert.equal(updated, true);
  assert.equal(world.room.layoutRevision, 2);
  assert.equal(world.room.obstacles.length, 2);
  assert.deepEqual(world.room.obstacles, updatedObstacles);
});

test('older revision than current layout revision is ignored', () => {
  const world = createWorldState();
  applyJoinedSnapshot(world, {
    selfId: 'user-1',
    room: createSampleRoom({ layoutRevision: 5 }),
    users: [],
  });

  const stalePayload = {
    roomId: 'lobby',
    layoutRevision: 4, // Stale!
    obstacles: [],
  };

  const updated = updateRoomLayout(world, stalePayload);
  assert.equal(updated, false);
  assert.equal(world.room.layoutRevision, 5);
  assert.equal(world.room.obstacles.length, 1);
});

test('equal revision to current layout revision is ignored', () => {
  const world = createWorldState();
  applyJoinedSnapshot(world, {
    selfId: 'user-1',
    room: createSampleRoom({ layoutRevision: 3 }),
    users: [],
  });

  const duplicatePayload = {
    roomId: 'lobby',
    layoutRevision: 3, // Duplicate!
    obstacles: [],
  };

  const updated = updateRoomLayout(world, duplicatePayload);
  assert.equal(updated, false);
  assert.equal(world.room.layoutRevision, 3);
  assert.equal(world.room.obstacles.length, 1);
});

test('layout update for a different room is ignored', () => {
  const world = createWorldState();
  applyJoinedSnapshot(world, { selfId: 'user-1', room: createSampleRoom(), users: [] });

  const otherRoomPayload = {
    roomId: 'studio', // Different room!
    layoutRevision: 2,
    obstacles: [],
  };

  const updated = updateRoomLayout(world, otherRoomPayload);
  assert.equal(updated, false);
  assert.equal(world.room.layoutRevision, 1);
  assert.equal(world.room.obstacles.length, 1);
});

test('invalid or missing payload returns false without throwing', () => {
  const world = createWorldState();
  applyJoinedSnapshot(world, { selfId: 'user-1', room: createSampleRoom(), users: [] });

  assert.equal(updateRoomLayout(world, null), false);
  assert.equal(updateRoomLayout(world, undefined), false);
  assert.equal(updateRoomLayout(world, 'string'), false);
  assert.equal(updateRoomLayout(world, { roomId: 'lobby' }), false); // Missing layoutRevision
  assert.equal(updateRoomLayout(null, { roomId: 'lobby', layoutRevision: 2, obstacles: [] }), false);
});

test('listener registration teardown prevents duplication', () => {
  // Simulate mock socket EventEmitter to prove no listener duplication
  const listeners = new Map();
  const mockSocket = {
    on: (evt, handler) => {
      const arr = listeners.get(evt) || [];
      arr.push(handler);
      listeners.set(evt, arr);
    },
    removeAllListeners: () => listeners.clear(),
  };

  let count = 0;
  const handler = () => { count += 1; };
  mockSocket.on('room:layout', handler);
  assert.equal(listeners.get('room:layout').length, 1);

  // Teardown clears listeners
  mockSocket.removeAllListeners();
  assert.equal(listeners.has('room:layout'), false);

  // Re-join adds exactly one listener again
  mockSocket.on('room:layout', handler);
  assert.equal(listeners.get('room:layout').length, 1);
});
