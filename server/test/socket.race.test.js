/**
 * Day 3 regression tests for the failure modes that only appear when a database
 * write is slow: a duplicate `join` that arrives while the first one is still in
 * flight, a socket that disconnects mid-join, and a shutdown that must not cut
 * an in-flight presence cleanup off.
 *
 * No MongoDB here on purpose — an in-memory presence/room double with an
 * injectable write latency makes every window deterministic, so these run (and
 * fail loudly) everywhere. The Mongo-backed behaviour is covered by
 * socket.integration.test.js.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io as createClient } from 'socket.io-client';

import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createSocketServer } from '../src/sockets/index.js';

const log = createLogger(process.env.LOG_LEVEL ?? 'error');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Presence store double: rows in a Map, every write taking `latencyMs`. */
function createSlowPresence({ latencyMs = 0 } = {}) {
  const rows = new Map();
  // `upsertsStarted` counts writes that began, `upsertsLanded` those whose row
  // is actually in the map — the difference is the window these tests target.
  const calls = { upserts: 0, upsertsLanded: 0, removals: 0 };
  return {
    rows,
    calls,
    setLatency(ms) { latencyMs = ms; },
    async upsertPosition(user, _geo, { upsert = true } = {}) {
      calls.upserts += 1;
      await sleep(latencyMs);
      if (!upsert && !rows.has(user.id)) return { acknowledged: true, matchedCount: 0 };
      rows.set(user.id, { sessionId: user.id, roomId: user.roomId, name: user.name, x: user.x, y: user.y });
      calls.upsertsLanded += 1;
      return { acknowledged: true, matchedCount: 1 };
    },
    async removeUser(sessionId) {
      await sleep(latencyMs);
      const had = rows.has(sessionId);
      rows.delete(sessionId);
      calls.removals += 1;
      return { deletedCount: had ? 1 : 0 };
    },
    async listPresenceByRoom(roomId) {
      return [...rows.values()].filter((row) => row.roomId === roomId);
    },
  };
}

/** Room service double: one small room, no database. */
function createStaticRooms(roomIds = ['lobby']) {
  const room = (roomId) => ({
    roomId,
    name: roomId,
    width: 400,
    height: 400,
    obstacles: [],
    spawnPoints: [{ x: 100, y: 100 }, { x: 300, y: 300 }],
  });
  return { async getRoom(roomId) { return roomIds.includes(roomId) ? room(roomId) : null; } };
}

const servers = [];
const clients = [];

async function startServer({ presence, cfg = config, roomIds = ['lobby'] } = {}) {
  const server = http.createServer((req, res) => res.writeHead(404).end());
  const io = createSocketServer({
    httpServer: server,
    config: cfg,
    logger: log,
    presence,
    rooms: createStaticRooms(roomIds),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const handle = {
    url,
    io,
    /** Close the gateway (as a shutdown does) and let its cleanups finish. */
    shutdown: async () => {
      await new Promise((resolve) => io.close(resolve));
      await io.drainSessions();
      await new Promise((resolve) => server.close(resolve));
    },
    close: async () => {
      await new Promise((resolve) => io.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
  servers.push(handle);
  return handle;
}

function client(url) {
  const socket = createClient(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return socket;
}

const connect = async (socket) => {
  if (socket.connected) return socket;
  await once(socket, 'connect');
  return socket;
};

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

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close();
  for (const handle of servers.splice(0)) await handle.close();
});

test('a duplicate join sent while the first one is still in flight joins once', async () => {
  const presence = createSlowPresence({ latencyMs: 60 }); // wide, deterministic window
  const { url, io } = await startServer({ presence });

  const watcher = await connect(client(url));
  const watcherJoined = waitFor(watcher, 'joined');
  watcher.emit('join', { roomId: 'lobby', name: 'Watcher' });
  await watcherJoined;

  let announcements = 0;
  watcher.on('user:joined', (payload) => {
    if (payload.name === 'Doubleclick') announcements += 1;
  });

  const dupe = await connect(client(url));
  let replies = 0;
  dupe.on('joined', () => (replies += 1));

  // Same tick, twice: the second arrives while the first join is still writing
  // its presence document.
  dupe.emit('join', { roomId: 'lobby', name: 'Doubleclick' });
  dupe.emit('join', { roomId: 'lobby', name: 'Doubleclick' });

  await waitFor(dupe, 'joined');
  await sleep(400);

  assert.equal(presence.calls.upserts, 2, 'one upsert per socket (watcher + doubleclick)');
  assert.equal(presence.rows.size, 2, 'one presence document per socket');
  assert.equal(announcements, 1, 'exactly one user:joined broadcast per joined socket');
  assert.equal(replies, 2, 'each explicit join request is answered with a snapshot');
  assert.equal([...io.sockets.sockets.values()].length, 2);
});

test('a socket that disconnects while its join is writing leaves no ghost presence', async () => {
  const presence = createSlowPresence({ latencyMs: 80 });
  const { url } = await startServer({ presence });

  const leaver = await connect(client(url));
  const leaverId = leaver.id;
  leaver.emit('join', { roomId: 'lobby', name: 'Bailout' });
  await sleep(15); // the presence write is in flight
  leaver.close();

  // Wait until that write has actually landed — the moment the race is decided.
  // Without the abort path the row is now orphaned forever (assertions below).
  const deadline = Date.now() + 3000;
  while (presence.calls.upsertsLanded === 0 && Date.now() < deadline) await sleep(20);
  assert.equal(presence.calls.upsertsLanded, 1, 'the aborted join really did write its row');

  await sleep(150); // and the cleanup has had time to run

  assert.equal(presence.rows.has(leaverId), false, 'the presence row of the aborted join was removed');
  assert.equal(presence.rows.size, 0, 'no ghost documents remain');
  assert.equal(presence.calls.removals, 1, 'exactly one cleanup write');
});

test('shutdown waits for in-flight presence cleanup before the database closes', async () => {
  const presence = createSlowPresence({ latencyMs: 80 });
  const { url, shutdown } = await startServer({ presence });

  const socket = await connect(client(url));
  const socketId = socket.id; // cleared by the client as the connection drops
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Graceful' });
  await joined;
  assert.equal(presence.rows.size, 1);

  // Mirror the real boot sequence: io.close() -> drainSessions() -> the driver
  // refuses further writes. Without the drain, the delete is cut off and the
  // document survives as a ghost.
  let databaseOpen = true;
  const trackedRemovals = [];
  const originalRemove = presence.removeUser.bind(presence);
  presence.removeUser = async (sessionId) => {
    if (!databaseOpen) throw new Error('MongoNotConnectedError: Client must be connected');
    const result = await originalRemove(sessionId);
    trackedRemovals.push(sessionId);
    return result;
  };

  await shutdown();
  databaseOpen = false; // what disconnectMongo() does, one line later

  assert.deepEqual(trackedRemovals, [socketId], 'the presence delete completed while the database was still open');
  assert.equal(presence.rows.size, 0, 'no ghost document was left behind by the shutdown');
});

test('a shutdown with several connected clients removes every presence document', async () => {
  const presence = createSlowPresence({ latencyMs: 40 });
  const { url, shutdown } = await startServer({ presence });

  const sockets = await Promise.all(Array.from({ length: 12 }, () => connect(client(url))));
  await Promise.all(
    sockets.map((socket, i) =>
      new Promise((resolve) => {
        socket.once('joined', resolve);
        socket.emit('join', { roomId: 'lobby', name: `User ${i}` });
      }),
    ),
  );
  assert.equal(presence.rows.size, 12, 'every client has a presence document');

  await shutdown();

  assert.equal(presence.rows.size, 0, 'the shutdown drained all twelve cleanups');
});

test('disconnect during a delayed move does not recreate presence or reject asynchronously', async () => {
  const presence = createSlowPresence();
  const { url, io } = await startServer({ presence });
  const socket = await connect(client(url));
  const id = socket.id;
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Moving leaver' });
  await joined;
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const write = presence.upsertPosition.bind(presence);
  presence.upsertPosition = async (user, ...args) => { started(); await gate; return write(user, ...args); };
  socket.emit('move', { x: 110, y: 100 });
  await entered;
  socket.close();
  await sleep(50);
  release();
  await io.drainSessions();
  await sleep(30);
  assert.equal(presence.rows.has(id), false, 'a move cannot resurrect a disconnected user');
});

test('accepted moves persist immutable coordinates in receive order', async () => {
  const presence = createSlowPresence();
  const { url } = await startServer({ presence });
  const socket = await connect(client(url));
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Ordered mover' });
  await joined;
  const writes = [];
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const write = presence.upsertPosition.bind(presence);
  presence.upsertPosition = async (user, ...args) => {
    writes.push(user.x);
    if (writes.length === 1) { started(); await gate; }
    return write(user, ...args);
  };
  socket.emit('move', { x: 110, y: 100 });
  await entered;
  socket.emit('move', { x: 120, y: 100 });
  await sleep(30);
  assert.deepEqual(writes, [110], 'second DB write waits for the earlier accepted move');
  release();
  await sleep(70);
  assert.deepEqual(writes, [110, 120]);
  assert.equal(presence.rows.get(socket.id).x, 120);
});

test('shutdown drains a join write already in flight', async () => {
  const presence = createSlowPresence();
  const { url, shutdown } = await startServer({ presence });
  const socket = await connect(client(url));
  const id = socket.id;
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const write = presence.upsertPosition.bind(presence);
  presence.upsertPosition = async (user, ...args) => { started(); await gate; return write(user, ...args); };
  socket.emit('join', { roomId: 'lobby', name: 'Shutdown join' });
  await entered;
  const closing = shutdown();
  release();
  await closing;
  assert.equal(presence.rows.has(id), false);
});

test('a forbidden Origin cannot bypass CLIENT_URL using WebSocket transport', async () => {
  const presence = createSlowPresence();
  const cfg = { ...config, server: { ...config.server, clientOrigins: ['https://trusted.example'] } };
  const { url } = await startServer({ presence, cfg });
  const socket = createClient(url, { transports: ['websocket'], reconnection: false,
    forceNew: true, extraHeaders: { Origin: 'https://untrusted.example' } });
  clients.push(socket);
  const outcome = await new Promise((resolve) => {
    socket.once('connect', () => resolve('accepted'));
    socket.once('connect_error', () => resolve('rejected'));
  });
  assert.equal(outcome, 'rejected');
  assert.equal(presence.rows.size, 0);
});

test('a legitimate 10 Hz client broadcasts every move and preserves snapshot names', async (t) => {
  const presence = createSlowPresence();
  const { url } = await startServer({ presence });
  const watcher = await connect(client(url));
  let joined = waitFor(watcher, 'joined');
  watcher.emit('join', { roomId: 'lobby', name: 'Watcher' });
  await joined;
  const mover = await connect(client(url));
  joined = waitFor(mover, 'joined');
  mover.emit('join', { roomId: 'lobby', name: 'Ten Hertz' });
  const snapshot = await joined;
  assert.equal(snapshot.users.find((u) => u.id === watcher.id).name, 'Watcher');
  let received = 0;
  watcher.on('user:moved', (u) => { if (u.id === mover.id) received++; });
  for (let i = 0; i < 20; i++) {
    mover.emit('move', { x: 290 - i, y: 300 });
    await sleep(100);
  }
  await sleep(50);
  t.diagnostic(`10Hz socket client: sent=20 accepted=${presence.calls.upserts - 2} broadcasts=${received} dropped=${20 - received} (in-memory store)`);
  assert.equal(received, 20);
  assert.equal(presence.calls.upserts - 2, 20);
});

test('existing Engine.IO pong refreshes idle lastSeen without a new client event', async () => {
  const presence = createSlowPresence();
  let refreshed;
  const heartbeat = new Promise((resolve) => { refreshed = resolve; });
  presence.refreshLastSeen = async (id, roomId, instanceId, now) => {
    const row = presence.rows.get(id);
    if (row) row.lastSeen = now;
    refreshed({ id, roomId, instanceId, now });
  };
  const { url, io } = await startServer({ presence });
  // Accelerate only the test server's existing Engine.IO heartbeat.
  io.engine.opts.pingInterval = 30;
  const socket = await connect(client(url));
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Idle' });
  await joined;
  let timer, result;
  try {
    result = await Promise.race([heartbeat, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('no heartbeat refresh')), 2000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(result.id, socket.id);
  assert.equal(result.roomId, 'lobby');
  assert.equal(result.instanceId, config.server.instanceId);
  assert.equal(presence.rows.get(socket.id).lastSeen, result.now);
});


test('SIGKILL of a client process produces user:left and removes its row (store double)', async (t) => {
  const presence = createSlowPresence();
  const { url } = await startServer({ presence });
  const watcher = await connect(client(url));
  let joined = waitFor(watcher, 'joined');
  watcher.emit('join', { roomId: 'lobby', name: 'Watcher' });
  await joined;
  const moduleUrl = new URL('../node_modules/socket.io-client/build/esm-debug/index.js', import.meta.url).href;
  const script = `import {io} from ${JSON.stringify(moduleUrl)};
    const socket=io(${JSON.stringify(url)}, {transports:['websocket'],reconnection:false});
    socket.on('connect',()=>socket.emit('join',{roomId:'lobby',name:'Killed client'}));
    socket.on('joined',()=>process.send({id:socket.id}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
  const [{ id }] = await once(child, 'message');
  assert.equal(presence.rows.has(id), true);
  const left = waitFor(watcher, 'user:left', (u) => u.id === id);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited; await left; await sleep(30);
  assert.equal(presence.rows.has(id), false);
});

test('room broadcasts stay isolated and malformed payloads do not crash the gateway', async () => {
  const presence = createSlowPresence();
  const { url } = await startServer({ presence, roomIds: ['lobby', 'studio'] });
  const a = await connect(client(url)), b = await connect(client(url));
  for (const [socket, roomId] of [[a, 'lobby'], [b, 'studio']]) {
    const joined = waitFor(socket, 'joined');
    socket.emit('join', { roomId, name: roomId }); await joined;
  }
  let crossRoom = 0;
  b.on('user:moved', () => { crossRoom++; });
  a.emit('move', { x: 110, y: 100 }); await sleep(30);
  for (const payload of [null, [], {}, {x: 'bad', y: 100}, {x: 1e100, y: 100}]) {
    const rejected = waitFor(a, 'error');
    a.emit('move', payload); const error = await rejected;
    assert.equal(error.code, 'invalid_payload');
  }
  assert.equal(a.connected, true);
  assert.equal(b.connected, true);
  assert.equal(crossRoom, 0);
});

test('stale sweep disconnects the old transport and the client automatically rejoins once', async (t) => {
  const { cleanupStale } = await import('../src/services/presenceCleanup.js');
  const { default: Presence } = await import('../src/models/UserPresence.js');
  const { recoverExpiredSession } = await import('../../client/src/realtime/sessionRecovery.js');
  const { createWorldState, applyJoinedSnapshot } = await import('../../client/src/realtime/worldState.js');
  const presence = createSlowPresence();
  const { url, io } = await startServer({ presence });
  const watcher = await connect(client(url));
  let joined = waitFor(watcher, 'joined');
  watcher.emit('join', { roomId: 'lobby', name: 'Watcher' }); await joined;
  const socket = createClient(url, { transports: ['websocket'], autoConnect: false,
    reconnection: true, reconnectionDelay: 10, randomizationFactor: 0 });
  clients.push(socket);
  const world = createWorldState();
  let joins = 0, departures = 0;
  socket.on('connect', () => socket.emit('join', { roomId: 'lobby', name: 'Returning' }));
  socket.on('error', (err) => recoverExpiredSession(socket, err));
  socket.on('joined', (snapshot) => { joins++; applyJoinedSnapshot(world, snapshot); });
  joined = waitFor(socket, 'joined'); socket.connect(); await joined;
  const oldId = socket.id;
  watcher.on('user:left', (u) => { if (u.id === oldId) departures++; });
  t.mock.method(Presence, 'find', (filter) => ({ lean: async () => {
    assert.equal(filter.instanceId, config.server.instanceId);
    return [{ _id: oldId, sessionId: oldId, roomId: 'lobby' }];
  } }));
  t.mock.method(Presence, 'deleteOne', async (filter) => {
    assert.equal(filter.roomId, 'lobby');
    return { deletedCount: presence.rows.delete(filter._id) ? 1 : 0 };
  });
  const disconnected = waitFor(socket, 'disconnect');
  const rejoined = waitFor(socket, 'joined', (snapshot) => snapshot.selfId !== oldId);
  await cleanupStale(io);
  await disconnected;
  assert.equal(io.sockets.sockets.has(oldId), false);
  await rejoined; await io.drainSessions(); await sleep(30);
  assert.notEqual(socket.id, oldId);
  assert.equal(presence.rows.has(oldId), false);
  assert.equal(presence.rows.size, 2, 'watcher and one freshly admitted user');
  assert.equal(joins, 2, 'one initial join and one reconnect join');
  assert.equal(departures, 1, 'sweep and disconnect must not duplicate user:left');
  assert.equal(world.users.has(oldId), false);
  assert.equal(world.users.size, 2);
});

test('move after row expiry is rejected without upsert; shared client recovery rejoins', async () => {
  const { recoverExpiredSession } = await import('../../client/src/realtime/sessionRecovery.js');
  const presence = createSlowPresence();
  const { url } = await startServer({ presence });
  const socket = await connect(client(url));
  let joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Expired mover' }); await joined;
  const oldId = socket.id;
  presence.rows.delete(oldId);
  const rejected = waitFor(socket, 'error');
  socket.emit('move', { x: 110, y: 100 });
  const error = await rejected;
  assert.equal(error.code, 'session_expired');
  assert.equal(presence.rows.has(oldId), false);
  socket.emit('move', { x: 120, y: 100 });
  await waitFor(socket, 'error', (e) => e.code === 'session_expired');
  assert.equal(presence.rows.size, 0, 'even repeated moves cannot re-admit the old session');
  // Same recovery function used by useSocket; existing connect handler resends join.
  socket.on('connect', () => socket.emit('join', { roomId: 'lobby', name: 'Expired mover' }));
  joined = waitFor(socket, 'joined');
  assert.equal(recoverExpiredSession(socket, error), true);
  await joined;
  assert.notEqual(socket.id, oldId);
  assert.equal(presence.rows.has(oldId), false);
  assert.equal(presence.rows.size, 1);
});

test('a deletion racing an accepted move cannot be undone by that move', async () => {
  const presence = createSlowPresence();
  const { url } = await startServer({ presence });
  const socket = await connect(client(url));
  const joined = waitFor(socket, 'joined');
  socket.emit('join', { roomId: 'lobby', name: 'Racing expiry' }); await joined;
  const id = socket.id;
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const write = presence.upsertPosition.bind(presence);
  presence.upsertPosition = async (user, ...args) => { started(); await gate; return write(user, ...args); };
  const rejected = waitFor(socket, 'error');
  socket.emit('move', { x: 110, y: 100 }); await entered;
  presence.rows.delete(id); release();
  assert.equal((await rejected).code, 'session_expired');
  assert.equal(presence.rows.has(id), false);
});
