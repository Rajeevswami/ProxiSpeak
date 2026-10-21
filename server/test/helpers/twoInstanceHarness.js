/**
 * Shared test harness for Day 12 multi-instance & failure suites.
 *
 * Uses real Node `http.Server`, real Express `createApp`, real Socket.io
 * `createSocketServer`, real `socket.io-client` WebSockets, real `connectRedis`
 * (`ioredis` + `@socket.io/redis-adapter`), and a deterministic shared spatial
 * presence store using `createGeoTransform` + exact pixel distance so multi-node
 * Redis suites run end-to-end even on machines without a local `mongod` binary.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as createClient } from 'socket.io-client';

import config from '../../src/config/index.js';
import { createLogger } from '../../src/utils/logger.js';
import { createApp } from '../../src/app.js';
import { connectRedis, createScaleState } from '../../src/db/redis.js';
import { createSocketServer } from '../../src/sockets/index.js';
import { buildDefaultRoom } from '../../src/services/roomService.js';

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function createMemoryLogger() {
  const entries = [];
  const make = (scope) => ({
    entries,
    error: (...args) => entries.push({ level: 'error', scope, text: args.map(String).join(' ') }),
    warn: (...args) => entries.push({ level: 'warn', scope, text: args.map(String).join(' ') }),
    info: (...args) => entries.push({ level: 'info', scope, text: args.map(String).join(' ') }),
    debug: (...args) => entries.push({ level: 'debug', scope, text: args.map(String).join(' ') }),
    child: (sub) => make(`${scope}:${sub}`),
  });
  return make('test');
}

/**
 * Shared multi-instance presence & geospatial backing store with exact
 * Mongoose-compatible `presenceStore`, `roomService`, `findNearby`, AND
 * `presenceModel` methods (`find(...).lean()`, `deleteOne(...)`, `deleteMany(...)`).
 */
export function createSharedClusterBacking() {
  const rows = new Map(); // sessionId -> doc
  const rooms = new Map([
    ['lobby', buildDefaultRoom('lobby', config.world)],
    ['garden', buildDefaultRoom('garden', config.world)],
  ]);
  let docSeq = 1;

  const matchesFilter = (doc, filter = {}) => {
    for (const [k, cond] of Object.entries(filter)) {
      const val = doc[k];
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        if ('$lt' in cond && !(new Date(val).getTime() < new Date(cond.$lt).getTime())) return false;
        if ('$in' in cond && !cond.$in.includes(val)) return false;
      } else if (val !== cond) {
        return false;
      }
    }
    return true;
  };

  const presence = {
    async upsertPosition(user, geo, { upsert = true } = {}) {
      const existing = rows.get(user.id);
      if (!existing && !upsert) {
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }
      const point = geo.pixelToGeo(user.x, user.y);
      const doc = {
        _id: existing?._id ?? `doc_${docSeq++}`,
        sessionId: user.id,
        instanceId: user.instanceId,
        roomId: user.roomId,
        name: user.name,
        color: user.color ?? '#4f8cff',
        avatar: user.avatar ?? 'circle',
        x: user.x,
        y: user.y,
        angle: user.angle ?? 0,
        location: point,
        lastSeen: new Date(user.lastSeen ?? Date.now()),
      };
      rows.set(user.id, doc);
      return {
        matchedCount: existing ? 1 : 0,
        modifiedCount: existing ? 1 : 0,
        upsertedCount: existing ? 0 : 1,
      };
    },
    async refreshLastSeen(sessionId, roomId, instanceId, now = Date.now()) {
      const existing = rows.get(sessionId);
      if (!existing || existing.roomId !== roomId) return { matchedCount: 0 };
      existing.lastSeen = new Date(now);
      if (instanceId) existing.instanceId = instanceId;
      return { matchedCount: 1 };
    },
    async removeUser(sessionId) {
      return rows.delete(sessionId);
    },
    async listPresenceByRoom(roomId) {
      return [...rows.values()]
        .filter((d) => d.roomId === roomId)
        .map((d) => ({ ...d }));
    },
  };

  const roomSvc = {
    async getRoom(roomId) {
      return rooms.get(roomId) ?? null;
    },
    async listRoomIds() {
      return [...rooms.keys()];
    },
  };

  const findNearby = async (roomId, selfId, radiusPx) => {
    const me = rows.get(selfId);
    if (!me || me.roomId !== roomId) return [];
    const out = [];
    for (const candidate of rows.values()) {
      if (candidate.roomId !== roomId || candidate.sessionId === selfId) continue;
      const d = Math.hypot(candidate.x - me.x, candidate.y - me.y);
      if (d <= radiusPx) {
        out.push({ id: candidate.sessionId, distancePx: d });
      }
    }
    out.sort((l, r) => l.distancePx - r.distancePx);
    return out;
  };

  const presenceModel = {
    find(filter = {}) {
      const matched = [...rows.values()]
        .filter((doc) => matchesFilter(doc, filter))
        .map((doc) => ({ ...doc }));
      return {
        lean: async () => matched,
      };
    },
    async deleteOne(filter = {}) {
      for (const [sessionId, doc] of rows.entries()) {
        if (matchesFilter(doc, filter)) {
          rows.delete(sessionId);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    },
    async deleteMany(filter = {}) {
      let deletedCount = 0;
      for (const [sessionId, doc] of [...rows.entries()]) {
        if (matchesFilter(doc, filter)) {
          rows.delete(sessionId);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
  };

  return {
    rows,
    presence,
    rooms: roomSvc,
    findNearby,
    presenceModel,
  };
}

export async function startClusterNode({
  instanceId,
  redisUrl = '',
  keyPrefix = 'proxispeak-test',
  edgeSweepIntervalMs = 60_000,
  edgeTtlSeconds = 3600,
  connectTimeoutMs = 1500,
  moveEventsPerSec = 500,
  signalEventsPerSec = 200,
  signalBurst = 400,
  maxStepPx = 2000,
  backing,
  tlsOptions,
  logger = createLogger('error'),
} = {}) {
  const cfg = {
    ...config,
    server: {
      ...config.server,
      instanceId,
    },
    socket: {
      ...config.socket,
      moveEventsPerSec,
      signalEventsPerSec,
      signalBurst,
      maxStepPx,
    },
    redis: {
      ...config.redis,
      url: redisUrl,
      keyPrefix,
      edgeSweepIntervalMs,
      edgeTtlSeconds,
      connectTimeoutMs,
    },
  };

  const scaleState = createScaleState(instanceId, 'single');
  const redis = await connectRedis({
    config: cfg,
    tls: tlsOptions,
    logger,
    scaleState,
  });

  const httpServer = http.createServer();
  const sockets = new Set();
  httpServer.on('connection', (tcpSocket) => {
    sockets.add(tcpSocket);
    tcpSocket.on('close', () => sockets.delete(tcpSocket));
  });

  const app = createApp({ config: cfg, logger, scaleState });
  httpServer.on('request', app);

  const io = createSocketServer({
    httpServer,
    config: cfg,
    logger,
    presence: backing.presence,
    rooms: backing.rooms,
    findNearby: backing.findNearby,
    redis,
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    instanceId,
    baseUrl,
    port,
    cfg,
    scaleState,
    redis,
    httpServer,
    io,
    rawTcpSockets: sockets,
    async killAbruptly() {
      // Simulates OS `kill -9`: tear down raw TCP sockets immediately without
      // emitting graceful Socket.io `disconnect` application cleanups to Redis!
      io.removeAllListeners();
      for (const s of io.sockets.sockets.values()) {
        s.removeAllListeners('disconnect');
      }
      for (const tcp of sockets) {
        tcp.destroy();
      }
      httpServer.close();
      if (redis.enabled) {
        redis.storeClient?.disconnect(false);
        redis.pubClient?.disconnect(false);
        redis.subClient?.disconnect(false);
      }
    },
    async close() {
      await new Promise((resolve) => io.close(resolve));
      await io.drainSessions();
      await new Promise((resolve) => httpServer.close(() => resolve()));
      await redis.close().catch(() => {});
    },
  };
}

export function connectTestClient(baseUrl, { reconnection = false, reconnectionDelay = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const client = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection,
      reconnectionDelay,
      reconnectionDelayMax: 80,
      timeout: 4000,
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`timed out connecting client to ${baseUrl}`));
    }, 4000);
    timer.unref();

    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('connect_error', (err) => {
      if (reconnection) return;
      clearTimeout(timer);
      client.close();
      reject(err);
    });
  });
}

export function waitEvent(emitter, event, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for event "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolve(payload);
    }

    emitter.on(event, onEvent);
  });
}

export const delay = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

/**
 * Start a dedicated ephemeral `redis-server` child process on `port` so tests
 * can stop/kill/restart Redis mid-run without disturbing the shared daemon.
 */
export async function spawnEphemeralRedisServer(port) {
  const dir = mkdtempSync(join(tmpdir(), 'proxispeak-redis-test-'));
  const child = spawn(
    'redis-server',
    [
      '--port', String(port),
      '--bind', '127.0.0.1',
      '--dir', dir,
      '--save', '',
      '--appendonly', 'no',
      '--loglevel', 'warning',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Wait until TCP port accepts PING -> PONG
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ready = await new Promise((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('*1\r\n$4\r\nPING\r\n');
      });
      sock.once('data', (chunk) => {
        sock.end();
        resolve(String(chunk).includes('+PONG'));
      });
      sock.once('error', () => resolve(false));
    });
    if (ready) break;
    // eslint-disable-next-line no-await-in-loop
    await delay(30);
  }

  return {
    port,
    dir,
    child,
    async killHard() {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Generate a throwaway self-signed X.509 cert + key and start a real Node TLS
 * termination server tunneling to an active plain TCP Redis port (`rediss://`).
 */
export async function startRedisTlsTunnel(targetRedisPort) {
  const dir = mkdtempSync(join(tmpdir(), 'proxispeak-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });

  const { readFileSync } = await import('node:fs');
  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');

  const activeSockets = new Set();
  const server = tls.createServer({ key, cert }, (tlsSocket) => {
    const upstream = net.connect(targetRedisPort, '127.0.0.1');
    activeSockets.add(tlsSocket);
    activeSockets.add(upstream);
    tlsSocket.pipe(upstream);
    upstream.pipe(tlsSocket);
    const cleanup = () => {
      activeSockets.delete(tlsSocket);
      activeSockets.delete(upstream);
      tlsSocket.destroy();
      upstream.destroy();
    };
    tlsSocket.on('error', cleanup);
    upstream.on('error', cleanup);
    tlsSocket.on('close', cleanup);
    upstream.on('close', cleanup);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    caCert: cert,
    url: `rediss://127.0.0.1:${port}`,
    async close() {
      for (const s of activeSockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
