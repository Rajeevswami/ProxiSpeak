/**
 * Day 3 integration tests — a real Socket.io server, real `socket.io-client`
 * clients and a real, isolated MongoDB database.
 *
 * Isolation rules (so nothing here can ever touch production data):
 *  - every run connects to its own database: `proxispeak_day3_test_<pid>_<ts>`,
 *    derived from MONGO_URI_TEST (falling back to MONGO_URI) with the database
 *    name replaced; the database is dropped when the suite finishes;
 *  - every test creates its own room with a random id and cleans up its
 *    documents afterwards;
 *  - when no MongoDB is reachable the tests are reported as skipped with an
 *    explicit NOT VERIFIED banner instead of pretending to pass.
 *
 *   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test
 */
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { io as createClient } from 'socket.io-client';

import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createGeoTransform } from '../src/utils/geo.js';
import { createApp } from '../src/app.js';
import { createSocketServer } from '../src/sockets/index.js';
import { connectMongo, disconnectMongo, ensureIndexes, mongoose as db, redactUri } from '../src/db/mongo.js';
import UserPresence from '../src/models/UserPresence.js';
import Room from '../src/models/Room.js';
import { buildDefaultRoom, persistRoom, invalidateRoomCache } from '../src/services/roomService.js';

const log = createLogger(process.env.LOG_LEVEL ?? 'error');

// --------------------------------------------------------------- test database

/** Replace the database name of a connection string, keeping host/options. */
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
const TEST_DB = `proxispeak_day3_test_${process.pid}_${Date.now().toString(36)}`;
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
        ' Day 3 socket integration tests: NOT VERIFIED\n' +
        ` No MongoDB reachable at ${redactUri(TEST_URI)}\n` +
        ' Start one, or point MONGO_URI_TEST at a test database, then re-run:\n' +
        '   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test\n' +
        '=====================================================================\n',
    );
  }
});

after(async () => {
  if (!mongoReady) return;
  // The whole database belongs to this test run: dropping it cannot reach
  // anyone else's data.
  await db.connection.dropDatabase();
  await disconnectMongo();
});

/** Skip instead of silently passing when the database is not reachable. */
function requireMongo(t) {
  if (mongoReady) return true;
  t.skip(`NOT VERIFIED — no MongoDB at ${redactUri(TEST_URI)} (${mongoError?.message ?? 'unknown error'})`);
  return false;
}

// ------------------------------------------------------------------- fixtures

const createdRoomIds = new Set();

/** A room of its own per test, with a random id, persisted to the test database. */
async function createRoom(label) {
  const roomId = `day3-${label}-${Math.random().toString(36).slice(2, 8)}`;
  await persistRoom({ ...buildDefaultRoom(roomId), name: `Test ${label}` });
  createdRoomIds.add(roomId);
  return roomId;
}

afterEach(async () => {
  if (!mongoReady || createdRoomIds.size === 0) return;
  const rooms = [...createdRoomIds];
  await UserPresence.deleteMany({ roomId: { $in: rooms } });
  await Room.deleteMany({ roomId: { $in: rooms } });
  for (const roomId of rooms) invalidateRoomCache(roomId);
  createdRoomIds.clear();
});

// --------------------------------------------------------------- server & clients

/** Real HTTP server + real Express app + real Socket.io, on an ephemeral port. */
async function withServer(run, cfg = config) {
  const server = http.createServer();
  server.on('request', createApp({ config: cfg, logger: log }));
  const io = createSocketServer({ httpServer: server, config: cfg, logger: log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  const clients = [];
  /** A brand new client socket, tracked so the teardown closes it. */
  const client = () => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    return socket;
  };

  try {
    await run({ url, client });
  } finally {
    for (const socket of clients) socket.close();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitFor(socket, event, predicate = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const connect = async (socket) => {
  if (socket.connected) return socket;
  await once(socket, 'connect');
  return socket;
};

/** Join and resolve with the `joined` reply (listener attached before emitting). */
async function joinRoom(socket, { roomId, name }) {
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId, name });
  return joined;
}

/** First `error` event this socket will receive after the call. */
const nextError = (socket) => waitFor(socket, 'error');

/** Retry an assertion until it passes or the deadline expires. */
async function eventually(assertion, { timeout = 3000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===================================================================== tests ===

test('two clients can join the same room and both receive the room snapshot', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('join');
    const a = await connect(client());
    const b = await connect(client());

    // --- client A joins an empty room -------------------------------------
    const joinedA = await joinRoom(a, { roomId, name: 'Ada' });
    assert.equal(joinedA.selfId, a.id);
    assert.equal(joinedA.proximityRadiusPx, config.proximity.radiusPx);
    // Day 13: the snapshot also publishes the mesh limits so the client can
    // render "connected N / max" and know the hysteresis drop radius.
    assert.equal(joinedA.maxPeers, config.proximity.maxPeersPerUser);
    assert.equal(joinedA.peerDisconnectRadiusPx, config.proximity.peerDisconnectRadiusPx);
    assert.equal(joinedA.room.width, config.world.width);
    assert.equal(joinedA.room.height, config.world.height);
    assert.ok(joinedA.room.obstacles.length > 0, 'obstacles travel with the room data');
    assert.deepEqual(
      Object.keys(joinedA.room).sort(),
      ['height', 'name', 'obstacles', 'roomId', 'width'],
      'the room payload carries dimensions + obstacles only',
    );
    assert.equal(joinedA.users.length, 1, 'the joiner is part of the room snapshot');
    assert.equal(joinedA.users[0].id, a.id);

    // Nothing database-shaped or secret may reach a browser.
    const wire = JSON.stringify(joinedA);
    for (const leak of ['_id', 'sessionId', 'instanceId', 'location', 'coordinates', 'mongodb', 'MONGO_URI', '$__']) {
      assert.equal(wire.includes(leak), false, `payload leaked "${leak}"`);
    }

    // --- client B joins the same room, A is told about it ------------------
    const announcedToA = waitFor(a, 'user:joined', (p) => p.id === b.id);
    const joinedB = await joinRoom(b, { roomId, name: 'Bob' });
    assert.equal(joinedB.users.length, 2);
    assert.deepEqual(
      joinedB.users.map((u) => u.id).sort(),
      [a.id, b.id].sort(),
      'the snapshot lists every user in the room, the newcomer included',
    );
    for (const user of joinedB.users) {
      assert.equal(typeof user.id, 'string');
      assert.ok(Number.isFinite(user.x) && Number.isFinite(user.y));
    }

    const announcement = await announcedToA;
    assert.equal(announcement.name, 'Bob');
    assert.ok(Number.isFinite(announcement.x) && Number.isFinite(announcement.y));

    // --- presence documents really are in MongoDB --------------------------
    assert.equal(await UserPresence.countDocuments({ roomId }), 2);
    const docs = await UserPresence.find({ roomId }).lean();
    assert.deepEqual(docs.map((d) => d.sessionId).sort(), [a.id, b.id].sort());
    assert.equal(docs.every((d) => d.roomId === roomId), true);
  });
});

test('joined snapshot carries the names of users already in the room', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('joined-names');
    const a = await connect(client());
    const b = await connect(client());

    await joinRoom(a, { roomId, name: 'Ada' });
    const joinedB = await joinRoom(b, { roomId, name: 'Bob' });

    const ada = joinedB.users.find((u) => u.id === a.id);
    assert.ok(ada, 'B snapshot includes A');
    assert.equal(ada.name, 'Ada', 'B learns the name of the user already in the room');
    assert.ok(Number.isFinite(ada.x) && Number.isFinite(ada.y));
    assert.deepEqual(
      Object.keys(ada).sort(),
      ['id', 'name', 'x', 'y'],
      'joined.users entries carry exactly id, name and position',
    );

    const bob = joinedB.users.find((u) => u.id === b.id);
    assert.equal(bob?.name, 'Bob', 'the newcomer is named in its own snapshot too');
  });
});

test('a move is broadcast to the room with the mover id and its coordinates', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('move');
    const a = await connect(client());
    const b = await connect(client());
    const joinedA = await joinRoom(a, { roomId, name: 'Ada' });
    await joinRoom(b, { roomId, name: 'Bob' });

    const self = joinedA.users.find((u) => u.id === a.id);
    // A short legal step: well inside the room and under the step cap.
    const target = { x: self.x + 40, y: self.y + 20 };

    let echoedToMover = 0;
    a.on('user:moved', () => (echoedToMover += 1));

    const heardByB = waitFor(b, 'user:moved', (p) => p.id === a.id);
    a.emit('move', target);
    const moved = await heardByB;
    assert.deepEqual(moved, { id: a.id, x: target.x, y: target.y });

    // The accepted position is persisted, GeoJSON point included.
    const doc = await UserPresence.findOne({ sessionId: a.id, roomId }).lean();
    assert.equal(doc.x, target.x);
    assert.equal(doc.y, target.y);
    assert.equal(doc.location.type, 'Point');
    const geo = createGeoTransform(config.world);
    const back = geo.geoToPixel(doc.location.coordinates);
    assert.ok(Math.abs(back.x - target.x) < 0.01 && Math.abs(back.y - target.y) < 0.01, 'pixels and GeoJSON agree');

    await sleep(150);
    assert.equal(echoedToMover, 0, 'the mover never receives its own user:moved');
  });
});

test('room-scoped events never reach a client in another room', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomA = await createRoom('iso-a');
    const roomB = await createRoom('iso-b');
    const a = await connect(client());
    const b = await connect(client());
    const outsider = await connect(client());

    const seen = [];
    for (const event of ['user:joined', 'user:moved', 'user:left']) {
      outsider.on(event, (payload) => seen.push({ event, payload }));
    }

    await joinRoom(a, { roomId: roomA, name: 'Ada' });
    await joinRoom(b, { roomId: roomA, name: 'Bob' });
    const joinedOutsider = await joinRoom(outsider, { roomId: roomB, name: 'Cleo' });
    assert.equal(joinedOutsider.users.length, 1, 'the other room is empty from Cleo\'s point of view');

    // Movement and a disconnect in room A. `socket.id` is cleared the moment a
    // client closes, so the identity is captured while it is still there.
    const aId = a.id;
    const heardByB = waitFor(b, 'user:moved', (p) => p.id === aId);
    const start = joinedOutsider.users[0];
    a.emit('move', { x: start.x + 10, y: start.y });
    assert.equal((await heardByB).id, aId);

    const leftInA = waitFor(b, 'user:left', (p) => p.id === aId);
    a.close();
    assert.equal((await leftInA).id, aId);

    await sleep(250);
    assert.deepEqual(seen, [], `an unrelated room received ${JSON.stringify(seen)}`);
    assert.equal(await UserPresence.countDocuments({ roomId: roomB }), 1, 'the outsider is untouched');
  });
});

test('disconnect removes the presence document and announces user:left', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('leave');
    const a = await connect(client());
    const b = await connect(client());
    await joinRoom(a, { roomId, name: 'Ada' });
    await joinRoom(b, { roomId, name: 'Bob' });
    assert.equal(await UserPresence.countDocuments({ roomId }), 2);

    // A client clears its own id on close, so capture both identities up front.
    const aId = a.id;
    const bId = b.id;
    const left = waitFor(b, 'user:left', (p) => p.id === aId);
    a.close();
    assert.equal((await left).id, aId);

    await eventually(async () => {
      assert.equal(await UserPresence.countDocuments({ sessionId: aId }), 0, 'A\'s presence document is gone');
    });
    assert.equal(await UserPresence.countDocuments({ roomId }), 1, 'B keeps its own presence');
    assert.equal(await UserPresence.countDocuments({ sessionId: bId, roomId }), 1);
  });
});

test('a reconnect gets a fresh presence and only cleans up its own', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('reconnect');
    const first = await connect(client());
    const firstJoined = await joinRoom(first, { roomId, name: 'Dana' });

    const second = await connect(client());
    const secondJoined = await joinRoom(second, { roomId, name: 'Dana' });
    assert.notEqual(secondJoined.selfId, firstJoined.selfId, 'a reconnect is a brand new socket');
    assert.equal(await UserPresence.countDocuments({ roomId }), 2);

    first.close(); // the tab that lost its connection
    await eventually(async () => {
      assert.equal(await UserPresence.countDocuments({ sessionId: firstJoined.selfId }), 0);
    });
    assert.equal(await UserPresence.countDocuments({ sessionId: secondJoined.selfId, roomId }), 1, 'the live socket keeps its presence');
    assert.equal(await UserPresence.countDocuments({ roomId }), 1);
  });
});

test('invalid join and move payloads are rejected safely', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('invalid');
    const socket = await connect(client());
    const accepted = await joinRoom(socket, { roomId, name: 'Ada' });
    const { x, y } = accepted.users.find((u) => u.id === socket.id);

    // --- malformed joins ---------------------------------------------------
    const badJoins = [
      [{ roomId: 42, name: 'Ada' }, 'roomId'],
      [{ roomId, name: '   ' }, 'name'],
      [{ roomId, name: 'x'.repeat(40) }, 'name'],
      [{ roomId: `${roomId}!!`, name: 'Ada' }, 'roomId'],
      ['not-an-object', 'roomId'],
      [null, 'roomId'],
      [[1, 2, 3], 'roomId'],
    ];
    for (const [payload, field] of badJoins) {
      const error = nextError(socket);
      socket.emit('join', payload);
      const rejection = await error;
      assert.equal(rejection.code, 'invalid_payload', `payload ${JSON.stringify(payload)}`);
      assert.equal(rejection.field, field);
    }

    // A room that does not exist is refused, not invented. A socket is bound to
    // one room, so this needs a client that has not joined anything yet.
    const stranger = await connect(client());
    const missing = nextError(stranger);
    stranger.emit('join', { roomId: 'day3-does-not-exist', name: 'Ada' });
    assert.equal((await missing).code, 'room_not_found');
    stranger.close();

    // --- malformed moves ---------------------------------------------------
    for (const payload of [
      { x: 'left', y: 10 },
      { x: Number.NaN, y: 10 },
      { x: Number.POSITIVE_INFINITY, y: 10 },
      { x: 10, y: null },
      { x: 10 },
      { x: 1e12, y: 0 },
      'nope',
      null,
      [10, 20],
      {},
    ]) {
      const error = nextError(socket);
      socket.emit('move', payload);
      const rejection = await error;
      assert.equal(rejection.code, 'invalid_payload', `payload ${JSON.stringify(payload)}`);
    }

    // --- the server survived all of that -----------------------------------
    assert.equal(await UserPresence.countDocuments({ roomId }), 1, 'no document was created by a rejected join');
    const doc = await UserPresence.findOne({ sessionId: socket.id, roomId }).lean();
    assert.equal(doc.x, x, 'no rejected move reached the database');
    assert.equal(doc.y, y);

    const stillWorks = waitFor(socket, 'joined', () => true);
    socket.emit('join', { roomId, name: 'Ada' });
    await stillWorks;
    assert.equal(socket.connected, true, 'the socket is still usable after malformed input');
  });
});

test('a move before joining is rejected', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('not-joined');
    const socket = await connect(client());

    const error = nextError(socket);
    socket.emit('move', { x: 100, y: 100 });
    const rejection = await error;
    assert.equal(rejection.code, 'not_joined');

    assert.equal(await UserPresence.countDocuments({ roomId }), 0, 'no presence without a join');
    // ...and the socket can still join afterwards.
    const joined = await joinRoom(socket, { roomId, name: 'Ada' });
    assert.equal(joined.selfId, socket.id);
  });
});

test('duplicate join attempts create no second document and no second broadcast', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('duplicate');
    const a = await connect(client());
    const b = await connect(client());
    await joinRoom(a, { roomId, name: 'Ada' });
    await joinRoom(b, { roomId, name: 'Bob' });

    let announcementsSeenByB = 0;
    b.on('user:joined', () => (announcementsSeenByB += 1));

    const rejoined = await joinRoom(a, { roomId, name: 'Ada' });
    assert.equal(rejoined.selfId, a.id);
    assert.equal(rejoined.users.length, 2, 'the snapshot is still served');

    await sleep(250);
    assert.equal(announcementsSeenByB, 0, 'a duplicate join is not re-announced');
    assert.equal(await UserPresence.countDocuments({ sessionId: a.id, roomId }), 1, 'exactly one document per socket');
    assert.equal(await UserPresence.countDocuments({ roomId }), 2);

    // A socket is bound to one room: a second room is refused, so no presence
    // document can be orphaned in a room the socket does not belong to.
    const other = await createRoom('duplicate-other');
    const error = nextError(a);
    a.emit('join', { roomId: other, name: 'Ada' });
    assert.equal((await error).code, 'already_joined');
    assert.equal(await UserPresence.countDocuments({ roomId: other }), 0);
  });
});

test('rate limiting and the maximum step per move are enforced', async (t) => {
  if (!requireMongo(t)) return;

  // --- the configured step cap, with the production defaults --------------
  await withServer(async ({ client }) => {
    const roomId = await createRoom('step');
    const a = await connect(client());
    const b = await connect(client());
    const joinedA = await joinRoom(a, { roomId, name: 'Ada' });
    await joinRoom(b, { roomId, name: 'Bob' });

    const self = joinedA.users.find((u) => u.id === a.id);
    const heardByB = waitFor(b, 'user:moved', (p) => p.id === a.id);
    a.emit('move', { x: self.x + 1000, y: self.y + 800 });
    const moved = await heardByB;

    const travelled = Math.hypot(moved.x - self.x, moved.y - self.y);
    assert.ok(
      travelled <= config.socket.maxStepPx + 0.5,
      `a single move travelled ${travelled.toFixed(2)}px (cap ${config.socket.maxStepPx}px)`,
    );
    assert.ok(travelled > 0, 'the move still happened');

    // Out-of-bounds coordinates are pulled back into the room.
    const bounded = waitFor(b, 'user:moved', (p) => p.id === a.id);
    a.emit('move', { x: self.x + 1000, y: -5000 });
    const clamped = await bounded;
    assert.ok(clamped.x >= 0 && clamped.x <= config.world.width);
    assert.ok(clamped.y >= 0 && clamped.y <= config.world.height);
  });

  // --- a deliberately tiny bucket, so the limit is observable -------------
  const tinyBucket = { ...config, socket: { ...config.socket, moveEventsPerSec: 3 } };
  await withServer(async ({ client }) => {
    const roomId = await createRoom('ratelimit');
    const a = await connect(client());
    const b = await connect(client());
    const joinedA = await joinRoom(a, { roomId, name: 'Ada' });
    await joinRoom(b, { roomId, name: 'Bob' });

    const accepted = [];
    b.on('user:moved', (payload) => {
      if (payload.id === a.id) accepted.push(payload);
    });

    const sent = 40;
    const { x: startX, y: startY } = joinedA.users.find((u) => u.id === a.id);
    for (let i = 0; i < sent; i += 1) {
      a.emit('move', { x: startX + 10 * (i + 1), y: startY });
    }

    await eventually(async () => assert.ok(accepted.length >= 1, 'at least one move must be accepted'));
    await sleep(300); // let any (refill-allowed) extra broadcast arrive

    assert.ok(accepted.length < sent, `${accepted.length} of ${sent} moves survived the rate limit`);
    assert.ok(accepted.length <= 6, `a 3 events/s bucket let ${accepted.length} moves through`);

    // Persistence and the broadcast agree: the last accepted move is what is
    // stored, and the dropped events changed nothing.
    const doc = await UserPresence.findOne({ sessionId: a.id, roomId }).lean();
    const last = accepted[accepted.length - 1];
    assert.equal(doc.x, last.x);
    assert.equal(doc.y, last.y);
    assert.ok(doc.x - startX <= config.socket.maxStepPx * accepted.length, 'each accepted move respects the step cap');

    // A flooding client is throttled, never disconnected: after the bucket
    // refills the same socket is still fully functional.
    await sleep(700);
    const recovered = waitFor(b, 'user:moved', (p) => p.id === a.id);
    a.emit('move', { x: doc.x + 10, y: doc.y });
    assert.equal((await recovered).x, doc.x + 10);
  }, tinyBucket);
});

test('Day 2 geospatial behaviour is intact: 2dsphere index and GeoJSON points', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client }) => {
    const roomId = await createRoom('geo');
    const a = await connect(client());
    await joinRoom(a, { roomId, name: 'Ada' });

    const indexes = await UserPresence.collection.indexes();
    assert.ok(
      indexes.some((index) => index.key?.location === '2dsphere'),
      `expected a 2dsphere index, got ${JSON.stringify(indexes.map((i) => i.key))}`,
    );

    const doc = await UserPresence.findOne({ sessionId: a.id, roomId }).lean();
    assert.equal(doc.location.type, 'Point');
    assert.equal(doc.location.coordinates.length, 2);
    assert.equal(typeof doc.lastSeen.getTime, 'function');
  });
});

test('/health still answers on the same port as the websocket', async () => {
  // No database needed: this is the Day 1/2 HTTP surface, unchanged.
  await withServer(async ({ url, client }) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'proxispeak');

    // ...and the same origin really does serve the websocket.
    const socket = await connect(client());
    assert.ok(socket.id, 'the socket connected over the shared HTTP server');
  });
});

test('the handshake advertises no wildcard CORS grant when CLIENT_URL is unset', async () => {
  await withServer(async ({ url }) => {
    const crossOrigin = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'https://not-our-client.example' },
    });
    assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);
    assert.equal(crossOrigin.headers.get('access-control-allow-credentials'), null);
  });
});
