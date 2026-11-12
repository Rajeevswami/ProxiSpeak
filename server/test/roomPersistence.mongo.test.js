/**
 * Real MongoDB persistence, revision conflict, concurrency, and seed idempotency tests
 * (Week 4 - Room Persistence).
 *
 * Runs against a dedicated, isolated test database when MongoDB is reachable.
 * If no MongoDB is reachable, cleanly reports skipped with an explicit banner,
 * matching repository conventions.
 *
 *   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test
 */
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config/index.js';
import { connectMongo, disconnectMongo, ensureIndexes, mongoose as db, redactUri } from '../src/db/mongo.js';
import Room from '../src/models/Room.js';
import {
  buildDefaultRoom,
  persistRoom,
  getRoom,
  saveLayout,
  invalidateRoomCache,
  backfillLegacyRoomRevisions,
} from '../src/services/roomService.js';
import { seedRooms } from '../scripts/seed.js';
import { RevisionConflictError, RoomNotFoundError } from '../src/utils/errors.js';

function withDatabaseName(uri, dbName) {
  const schemeEnd = uri.indexOf('://') + 3;
  const scheme = uri.slice(0, schemeEnd);
  const rest = uri.slice(schemeEnd);
  const pathStart = rest.search(/[/?]/);
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const tail = pathStart === -1 ? '' : rest.slice(pathStart);
  const query = tail.includes('?') ? tail.slice(tail.indexOf('?')) : '';
  return `${scheme}${authority}/${dbName}${query}`;
}

const BASE_URI = process.env.MONGO_URI_TEST ?? process.env.MONGO_URI ?? config.mongo.uri;
const TEST_DB = `proxispeak_week4_persistence_test_${process.pid}_${Date.now().toString(36)}`;
const TEST_URI = withDatabaseName(BASE_URI, TEST_DB);

let mongoReady = false;
let mongoError = null;

before(async () => {
  try {
    await connectMongo({ uri: TEST_URI });
    await ensureIndexes();
    mongoReady = true;
  } catch (err) {
    mongoError = err;
    console.error(
      '\n' +
        '=====================================================================\n' +
        ' Week 4 Room Persistence MongoDB tests: NOT VERIFIED\n' +
        ` No MongoDB reachable at ${redactUri(TEST_URI)}\n` +
        ' Start one, or point MONGO_URI_TEST at a test database, then re-run:\n' +
        '   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test\n' +
        '=====================================================================\n',
    );
  }
});

after(async () => {
  if (!mongoReady) return;
  try {
    await db.connection.dropDatabase();
  } catch {
    // Ignore drop database errors on teardown
  }
  await disconnectMongo();
});

function requireMongo(t) {
  if (mongoReady) return true;
  t.skip(`NOT VERIFIED — no MongoDB at ${redactUri(TEST_URI)} (${mongoError?.message ?? 'connection refused'})`);
  return false;
}

const createdRoomIds = new Set();

async function createFixtureRoom(label, overrides = {}) {
  const roomId = `week4-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const roomData = {
    ...buildDefaultRoom(roomId),
    name: `Room ${label}`,
    layoutRevision: 1,
    ...overrides,
  };
  await persistRoom(roomData);
  createdRoomIds.add(roomId);
  return roomId;
}

afterEach(async () => {
  if (!mongoReady || createdRoomIds.size === 0) return;
  const rooms = [...createdRoomIds];
  await Room.deleteMany({ roomId: { $in: rooms } });
  for (const r of rooms) invalidateRoomCache(r);
  createdRoomIds.clear();
});

test('saveLayout increments layoutRevision and persists obstacles atomically', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = await createFixtureRoom('increment');
  const initial = await getRoom(roomId);
  assert.equal(initial.layoutRevision, 1);

  const newObstacles = [
    {
      id: 'test-wall-1',
      type: 'wall',
      x: 100,
      y: 150,
      w: 80,
      h: 20,
      blocksAudio: true,
      attenuation: 0.12,
    },
  ];

  const saved = await saveLayout(roomId, {
    obstacles: newObstacles,
    expectedRevision: 1,
  });

  assert.equal(saved.layoutRevision, 2);
  assert.equal(saved.obstacles.length, 1);
  assert.equal(saved.obstacles[0].id, 'test-wall-1');

  // Verify directly in MongoDB
  invalidateRoomCache(roomId);
  const doc = await Room.findOne({ roomId }).lean();
  assert.equal(doc.layoutRevision, 2);
  assert.equal(doc.obstacles.length, 1);
  assert.equal(doc.obstacles[0].id, 'test-wall-1');
});

test('stale expectedRevision conflicts with 409 RevisionConflictError', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = await createFixtureRoom('stale');
  await saveLayout(roomId, {
    obstacles: [],
    expectedRevision: 1,
  });

  // Revision is now 2. Saving with expectedRevision: 1 must fail!
  await assert.rejects(
    async () => {
      await saveLayout(roomId, {
        obstacles: [],
        expectedRevision: 1,
      });
    },
    (err) => {
      assert(err instanceof RevisionConflictError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'revision_conflict');
      assert.equal(err.currentRevision, 2);
      assert.equal(err.expectedRevision, 1);
      return true;
    },
  );
});

test('50 concurrent saves with the same expected revision: exactly ONE wins and 49 conflict', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = await createFixtureRoom('concurrency');

  const saves = Array.from({ length: 50 }, (_, i) =>
    saveLayout(roomId, {
      expectedRevision: 1,
      obstacles: [
        {
          id: `wall-race-${i}`,
          type: 'wall',
          x: 10 * i,
          y: 20,
          w: 50,
          h: 10,
          blocksAudio: true,
          attenuation: 0.2,
        },
      ],
    }),
  );

  const results = await Promise.allSettled(saves);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one concurrent save must succeed');
  assert.equal(rejected.length, 49, 'Exactly 49 concurrent saves must be rejected');

  for (const r of rejected) {
    assert(r.reason instanceof RevisionConflictError);
    assert.equal(r.reason.status, 409);
    assert.equal(r.reason.currentRevision, 2);
  }

  // Database must show revision 2
  invalidateRoomCache(roomId);
  const doc = await Room.findOne({ roomId }).lean();
  assert.equal(doc.layoutRevision, 2);
});

test('saveLayout for unknown room throws 404 RoomNotFoundError', async (t) => {
  if (!requireMongo(t)) return;

  await assert.rejects(
    async () => {
      await saveLayout('nonexistent_room_99999', {
        obstacles: [],
        expectedRevision: 1,
      });
    },
    (err) => {
      assert(err instanceof RoomNotFoundError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'room_not_found');
      return true;
    },
  );
});

test('room dimensions width and height are immutable and preserved across layout saves', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = await createFixtureRoom('dims', { width: 1920, height: 1080 });

  await saveLayout(roomId, {
    obstacles: [],
    name: 'Updated Name',
    expectedRevision: 1,
  });

  invalidateRoomCache(roomId);
  const doc = await Room.findOne({ roomId }).lean();
  assert.equal(doc.width, 1920, 'Room width must remain immutable');
  assert.equal(doc.height, 1080, 'Room height must remain immutable');
  assert.equal(doc.name, 'Updated Name');
});

test('legacy documents without layoutRevision work and are safely backfilled', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = `week4-legacy-${Math.random().toString(36).slice(2, 8)}`;
  createdRoomIds.add(roomId);

  // Insert raw document without layoutRevision
  await db.connection.collection('rooms').insertOne({
    roomId,
    name: 'Legacy Room',
    width: 1920,
    height: 1080,
    obstacles: [],
    center: { type: 'Point', coordinates: [0, 0] },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // getRoom returns layoutRevision 1 as default
  const room = await getRoom(roomId);
  assert.equal(room.layoutRevision, 1);

  // Saving layout with expectedRevision 1 succeeds and sets layoutRevision to 2
  const saved = await saveLayout(roomId, {
    expectedRevision: 1,
    obstacles: [
      {
        id: 'legacy-wall',
        type: 'wall',
        x: 50,
        y: 50,
        w: 50,
        h: 50,
        blocksAudio: false,
        attenuation: 0.1,
      },
    ],
  });

  assert.equal(saved.layoutRevision, 2);

  // Direct backfill test: insert another legacy room and call backfillLegacyRoomRevisions()
  const legacy2 = `week4-legacy2-${Math.random().toString(36).slice(2, 8)}`;
  createdRoomIds.add(legacy2);
  await db.connection.collection('rooms').insertOne({
    roomId: legacy2,
    name: 'Legacy Room 2',
    width: 1920,
    height: 1080,
    obstacles: [],
    center: { type: 'Point', coordinates: [0, 0] },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const backfillResult = await backfillLegacyRoomRevisions();
  assert(backfillResult.modifiedCount >= 1);

  const doc2 = await Room.findOne({ roomId: legacy2 }).lean();
  assert.equal(doc2.layoutRevision, 1);
});

test('layout persistence across MongoDB reconnection simulates server restart', async (t) => {
  if (!requireMongo(t)) return;

  const roomId = await createFixtureRoom('restart');
  const obstacles = [
    {
      id: 'persisted-wall',
      type: 'wall',
      x: 200,
      y: 200,
      w: 100,
      h: 30,
      blocksAudio: true,
      attenuation: 0.25,
    },
  ];

  await saveLayout(roomId, {
    expectedRevision: 1,
    obstacles,
  });

  // Simulate server shutdown: disconnect MongoDB and clear in-memory cache
  invalidateRoomCache(roomId);
  await disconnectMongo();

  // Simulate server startup: reconnect MongoDB
  await connectMongo({ uri: TEST_URI });

  const reloaded = await getRoom(roomId);
  assert.equal(reloaded.layoutRevision, 2);
  assert.equal(reloaded.obstacles.length, 1);
  assert.equal(reloaded.obstacles[0].id, 'persisted-wall');
  assert.equal(reloaded.obstacles[0].attenuation, 0.25);
});

test('seed idempotency: custom saved layout survives a second seed run untouched', async (t) => {
  if (!requireMongo(t)) return;

  // Run initial seed
  await seedRooms();

  const lobby = await getRoom('lobby');
  assert(lobby, 'Lobby must exist after seed');
  const initialRevision = lobby.layoutRevision ?? 1;

  // Save a custom layout for lobby
  const customObstacles = [
    {
      id: 'custom-preservation-desk',
      type: 'desk',
      x: 300,
      y: 300,
      w: 80,
      h: 50,
      blocksAudio: true,
      attenuation: 0.5,
    },
  ];

  const saved = await saveLayout('lobby', {
    expectedRevision: initialRevision,
    obstacles: customObstacles,
  });
  assert.equal(saved.layoutRevision, initialRevision + 1);

  // Run seed a second time!
  await seedRooms();

  // Invalidate in-memory cache to ensure read hits DB
  invalidateRoomCache('lobby');
  const reloadedLobby = await getRoom('lobby');

  assert.equal(
    reloadedLobby.layoutRevision,
    saved.layoutRevision,
    'Custom layoutRevision must be preserved across seed',
  );
  assert.equal(reloadedLobby.obstacles.length, 1);
  assert.equal(
    reloadedLobby.obstacles[0].id,
    'custom-preservation-desk',
    'Custom obstacles must not be overwritten by seed',
  );
});
