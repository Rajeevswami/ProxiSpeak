/**
 * Week 2, Day 8 integration tests — peer graph + WebRTC signaling.
 *
 * A real Socket.io server, real `socket.io-client` sockets and a real,
 * isolated MongoDB database. The Day 7 `$near` query is the only neighbor
 * source; nothing is mocked here.
 *
 *   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test
 *
 * When no MongoDB is reachable every test is explicitly skipped with a NOT
 * VERIFIED banner (as the other integration suites do), so a green run with
 * `skipped 0` is the only complete verification.
 */
import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io as createClient } from 'socket.io-client';

import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createApp } from '../src/app.js';
import { createSocketServer } from '../src/sockets/index.js';
import { connectMongo, disconnectMongo, ensureIndexes, mongoose as db, redactUri } from '../src/db/mongo.js';
import UserPresence from '../src/models/UserPresence.js';
import Room from '../src/models/Room.js';
import { buildDefaultRoom, persistRoom, invalidateRoomCache } from '../src/services/roomService.js';
import { cleanupStale } from '../src/services/presenceCleanup.js';

const log = createLogger(process.env.LOG_LEVEL ?? 'error');

// --------------------------------------------------------------- test database

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
const TEST_DB = `proxispeak_day8_test_${process.pid}_${Date.now().toString(36)}`;
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
        ' Day 8 peer graph / signaling tests: NOT VERIFIED\n' +
        ` No MongoDB reachable at ${redactUri(TEST_URI)}\n` +
        ' Start one, or point MONGO_URI_TEST at a test database, then re-run:\n' +
        '   MONGO_URI_TEST="mongodb://127.0.0.1:27017/proxispeak" npm test\n' +
        '=====================================================================\n',
    );
  }
});

after(async () => {
  if (!mongoReady) return;
  await db.connection.dropDatabase();
  await disconnectMongo();
});

function requireMongo(t) {
  if (mongoReady) return true;
  t.skip(`NOT VERIFIED — no MongoDB at ${redactUri(TEST_URI)} (${mongoError?.message ?? 'unknown error'})`);
  return false;
}

// ------------------------------------------------------------------- fixtures

const createdRoomIds = new Set();

async function createRoom(label) {
  const roomId = `day8-${label}-${Math.random().toString(36).slice(2, 8)}`;
  await persistRoom({ ...buildDefaultRoom(roomId), name: `Day 8 ${label}` });
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

/** Test config: teleport-friendly moves and a wide signaling bucket. */
const TEST_CONFIG = Object.freeze({
  ...config,
  socket: {
    ...config.socket,
    maxStepPx: 100000,
    moveEventsPerSec: 500,
    signalEventsPerSec: 500,
    signalBurst: 1000,
  },
});

// --------------------------------------------------------------- server & clients

async function withServer(run, cfg = TEST_CONFIG) {
  const server = http.createServer();
  server.on('request', createApp({ config: cfg, logger: log }));
  const io = createSocketServer({ httpServer: server, config: cfg, logger: log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  const clients = [];
  const client = () => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    return socket;
  };

  try {
    await run({ url, client, io });
  } finally {
    for (const socket of clients) socket.close();
    await new Promise((resolve) => io.close(resolve));
    await io.drainSessions();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitFor(socket, event, predicate = () => true, timeout = 5000) {
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

/** Retry an assertion until it passes or the deadline expires. */
async function eventually(assertion, { timeout = 8000, interval = 25 } = {}) {
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

/** Collects every peer:connect / peer:disconnect a socket receives. */
function trackPeers(socket) {
  const events = { connects: [], disconnects: [] };
  socket.on('peer:connect', (payload) => events.connects.push(payload));
  socket.on('peer:disconnect', (payload) => events.disconnects.push(payload));
  return events;
}

const nextError = (socket) => waitFor(socket, 'error');

/**
 * Connect, start collecting peer events, join and return the joined snapshot.
 * The peer events have to be collected from before the join: a spawn can be
 * in range when many users share the room.
 */
async function joinAs(client, roomId, name) {
  const socket = await connect(client());
  const events = trackPeers(socket);
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId, name });
  const snapshot = await joined;
  return { socket, events, joined: snapshot, id: socket.id };
}

/**
 * Move to an absolute pixel position. The other room member observes
 * `user:moved`, which the gateway emits only after the accepted move has been
 * persisted and the peer graph has re-synced this user — so awaiting it is a
 * deterministic barrier for connectivity assertions.
 */
async function moveTo(mover, observer, x, y) {
  const id = mover.id;
  const moved = waitFor(observer.socket, 'user:moved', (payload) => payload.id === id);
  mover.socket.emit('move', { x, y });
  const payload = await moved;
  assert.equal(payload.x, x);
  assert.equal(payload.y, y);
  return payload;
}

async function expectSignalError(socket, payload, code, field) {
  const rejected = nextError(socket);
  socket.emit('signal', payload);
  const error = await rejected;
  assert.equal(error.code, code, `payload ${JSON.stringify(payload)?.slice(0, 120)}`);
  if (field) assert.equal(error.field, field);
  return error;
}

const edgeKeyOf = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// ===================================================================== tests ===

test('two users within 100 px each receive exactly one peer:connect and one is the initiator', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('pair');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    assert.deepEqual(a.joined.iceServers, config.iceServers, 'joined carries the ICE server list');

    // A duplicate join re-serves the snapshot (not a new edge) and must keep
    // the ICE list in that snapshot too.
    const duplicate = waitFor(a.socket, 'joined');
    a.socket.emit('join', { roomId, name: 'Ada' });
    assert.deepEqual((await duplicate).iceServers, config.iceServers);

    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 490, 400); // 90 px from Ada

    await eventually(() => {
      assert.equal(a.events.connects.length, 1);
      assert.equal(b.events.connects.length, 1);
    });
    const toA = a.events.connects[0];
    const toB = b.events.connects[0];

    assert.equal(toA.peerId, b.id);
    assert.equal(toB.peerId, a.id);
    assert.equal(toA.name, 'Bob');
    assert.equal(toB.name, 'Ada');
    assert.equal(toA.generation, toB.generation, 'both halves of one edge share a generation');
    assert.equal(toA.iceServers[0].urls, 'stun:stun.l.google.com:19302');
    assert.deepEqual(
      [toA.initiator, toB.initiator].sort(),
      [false, true],
      'exactly one side is the offerer',
    );
    assert.equal(toA.initiator, a.id < b.id, 'the lexicographically smaller id initiates');
    assert.equal(toB.initiator, b.id < a.id);

    await sleep(200);
    assert.equal(a.events.connects.length, 1, 'no duplicate connect for an unchanged edge');
    assert.equal(b.events.connects.length, 1);
    assert.equal(io.peerGraph.stats(roomId).edges, 1);
  });
});

test('a far user gets nothing; moving in and out emits one connect/disconnect and no duplicates', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('moves');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    const c = await joinAs(client, roomId, 'Cleo');

    await moveTo(a, b, 100, 100);
    await moveTo(b, a, 180, 100); // A-B = 80 px
    await eventually(() => assert.equal(a.events.connects.length, 1));
    await eventually(() => assert.equal(b.events.connects.length, 1));

    assert.equal(c.events.connects.length, 0, 'a far user receives no connect events');

    // Cleo moves next to Bob: 80 px from Bob, 160 px from Ada.
    await moveTo(c, b, 260, 100);
    await eventually(() => {
      assert.equal(b.events.connects.length, 2);
      assert.equal(c.events.connects.length, 1);
    });
    assert.equal(b.events.connects[1].peerId, c.id);
    assert.equal(c.events.connects[0].peerId, b.id);
    assert.equal(a.events.connects.some((event) => event.peerId === c.id), false);
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, c.id), false);

    // Still inside Bob's radius: no new edge, therefore no second connect.
    await moveTo(c, b, 270, 100);
    await sleep(200);
    assert.equal(b.events.connects.length, 2, 'moving within range must not duplicate the edge');
    assert.equal(c.events.connects.length, 1);
    assert.equal(io.peerGraph.stats(roomId).edges, 2);

    // Out of range: both sides get exactly one peer:disconnect.
    const cGeneration = c.events.connects[0].generation;
    await moveTo(c, b, 1500, 900);
    await eventually(() => {
      assert.equal(b.events.disconnects.length, 1);
      assert.equal(c.events.disconnects.length, 1);
    });
    assert.deepEqual(b.events.disconnects[0], { peerId: c.id, generation: cGeneration });
    assert.deepEqual(c.events.disconnects[0], { peerId: b.id, generation: cGeneration });
    await sleep(200);
    assert.equal(b.events.disconnects.length, 1);
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), true);
    assert.equal(io.peerGraph.hasEdge(roomId, b.id, c.id), false);
  });
});

test('boundary: 99 and 100 px stay connected, 101 px disconnects', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('boundary');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    await moveTo(a, b, 500, 500);
    await moveTo(b, a, 1500, 500); // far away, no edge

    await moveTo(b, a, 599, 500); // 99 px
    await eventually(() => assert.equal(a.events.connects.length, 1));
    assert.equal(a.events.connects[0].peerId, b.id);
    const connectGeneration = a.events.connects[0].generation;
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), true);

    await moveTo(b, a, 600, 500); // exactly 100 px: still inside
    await sleep(200);
    assert.equal(a.events.connects.length, 1, '100 px does not create a second edge');
    assert.equal(a.events.disconnects.length, 0, '100 px must not disconnect');
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), true);

    await moveTo(b, a, 601, 500); // 101 px: outside
    await eventually(() => {
      assert.equal(a.events.disconnects.length, 1);
      assert.equal(b.events.disconnects.length, 1);
    });
    assert.equal(a.events.disconnects[0].generation, connectGeneration);
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), false);
  });
});

test('signaling relays offers, answers and candidates only along a live edge', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('signal');
    const otherRoomId = await createRoom('signal-other');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    const far = await joinAs(client, roomId, 'Far');
    const outsider = await joinAs(client, otherRoomId, 'Out');

    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 460, 400); // 60 px apart
    await eventually(() => {
      assert.equal(a.events.connects.length, 1);
      assert.equal(b.events.connects.length, 1);
    });

    const initiator = a.id < b.id ? a : b;
    const responder = initiator === a ? b : a;
    const generation = a.events.connects[0].generation;
    assert.equal(generation, b.events.connects[0].generation);

    const inbox = [];
    responder.socket.on('signal', (payload) => inbox.push(payload));
    const initiatorInbox = [];
    initiator.socket.on('signal', (payload) => initiatorInbox.push(payload));

    // --- offer -> answer ----------------------------------------------------
    const offer = { type: 'offer', sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' };
    const offerSeen = waitFor(responder.socket, 'signal', (payload) => payload.from === initiator.id);
    initiator.socket.emit('signal', { to: responder.id, generation, data: offer });
    assert.deepEqual(await offerSeen, { from: initiator.id, generation, data: offer });

    const answer = { type: 'answer', sdp: 'v=0\r\no=- 7612345678901234567 2 IN IP4 127.0.0.1\r\n' };
    const answerSeen = waitFor(initiator.socket, 'signal', (payload) => payload.from === responder.id);
    responder.socket.emit('signal', { to: initiator.id, generation, data: answer });
    assert.deepEqual(await answerSeen, { from: responder.id, generation, data: answer });

    // --- trickled candidates ------------------------------------------------
    const candidate = {
      candidate: 'candidate:842163049 1 udp 1677729535 192.0.2.1 54400 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const candidateSeen = waitFor(initiator.socket, 'signal', (payload) => payload.data.type === 'candidate');
    responder.socket.emit('signal', { to: initiator.id, generation, data: { type: 'candidate', candidate } });
    assert.deepEqual(await candidateSeen, {
      from: responder.id,
      generation,
      data: { type: 'candidate', candidate },
    });

    const rawCandidate = 'candidate:1 2 udp 1 192.0.2.2 50000 typ host';
    const rawSeen = waitFor(responder.socket, 'signal', (payload) => payload.data.type === 'candidate');
    initiator.socket.emit('signal', {
      to: responder.id, generation, data: { type: 'candidate', candidate: rawCandidate },
    });
    assert.deepEqual(await rawSeen, {
      from: initiator.id,
      generation,
      data: { type: 'candidate', candidate: rawCandidate },
    });

    const deliveredBefore = inbox.length;

    // --- refused: a joined user with no edge (same room) --------------------
    await expectSignalError(
      initiator.socket,
      { to: far.id, generation, data: offer },
      'no_peer_edge',
      'to',
    );
    // --- refused: a user in another room ------------------------------------
    await expectSignalError(
      initiator.socket,
      { to: outsider.id, generation, data: offer },
      'no_peer_edge',
      'to',
    );
    // --- refused: a stale or fabricated generation --------------------------
    await expectSignalError(
      initiator.socket,
      { to: responder.id, generation: generation - 1, data: offer },
      'stale_generation',
      'generation',
    );
    await expectSignalError(
      initiator.socket,
      { to: responder.id, generation: generation + 1, data: offer },
      'stale_generation',
      'generation',
    );
    // --- refused: a signal to itself ----------------------------------------
    await expectSignalError(
      initiator.socket,
      { to: initiator.id, generation, data: offer },
      'no_peer_edge',
      'to',
    );

    // --- malformed and oversized envelopes ----------------------------------
    const malformed = [
      null,
      'not-an-object',
      {},
      { to: 42, generation, data: offer },
      { to: `${responder.id}!`, generation, data: offer },
      { to: responder.id, generation: String(generation), data: offer },
      { to: responder.id, generation: generation + 0.5, data: offer },
      { to: responder.id, generation: -1, data: offer },
      { to: responder.id, generation, data: null },
      { to: responder.id, generation, data: [] },
      { to: responder.id, generation, data: { type: 'bogus', sdp: 'x' } },
      { to: responder.id, generation, data: { type: 'offer', sdp: 42 } },
      { to: responder.id, generation, data: { type: 'answer', sdp: '' } },
      { to: responder.id, generation, data: { type: 'candidate', candidate: { sdpMid: '0' } } },
      { to: responder.id, generation, data: { type: 'offer', sdp: 'x'.repeat(17 * 1024) } },
      { to: responder.id, generation, data: { type: 'candidate', candidate: 'y'.repeat(17 * 1024) } },
    ];
    for (const payload of malformed) {
      await expectSignalError(initiator.socket, payload, 'invalid_payload');
    }

    // Nothing refused above reached the responder.
    await sleep(200);
    assert.equal(inbox.length, deliveredBefore, 'refused signals are never relayed');

    // --- a signal before join ----------------------------------------------
    const stranger = await connect(client());
    await expectSignalError(
      stranger,
      { to: responder.id, generation, data: offer },
      'not_joined',
    );

    // --- the gateway survived all of it and still relays --------------------
    const finalSeen = waitFor(responder.socket, 'signal', (payload) => payload.data.sdp === 'v=0 final');
    initiator.socket.emit('signal', {
      to: responder.id, generation, data: { type: 'offer', sdp: 'v=0 final' },
    });
    assert.equal((await finalSeen).from, initiator.id);
    assert.equal(initiator.socket.connected, true);
    assert.equal(responder.socket.connected, true);
  });
});

test('a signal for an edge that was removed and re-created is rejected as stale', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('regeneration');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 450, 400);
    await eventually(() => assert.equal(a.events.connects.length, 1));
    const firstGeneration = a.events.connects[0].generation;

    // Leave the radius and come back: the edge is removed, then re-created
    // with a strictly larger generation.
    await moveTo(b, a, 1200, 400);
    await eventually(() => assert.equal(a.events.disconnects.length, 1));
    await moveTo(b, a, 450, 400);
    await eventually(() => assert.equal(a.events.connects.length, 2));
    const secondGeneration = a.events.connects[1].generation;
    assert.ok(secondGeneration > firstGeneration, 'generations are monotonic');

    const delivery = [];
    a.socket.on('signal', (payload) => delivery.push(payload));
    await expectSignalError(
      b.socket,
      { to: a.id, generation: firstGeneration, data: { type: 'offer', sdp: 'stale' } },
      'stale_generation',
      'generation',
    );
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), true);
    assert.equal(io.peerGraph.edgeBetween(roomId, a.id, b.id).generation, secondGeneration);

    // The current generation still relays.
    const current = waitFor(a.socket, 'signal', (payload) => payload.data.sdp === 'current');
    b.socket.emit('signal', {
      to: a.id, generation: secondGeneration, data: { type: 'offer', sdp: 'current' },
    });
    assert.equal((await current).from, b.id);
    assert.equal(delivery.length, 1, 'only the current-generation signal arrived');
  });
});

test('signals are rate limited per socket but the socket stays usable', async (t) => {
  if (!requireMongo(t)) return;
  const limitedConfig = Object.freeze({
    ...TEST_CONFIG,
    socket: { ...TEST_CONFIG.socket, signalEventsPerSec: 2, signalBurst: 2 },
  });
  await withServer(async ({ client }) => {
    const roomId = await createRoom('signal-limit');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 450, 400);
    await eventually(() => assert.equal(a.events.connects.length, 1));
    const generation = a.events.connects[0].generation;

    let received = 0;
    b.socket.on('signal', () => { received += 1; });
    for (let i = 0; i < 25; i += 1) {
      a.socket.emit('signal', {
        to: b.id, generation, data: { type: 'candidate', candidate: `candidate:${i} 1 udp 1 192.0.2.1 5000${i} typ host` },
      });
    }
    await eventually(() => assert.ok(received >= 1, 'at least one signal must pass'));
    await sleep(300);
    assert.ok(received < 25, `the bucket let ${received} of 25 signals through`);
    assert.ok(received <= 4, `a 2/s bucket with a burst of 2 let ${received} signals through`);
    assert.equal(a.socket.connected, true, 'throttling does not disconnect the sender');

    // The bucket refills: the same socket can signal again.
    await sleep(1100);
    const recovered = waitFor(b.socket, 'signal', (payload) => payload.data.candidate?.startsWith('candidate:recovered'));
    a.socket.emit('signal', {
      to: b.id, generation, data: { type: 'candidate', candidate: 'candidate:recovered 1 udp 1 192.0.2.1 59999 typ host' },
    });
    assert.equal((await recovered).from, a.id);
  }, limitedConfig);
});

test('disconnect removes every edge of the user and notifies the remaining peers', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('disconnect');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    const c = await joinAs(client, roomId, 'Cleo');

    // A-B-C chain: 90 px per hop, A-C 180 px apart.
    await moveTo(a, b, 100, 100);
    await moveTo(b, a, 190, 100);
    await moveTo(c, b, 280, 100);
    await eventually(() => {
      assert.equal(a.events.connects.length, 1);
      assert.equal(b.events.connects.length, 2);
      assert.equal(c.events.connects.length, 1);
    });
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, b.id), true);
    assert.equal(io.peerGraph.hasEdge(roomId, b.id, c.id), true);
    assert.equal(io.peerGraph.hasEdge(roomId, a.id, c.id), false, 'A and C are beyond the radius');

    const bId = b.id;
    const generationToA = a.events.connects[0].generation;
    const generationToC = c.events.connects[0].generation;
    b.socket.close();

    await eventually(() => {
      assert.equal(a.events.disconnects.length, 1);
      assert.equal(c.events.disconnects.length, 1);
    });
    assert.deepEqual(a.events.disconnects[0], { peerId: bId, generation: generationToA });
    assert.deepEqual(c.events.disconnects[0], { peerId: bId, generation: generationToC });
    await sleep(200);
    assert.equal(a.events.disconnects.length, 1, 'no duplicate disconnect');
    assert.equal(c.events.disconnects.length, 1);
    assert.equal(io.peerGraph.stats(roomId).edges, 0);
    assert.equal(io.peerGraph.neighbors(roomId, a.id).length, 0);
    assert.equal(io.peerGraph.neighbors(roomId, c.id).length, 0);
    assert.equal(io.peerGraph.isRegistered(roomId, bId), false);
  });
});

test('presence expiry removes a user\'s edges and emits peer:disconnect to the survivors', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('expiry');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 470, 400);
    await eventually(() => {
      assert.equal(a.events.connects.length, 1);
      assert.equal(b.events.connects.length, 1);
    });
    const generation = b.events.connects[0].generation;
    assert.equal(a.events.connects[0].generation, generation);

    // Age only Ada's row; Bob's heartbeat stays fresh.
    await UserPresence.updateOne(
      { sessionId: a.id, roomId },
      { $set: { lastSeen: new Date(Date.now() - config.presence.timeoutMs - 5000) } },
    );
    await cleanupStale(io);

    await eventually(() => assert.equal(b.events.disconnects.length, 1));
    assert.deepEqual(b.events.disconnects[0], { peerId: a.id, generation });
    await eventually(async () => {
      assert.equal(await UserPresence.countDocuments({ sessionId: a.id }), 0);
    });
    assert.equal(io.peerGraph.isRegistered(roomId, a.id), false);
    assert.equal(io.peerGraph.stats(roomId).edges, 0);

    // The transport was closed with expiryAnnounced, so the disconnect cleanup
    // must not emit a second peer:disconnect for the same edge.
    await sleep(400);
    assert.equal(b.events.disconnects.length, 1);
    assert.equal(b.socket.connected, true);
  });
});

test('a killed client process leaves no edges behind', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, url, io }) => {
    const roomId = await createRoom('killed');
    const watcher = await joinAs(client, roomId, 'Watcher');
    const anchor = await joinAs(client, roomId, 'Anchor');
    await moveTo(watcher, anchor, 400, 400);

    const moduleUrl = new URL('../node_modules/socket.io-client/build/esm-debug/index.js', import.meta.url).href;
    const script = `import {io} from ${JSON.stringify(moduleUrl)};
      const socket=io(${JSON.stringify(url)}, {transports:['websocket'],reconnection:false});
      socket.on('connect',()=>socket.emit('join',{roomId:${JSON.stringify(roomId)},name:'Killed'}));
      socket.on('joined',()=>{
        const id=socket.id;
        socket.emit('move',{x:450,y:400});
        socket.on('user:moved',()=>{});
        setTimeout(()=>process.send({id}),200);
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
    const [{ id }] = await once(child, 'message');

    await eventually(() => {
      assert.equal(watcher.events.connects.filter((event) => event.peerId === id).length, 1);
    });
    assert.equal(io.peerGraph.hasEdge(roomId, watcher.id, id), true);
    const generation = watcher.events.connects.find((event) => event.peerId === id).generation;

    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;

    await eventually(() => {
      assert.equal(watcher.events.disconnects.filter((event) => event.peerId === id).length, 1);
    });
    assert.deepEqual(
      watcher.events.disconnects.find((event) => event.peerId === id),
      { peerId: id, generation },
    );
    await eventually(() => assert.equal(io.peerGraph.isRegistered(roomId, id), false));
    assert.equal(io.peerGraph.hasEdge(roomId, watcher.id, id), false);
    assert.equal(await UserPresence.countDocuments({ sessionId: id }), 0);
  });
});

test('a reconnect gets a new user id and fresh edges; the old id leaves no edges', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('reconnect');
    const a = await joinAs(client, roomId, 'Dana');
    const b = await joinAs(client, roomId, 'Bob');
    await moveTo(a, b, 400, 400);
    await moveTo(b, a, 460, 400);
    await eventually(() => assert.equal(a.events.connects.length, 1));
    const oldId = a.id;
    const firstGeneration = a.events.connects[0].generation;

    a.socket.close();
    await eventually(() => assert.equal(b.events.disconnects.length, 1));
    await eventually(() => assert.equal(io.peerGraph.isRegistered(roomId, oldId), false));

    // The tab reconnects: a brand new socket id, a brand new presence row.
    const fresh = await joinAs(client, roomId, 'Dana');
    assert.notEqual(fresh.id, oldId);
    assert.equal(io.peerGraph.isRegistered(roomId, oldId), false);
    assert.deepEqual(io.peerGraph.neighbors(roomId, fresh.id), [], 'no edge is inherited from the old id');

    await moveTo(fresh, b, 462, 400);
    await eventually(() => {
      assert.equal(b.events.connects.filter((event) => event.peerId === fresh.id).length, 1);
    });
    const reconnectEvent = b.events.connects.find((event) => event.peerId === fresh.id);
    assert.ok(reconnectEvent.generation > firstGeneration, 'fresh edge, fresh generation');
    assert.equal(b.events.connects.some((event) => event.peerId === oldId && event.generation > firstGeneration), false);
    assert.deepEqual(io.peerGraph.neighbors(roomId, b.id), [fresh.id]);
    assert.equal(io.peerGraph.edges(roomId).some((edge) => edge.a === oldId || edge.b === oldId), false);
    assert.equal(await UserPresence.countDocuments({ sessionId: oldId }), 0);
  });
});

test('users at the same coordinates connect; nobody connects to itself or across rooms', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('coincident');
    const otherRoomId = await createRoom('coincident-other');
    const a = await joinAs(client, roomId, 'Ada');
    const b = await joinAs(client, roomId, 'Bob');
    const out = await joinAs(client, otherRoomId, 'Out');
    const mate = await joinAs(client, otherRoomId, 'Mate');

    await moveTo(a, b, 700, 700);
    await moveTo(b, a, 700, 700); // distance 0
    await eventually(() => {
      assert.equal(a.events.connects.length, 1);
      assert.equal(b.events.connects.length, 1);
    });
    assert.equal(a.events.connects[0].peerId, b.id);
    assert.equal(io.peerGraph.stats(roomId).edges, 1);
    assert.equal(a.events.connects.some((event) => event.peerId === a.id), false, 'no self edge');

    // A user in another room can share the exact same pixel and stays alone.
    await moveTo(out, mate, 700, 700);
    assert.equal(io.peerGraph.stats(otherRoomId).edges, 0);
    assert.equal(out.events.connects.length, 0);
    assert.equal(a.events.connects.length, 1);

    const generation = a.events.connects[0].generation;
    await expectSignalError(
      a.socket,
      { to: out.id, generation, data: { type: 'offer', sdp: 'v=0' } },
      'no_peer_edge',
      'to',
    );
    await expectSignalError(
      a.socket,
      { to: a.id, generation, data: { type: 'offer', sdp: 'v=0' } },
      'no_peer_edge',
      'to',
    );
  });
});

test('50 users moving randomly keep exactly the brute-force edge set; recompute timing is reported', async (t) => {
  if (!requireMongo(t)) return;
  await withServer(async ({ client, io }) => {
    const roomId = await createRoom('stress');
    const users = [];
    for (let i = 0; i < 50; i += 1) users.push(await joinAs(client, roomId, `U${i}`));
    assert.equal(io.peerGraph.stats(roomId).users, 50);

    let seed = 0x5eed1234;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    const rounds = 20;

    for (let round = 0; round < rounds; round += 1) {
      for (const user of users) {
        user.socket.emit('move', {
          x: Math.round(20 + random() * (config.world.width - 40)),
          y: Math.round(20 + random() * (config.world.height - 40)),
        });
        // Spread the 50 moves over the round instead of one simultaneous
        // burst: this is closer to independent humans moving around.
        await sleep(2);
      }
      if (round % 5 === 0) {
        const sample = io.peerGraph.edges(roomId);
        assert.equal(new Set(sample.map((edge) => edge.key)).size, sample.length, 'no duplicate edges');
        for (const edge of sample) assert.notEqual(edge.a, edge.b, 'no self edge');
      }
      await sleep(120);
    }

    // Wait until the per-user sync queues have been idle for a moment.
    let lastSyncs = -1;
    let lastChange = Date.now();
    await eventually(async () => {
      const syncs = io.peerGraph.stats(roomId).syncs;
      if (syncs !== lastSyncs) {
        lastSyncs = syncs;
        lastChange = Date.now();
      }
      assert.ok(Date.now() - lastChange >= 750, `still syncing (${syncs} recomputes)`);
    }, { timeout: 20000, interval: 100 });

    const rows = await UserPresence.find({ roomId }).lean();
    assert.equal(rows.length, 50);
    const expected = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const distance = Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y);
        if (distance <= config.proximity.radiusPx) {
          expected.add(edgeKeyOf(rows[i].sessionId, rows[j].sessionId));
        }
      }
    }
    const actualEdges = io.peerGraph.edges(roomId);
    const actual = new Set(actualEdges.map((edge) => edge.key));
    assert.equal(actual.size, actualEdges.length, 'the graph holds each pair once');
    assert.deepEqual([...actual].sort(), [...expected].sort(), 'graph edges equal the brute-force result');
    assert.equal(io.peerGraph.stats(roomId).edges, expected.size);

    const latency = io.peerGraph.latencySummary();
    const report = `Day 8 stress: ${users.length} users x ${rounds} moves, ${latency.samples} recomputes, `
      + `edges=${expected.size}, p50=${latency.p50.toFixed(2)}ms, p95=${latency.p95.toFixed(2)}ms`;
    t.diagnostic(report);
    console.log(`\n${report}\n`);
    assert.ok(latency.samples > 0);
    for (const user of users) assert.equal(user.socket.connected, true, 'no socket crashed during the run');
  });
});
