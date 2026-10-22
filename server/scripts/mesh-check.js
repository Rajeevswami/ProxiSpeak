#!/usr/bin/env node
/**
 * Week 3, Day 13 — mesh-check.
 *
 * Two ways to run it (both use REAL Socket.io sockets, REAL server instances,
 * REAL WebRTC signaling relay and, when REDIS_URL is set, the REAL Redis
 * adapter + RedisEdgeStore):
 *
 *   1. Self-contained (default):  npm run mesh-check
 *      Starts throwaway Node instances on ephemeral ports with a throwaway
 *      room. MongoDB is not needed: the Day 12 two-instance harness injects
 *      its deterministic in-memory presence/room backing. Everything that
 *      enforces the mesh policy (gateway -> PeerGraph -> EdgeStore -> Redis)
 *      is the production code path. Set REDIS_URL to exercise two instances
 *      sharing the atomic edge store.
 *
 *   2. Against running servers:    npm run mesh-check -- --url=http://127.0.0.1:4000
 *      or --urlA=... --urlB=... (two instances sharing Redis). The room must
 *      already exist (npm run seed); use a throwaway id.
 *
 * Scenarios (per configuration):
 *   - tight cluster N = 10 / 20 / 50 (every pair within 100 px): max/mean
 *     connections per user, total edges, signals relayed, drops, settle time.
 *   - the same run with MAX_PEERS_PER_USER=0 (unlimited) => "before" numbers.
 *   - boundary approach: the first edge must appear exactly when the pair
 *     crosses 100 px, never before (creation-time invariant).
 *   - boundary jitter: 100 crossings with hysteresis (default 115 px) and with
 *     PEER_DISCONNECT_RADIUS_PX == PROXIMITY_RADIUS_PX (the "before" behaviour).
 *
 * Exits 0 only when every check passes; 1 otherwise. Never invents numbers.
 */
import process from 'node:process';
import { io as createClient } from 'socket.io-client';

import config from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import {
  createSharedClusterBacking,
  startClusterNode,
} from '../test/helpers/twoInstanceHarness.js';

const CONNECT_RADIUS = config.proximity.radiusPx;
const EVENT_TIMEOUT_MS = 6000;
const STEP_PX = 80;
const STEP_DELAY_MS = 12;
const QUIET_MS = 700;

const log = logger;

// ------------------------------------------------------------------- helpers ---

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(raw);
  }
}

function waitEvent(emitter, event, predicate = () => true, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}" after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    }
    emitter.on(event, handler);
  });
}

async function connectClient(url) {
  const socket = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: EVENT_TIMEOUT_MS,
  });
  try {
    await waitEvent(socket, 'connect', () => true, EVENT_TIMEOUT_MS);
    return socket;
  } catch (err) {
    socket.close();
    throw new Error(`could not connect to ${redactUrl(url)}: ${err?.message ?? err}`);
  }
}

async function health(url) {
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Walk in <=80 px steps so SOCKET_MAX_STEP_PX applies on any server. */
async function walkTo(socket, from, target) {
  let { x, y } = from;
  for (let guard = 0; guard < 200; guard += 1) {
    const dx = target.x - x;
    const dy = target.y - y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0.5) break;
    const step = Math.min(STEP_PX, distance);
    x = Math.round((x + (dx / distance) * step) * 100) / 100;
    y = Math.round((y + (dy / distance) * step) * 100) / 100;
    socket.emit('move', { x, y });
    await sleep(STEP_DELAY_MS);
  }
  return { x, y };
}

function tightCluster(n, center = { x: 500, y: 500 }) {
  const positions = [];
  for (let i = 0; i < n; i += 1) {
    positions.push({ x: center.x + (i % 10) * 3, y: center.y + Math.floor(i / 10) * 3 });
  }
  return positions;
}

// --------------------------------------------------------------- measurement ---

/**
 * One tight-cluster run: N users, every pair inside 100 px.
 * @returns measured numbers plus the final edge list for invariant checks.
 */
async function measureTightCluster({ n, urls, roomId, maxPeers, dropRadius }) {
  const positions = tightCluster(n);
  const clients = [];
  const connects = []; // historical connect events (churn included)
  const disconnects = [];
  /** pairKey -> live edge { generation, endpoints:Set, initiators:[] } */
  const liveEdges = new Map();
  const startedAt = performance.now();

  try {
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const socket = await connectClient(urls[i % urls.length]);
      socket.dataIndex = i;
      clients.push(socket);
    }

    // Listen before the first join: a spawn can already be inside 100 px.
    for (const socket of clients) {
      socket.on('peer:connect', (event) => {
        connects.push({ from: socket.id, to: event.peerId, generation: event.generation, initiator: event.initiator });
        const key = pairKey(socket.id, event.peerId);
        const existing = liveEdges.get(key);
        if (!existing || existing.generation !== event.generation) {
          liveEdges.set(key, {
            generation: event.generation,
            endpoints: new Set([socket.id]),
            initiators: [event.initiator],
          });
        } else {
          existing.endpoints.add(socket.id);
          existing.initiators.push(event.initiator);
        }
      });
      socket.on('peer:disconnect', (event) => {
        disconnects.push({ from: socket.id, to: event.peerId, generation: event.generation });
        const key = pairKey(socket.id, event.peerId);
        const existing = liveEdges.get(key);
        if (existing && existing.generation === event.generation) liveEdges.delete(key);
      });
    }

    const joined = [];
    for (const socket of clients) {
      // eslint-disable-next-line no-await-in-loop
      const joinedPromise = waitEvent(socket, 'joined');
      socket.emit('join', { roomId, name: `Mesh${socket.dataIndex}` });
      // eslint-disable-next-line no-await-in-loop
      joined.push(await joinedPromise);
    }

    // Walk everyone into the tight cluster, then repeat the final position so a
    // server whose step cap shortened a walk path still lands exactly.
    for (let i = 0; i < clients.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const spawn = joined[i].users.find((user) => user.id === clients[i].id) ?? positions[i];
      // eslint-disable-next-line no-await-in-loop
      const landed = await walkTo(clients[i], spawn, positions[i]);
      if (Math.round(landed.x) !== Math.round(positions[i].x) || Math.round(landed.y) !== Math.round(positions[i].y)) {
        clients[i].emit('move', positions[i]);
      }
    }

    // Stability: no connect/disconnect for QUIET_MS, then 300 ms more.
    let previous = -1;
    let quietSince = performance.now();
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      const events = connects.length + disconnects.length;
      if (events !== previous) {
        previous = events;
        quietSince = performance.now();
      }
      if (performance.now() - quietSince >= QUIET_MS) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    const settleMs = Math.round(performance.now() - startedAt);
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);

    // Final positions: ask the room for its own view via one more observed move.
    const finalPositions = new Map();
    for (const socket of clients) {
      // Reading the resolved snapshot is not available after joining; the walk
      // landed on the exact target, and the target is what the server stored.
      const index = socket.dataIndex;
      finalPositions.set(socket.id, positions[index]);
    }

    // ---- final edge set (recreated edges keep only their live generation) ----
    const edgePairs = new Map();
    const finalDegree = new Map(clients.map((socket) => [socket.id, 0]));
    for (const [key, record] of liveEdges) {
      const [a, b] = key.split('\u0000');
      edgePairs.set(key, {
        a,
        b,
        generation: record.generation,
        initiators: record.initiators.filter(Boolean).length,
        events: record.initiators.length,
        endpoints: record.endpoints.size,
      });
      finalDegree.set(a, (finalDegree.get(a) ?? 0) + 1);
      finalDegree.set(b, (finalDegree.get(b) ?? 0) + 1);
    }

    const byId = new Map(clients.map((socket) => [socket.id, socket]));
    const pending = [];
    let signalsAttempted = 0;
    for (const record of edgePairs.values()) {
      const sender = byId.get(record.a);
      const receiver = byId.get(record.b);
      if (!sender || !receiver) continue;
      signalsAttempted += 1;
      pending.push(
        waitEvent(receiver, 'signal', (payload) => payload.from === record.a && payload.generation === record.generation, 4000)
          .then(() => true)
          .catch(() => false),
      );
      sender.emit('signal', {
        to: record.b,
        generation: record.generation,
        data: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
      });
    }
    const delivered = (await Promise.all(pending)).filter(Boolean).length;

    const perUser = clients.map((socket) => finalDegree.get(socket.id) ?? 0);
    const maxDegree = perUser.length ? Math.max(...perUser) : 0;
    const meanDegree = perUser.length ? perUser.reduce((sum, value) => sum + value, 0) / perUser.length : 0;

    return {
      n,
      clientIds: clients.map((socket) => socket.id),
      perUser,
      maxDegree,
      meanDegree: Number(meanDegree.toFixed(2)),
      edges: edgePairs.size,
      connectEvents: connects.length,
      disconnectEvents: disconnects.length,
      churnEvents: connects.length - edgePairs.size * 2,
      signalsAttempted,
      signalsRelayed: delivered,
      signalDrops: signalsAttempted - delivered,
      settleMs,
      edgePairs,
      finalPositions,
      maxPeers,
      dropRadius,
      joined,
    };
  } finally {
    for (const socket of clients) {
      socket.removeAllListeners();
      socket.close();
    }
  }
}

/**
 * Approach + jitter in a dedicated room. Returns how many connect/disconnect
 * events 100 boundary crossings produced, plus the first-connect distance.
 */
async function measureBoundary({ urls, roomId, dropRadius }) {
  const a = await connectClient(urls[0]);
  const b = await connectClient(urls[urls.length - 1]);
  const connectsA = [];
  const disconnectsA = [];
  const connectsB = [];
  const disconnectsB = [];
  let maxDistanceWhileConnected = 0;

  try {
    a.on('peer:connect', (event) => connectsA.push(event));
    a.on('peer:disconnect', (event) => disconnectsA.push(event));
    b.on('peer:connect', (event) => connectsB.push(event));
    b.on('peer:disconnect', (event) => disconnectsB.push(event));

    const joinedA = waitEvent(a, 'joined');
    a.emit('join', { roomId, name: 'BoundaryA' });
    await joinedA;
    const joinedB = waitEvent(b, 'joined');
    b.emit('join', { roomId, name: 'BoundaryB' });
    await joinedB;

    // A fixed at (500, 500).
    const spawnA = (await joinedA).users.find((user) => user.id === a.id);
    await walkTo(a, spawnA, { x: 500, y: 500 });
    // B: 260 px away, well outside both radii.
    const spawnB = (await joinedB).users.find((user) => user.id === b.id);
    await walkTo(b, spawnB, { x: 760, y: 500 });
    await sleep(400);
    const baseline = connectsA.length;

    // Approach in 10 px steps and record the distance of the first connect.
    let firstConnectDistance = null;
    for (let x = 750; x >= 490; x -= 10) {
      const before = connectsA.length;
      b.emit('move', { x, y: 500 });
      // eslint-disable-next-line no-await-in-loop
      await sleep(60);
      if (firstConnectDistance === null && connectsA.length > before) {
        firstConnectDistance = Math.abs(x - 500);
      }
      if (connectsA.length > baseline) maxDistanceWhileConnected = Math.max(maxDistanceWhileConnected, Math.abs(x - 500));
    }
    const connectedAfterApproach = connectsA.length > baseline;

    // 100 crossings around the 100 px boundary: 99 px <-> 101 px.
    const beforeJitter = { connects: connectsA.length + connectsB.length, disconnects: disconnectsA.length + disconnectsB.length };
    for (let step = 0; step < 100; step += 1) {
      const x = step % 2 === 0 ? 601 : 599;
      b.emit('move', { x, y: 500 });
      // eslint-disable-next-line no-await-in-loop
      await sleep(35);
    }
    await sleep(600);

    return {
      firstConnectDistance,
      connectedAfterApproach,
      maxDistanceWhileConnected,
      connects: connectsA.length,
      disconnects: disconnectsA.length,
      beforeJitter,
      afterJitter: {
        connects: connectsA.length + connectsB.length,
        disconnects: disconnectsA.length + disconnectsB.length,
      },
      jitterConnects: connectsA.length + connectsB.length - beforeJitter.connects,
      jitterDisconnects: disconnectsA.length + disconnectsB.length - beforeJitter.disconnects,
      dropRadius,
      connectRadius: CONNECT_RADIUS,
    };
  } finally {
    a.close();
    b.close();
  }
}

// ---------------------------------------------------------------- invariants ---

function verifyCluster(result) {
  const checks = [];
  const positions = result.finalPositions;
  const cap = result.maxPeers;
  const drop = result.dropRadius;

  // degree cap
  const overCap = [...result.perUser].some((value) => cap !== 0 && value > cap);
  checks.push({
    name: 'degree <= cap (both endpoints)',
    ok: !overCap,
    detail: `max ${result.maxDegree}, cap ${cap === 0 ? 'unlimited' : cap}`,
  });

  // edge distance <= drop radius
  let worst = 0;
  let beyondDrop = null;
  for (const record of result.edgePairs.values()) {
    const a = positions.get(record.a);
    const b = positions.get(record.b);
    if (!a || !b) continue;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    worst = Math.max(worst, distance);
    if (distance > drop + 0.001) beyondDrop = `${record.a.slice(0, 5)}<->${record.b.slice(0, 5)} at ${distance.toFixed(1)} px`;
  }
  checks.push({
    name: `no edge beyond drop radius (${drop} px)`,
    ok: !beyondDrop,
    detail: beyondDrop ?? `worst edge ${worst.toFixed(1)} px`,
  });

  // one initiator per edge, same generation on both ends, exactly two events
  let edgeShapeError = null;
  for (const record of result.edgePairs.values()) {
    if (record.events !== 2) edgeShapeError = `pair ${record.a.slice(0, 5)}<->${record.b.slice(0, 5)} got ${record.events} connect events`;
    if (record.endpoints !== 2) edgeShapeError = `pair ${record.a.slice(0, 5)}<->${record.b.slice(0, 5)} reached ${record.endpoints} endpoint(s)`;
    if (record.initiators !== 1) edgeShapeError = `pair ${record.a.slice(0, 5)}<->${record.b.slice(0, 5)} has ${record.initiators} initiators`;
    if (record.a === record.b) edgeShapeError = 'self edge';
  }
  checks.push({
    name: 'one initiator + one generation per edge',
    ok: !edgeShapeError,
    detail: edgeShapeError ?? `${result.edgePairs.size} live edges, one initiator and one shared generation each`,
  });

  // duplicate / cross-room: every endpoint id belongs to this run, each pair once
  const known = new Set(result.clientIds);
  const unknown = [...result.edgePairs.values()].some((record) => !known.has(record.a) || !known.has(record.b));
  checks.push({
    name: 'no duplicate / self / cross-room edge',
    ok: !unknown,
    detail: unknown ? 'an edge referenced an id outside this run' : 'all endpoints belong to this room run',
  });

  return checks;
}

// ------------------------------------------------------------------- runners ---

function makeEmbeddedRunner({ redisUrl, keyPrefix, maxPeers, dropRadius, baseRoom }) {
  const nodes = [];
  const urls = [];
  let backing = null;

  return {
    urls,
    async start() {
      backing = createSharedClusterBacking({ roomIds: [] });
      const count = redisUrl ? 2 : 1;
      for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        const node = await startClusterNode({
          instanceId: `mesh-${index}-${Math.random().toString(36).slice(2, 7)}`,
          redisUrl,
          keyPrefix,
          backing,
          proximity: {
            radiusPx: CONNECT_RADIUS,
            peerDisconnectRadiusPx: dropRadius,
            maxPeersPerUser: maxPeers,
          },
          logger: { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } },
        });
        nodes.push(node);
        urls.push(node.baseUrl);
      }
      return this;
    },
    ensureRoom(roomId) {
      backing.rooms.addRoom(roomId);
    },
    async counters() {
      return nodes.map((node) => ({
        instanceId: node.cfg.server.instanceId,
        ...(node.io.peerGraph?.meshStats?.() ?? {}),
      }));
    },
    async stop() {
      if (redisUrl && nodes[0]?.redis?.enabled) {
        const keys = await nodes[0].io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
        if (keys.length) await nodes[0].redis.storeClient.del(...keys).catch(() => {});
      }
      for (const node of nodes) {
        // eslint-disable-next-line no-await-in-loop
        await node.close().catch(() => {});
      }
      for (const roomId of [...(backing?.rooms ? [] : [])]) backing.rooms.removeRoom(roomId);
      if (baseRoom && backing) backing.rooms.removeRoom(baseRoom);
    },
  };
}

function makeExternalRunner(urls) {
  return {
    urls,
    async start() { return this; },
    ensureRoom() {},
    async counters() { return []; },
    async stop() {},
  };
}

async function runConfigSuite({ label, maxPeers, dropRadius, redisUrl, keyPrefix, targetUrls = null, roomId, table }) {
  const runner = targetUrls
    ? makeExternalRunner(targetUrls)
    : await makeEmbeddedRunner({ redisUrl, keyPrefix, maxPeers, dropRadius, baseRoom: roomId }).start();

  const countersBefore = await runner.counters();
  const checks = [];
  try {
    for (const n of [10, 20, 50]) {
      const runRoom = targetUrls ? roomId : `${roomId}-${n}`;
      if (!targetUrls) runner.ensureRoom(runRoom);
      // eslint-disable-next-line no-await-in-loop
      const result = await measureTightCluster({ n, urls: runner.urls, roomId: runRoom, maxPeers, dropRadius });
      checks.push(...verifyCluster(result).map((check) => ({ ...check, scenario: `N=${n}` })));
      checks.push({
        scenario: `N=${n}`,
        name: 'joined publishes maxPeers + peerDisconnectRadiusPx',
        ok: result.joined.every((payload) => payload.maxPeers === maxPeers && payload.peerDisconnectRadiusPx === dropRadius),
        detail: `maxPeers=${result.joined[0]?.maxPeers}, peerDisconnectRadiusPx=${result.joined[0]?.peerDisconnectRadiusPx}`,
      });
      table.push({
        config: label,
        scenario: `N=${n}`,
        users: n,
        maxDegree: result.maxDegree,
        meanDegree: result.meanDegree,
        edges: result.edges,
        connectEvents: result.connectEvents,
        disconnectEvents: result.disconnectEvents,
        signalsRelayed: result.signalsRelayed,
        signalsAttempted: result.signalsAttempted,
        drops: result.signalDrops,
        settleMs: result.settleMs,
        ok: (maxPeers === 0 || result.maxDegree <= maxPeers) && result.signalDrops === 0,
      });
    }

    const boundaryRoom = targetUrls ? roomId : `${roomId}-boundary`;
    if (!targetUrls) runner.ensureRoom(boundaryRoom);
    const boundary = await measureBoundary({ urls: runner.urls, roomId: boundaryRoom, dropRadius });
    checks.push({
      scenario: 'boundary',
      name: 'first edge appears only at <= 100 px',
      ok: boundary.firstConnectDistance !== null
        && boundary.firstConnectDistance <= CONNECT_RADIUS
        && boundary.firstConnectDistance >= CONNECT_RADIUS - 12,
      detail: boundary.firstConnectDistance === null
        ? 'no edge was created during the approach'
        : `first connect at ${boundary.firstConnectDistance} px from the peer`,
    });
    checks.push({
      scenario: 'boundary',
      name: `100 boundary crossings (drop ${dropRadius} px)`,
      ok: dropRadius > CONNECT_RADIUS ? boundary.jitterDisconnects === 0 : boundary.jitterDisconnects > 10,
      detail: `jitter connects=${boundary.jitterConnects}, disconnects=${boundary.jitterDisconnects}`,
    });

    return {
      label,
      maxPeers,
      dropRadius,
      urls: [...runner.urls],
      boundary,
      checks,
      counters: countersBefore.length ? { before: countersBefore, after: await runner.counters() } : null,
    };
  } finally {
    await runner.stop();
  }
}

// ---------------------------------------------------------------------- main ---

function parseArgs(argv) {
  const parsed = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) {
      parsed[raw.slice(2)] = true;
      continue;
    }
    parsed[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return parsed;
}

export async function runMeshCheck({ argv = process.argv.slice(2), logger: output = log } = {}) {
  const args = parseArgs(argv);
  const externalUrl = typeof args.url === 'string' ? args.url : null;
  const externalA = typeof args.urlA === 'string' ? args.urlA : null;
  const externalB = typeof args.urlB === 'string' ? args.urlB : null;
  const redisUrl = typeof args.redis === 'string' ? args.redis : config.redis.url;
  const maxPeers = args.maxPeers !== undefined ? Number(args.maxPeers) : config.proximity.maxPeersPerUser;
  const dropRadius = args.dropRadius !== undefined ? Number(args.dropRadius) : config.proximity.peerDisconnectRadiusPx;
  const roomSeed = typeof args.room === 'string'
    ? args.room
    : `meshcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const keyPrefix = `meshcheck_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

  const external = Boolean(externalUrl || externalA);
  const targetUrls = external ? [externalUrl ?? externalA, externalB].filter(Boolean) : [];

  for (const url of targetUrls) {
    // eslint-disable-next-line no-await-in-loop
    const status = await health(url);
    if (!status || status.status !== 'ok') {
      throw new Error(`no healthy ProxiSpeak server at ${redactUrl(url)} (GET /health failed)`);
    }
  }

  const table = [];
  const after = await runConfigSuite({
    label: external
      ? `after (cap ${maxPeers}, drop ${dropRadius})`
      : `after (cap ${maxPeers}, drop ${dropRadius})`,
    maxPeers,
    dropRadius,
    redisUrl,
    keyPrefix: `${keyPrefix}_after`,
    targetUrls: external ? targetUrls : null,
    roomId: `${roomSeed}-after`,
    table,
  });
  const before = await runConfigSuite({
    label: 'before (unlimited, drop = radius)',
    maxPeers: 0,
    dropRadius: CONNECT_RADIUS,
    redisUrl,
    keyPrefix: `${keyPrefix}_before`,
    roomId: `${roomSeed}-before`,
    table,
  });

  const rowsOf = (label) => table.filter((row) => row.config === label);
  const afterRows = rowsOf(after.label);
  const beforeRows = rowsOf(before.label);
  const checks = [...after.checks, ...before.checks].map((check, index) => ({
    ...check,
    config: index < after.checks.length ? after.label : before.label,
  }));

  checks.push({
    config: 'cross-config',
    scenario: 'jitter',
    name: 'hysteresis removes boundary churn',
    ok: after.boundary.jitterDisconnects === 0
      && before.boundary.jitterDisconnects > after.boundary.jitterDisconnects,
    detail: `drop ${after.dropRadius} px -> ${after.boundary.jitterDisconnects} disconnect(s); `
      + `drop ${before.dropRadius} px -> ${before.boundary.jitterDisconnects} disconnect(s)`,
  });

  const cap10 = afterRows.find((row) => row.users === 10);
  const cap50 = afterRows.find((row) => row.users === 50);
  const noCap10 = beforeRows.find((row) => row.users === 10);
  const noCap50 = beforeRows.find((row) => row.users === 50);
  checks.push({
    config: 'cross-config',
    scenario: 'cap',
    name: 'cap bounds the mesh (after < before)',
    ok: cap10.maxDegree <= maxPeers
      && cap50.maxDegree <= maxPeers
      && cap50.edges < noCap50.edges
      && noCap50.edges === (50 * 49) / 2
      && noCap10.edges === (10 * 9) / 2
      && noCap50.maxDegree === 49,
    detail: `N=10 edges ${cap10.edges} vs ${noCap10.edges}; N=50 edges ${cap50.edges} vs ${noCap50.edges}; `
      + `max degree ${cap50.maxDegree} vs ${noCap50.maxDegree}`,
  });
  checks.push({
    config: 'cross-config',
    scenario: 'signals',
    name: 'no signal dropped at the default burst',
    ok: [...afterRows, ...beforeRows].every((row) => row.drops === 0),
    detail: `relayed ${[...afterRows, ...beforeRows].reduce((sum, row) => sum + row.signalsRelayed, 0)}`
      + `/${[...afterRows, ...beforeRows].reduce((sum, row) => sum + row.signalsAttempted, 0)} candidates`,
  });

  const ok = checks.every((check) => check.ok);

  const lines = [];
  lines.push('ProxiSpeak Mesh Check (Day 13)');
  lines.push(`mode: ${external
    ? 'external servers'
    : redisUrl
      ? `embedded, 2 instances + Redis (${redactUrl(redisUrl)})`
      : 'embedded, 1 instance, in-memory store'}`);
  lines.push(`targets: ${(external ? targetUrls : after.urls).map(redactUrl).join(' , ')}`);
  lines.push(`config: PROXIMITY_RADIUS_PX=${CONNECT_RADIUS} PEER_DISCONNECT_RADIUS_PX=${dropRadius} MAX_PEERS_PER_USER=${maxPeers}`);
  lines.push('');
  lines.push('Connections per user and total edges (tight cluster, every pair <= 100 px)');
  lines.push('config                             N   max  mean   edges  connect ev  signals  drops  settle  status');
  lines.push('-'.repeat(104));
  for (const row of table) {
    lines.push(
      `${row.config.padEnd(32)} ${String(row.users).padStart(3)}  ${String(row.maxDegree).padStart(4)}  ${String(row.meanDegree).padStart(4)}  `
      + `${String(row.edges).padStart(6)}  ${String(row.connectEvents).padStart(10)}  ${`${row.signalsRelayed}/${row.signalsAttempted}`.padStart(7)}  `
      + `${String(row.drops).padStart(5)}  ${String(row.settleMs).padStart(6)}  ${row.ok ? 'PASS' : 'FAIL'}`,
    );
  }
  lines.push('');
  lines.push('Boundary: approach + 100 crossings of the 100 px edge');
  lines.push(`  after  drop=${after.dropRadius}px: first connect at ${after.boundary.firstConnectDistance ?? 'n/a'} px; `
    + `jitter connects=${after.boundary.jitterConnects}, disconnects=${after.boundary.jitterDisconnects}`);
  lines.push(`  before drop=${before.dropRadius}px: first connect at ${before.boundary.firstConnectDistance ?? 'n/a'} px; `
    + `jitter connects=${before.boundary.jitterConnects}, disconnects=${before.boundary.jitterDisconnects}`);
  lines.push('');
  lines.push('Invariants and checks');
  for (const check of checks) {
    lines.push(`  ${`[${check.config}] ${check.scenario} ${check.name}`.padEnd(86)} ${check.ok ? 'PASS' : 'FAIL'}  ${check.detail}`);
  }
  if (after.counters) {
    lines.push('');
    lines.push('Per-instance mesh counters (after suite)');
    for (const counter of after.counters.after) {
      lines.push(`  ${counter.instanceId}: edgesCreated=${counter.edgesCreated ?? 0} `
        + `edgesRemoved=${counter.edgesRemoved ?? 0} cappedRejections=${counter.cappedRejections ?? 0} `
        + `hysteresisHolds=${counter.hysteresisHolds ?? 0}`);
    }
  }
  lines.push('');
  lines.push('drops = signals not delivered within 4 s; the gateway drops a rate-limited signal silently.');
  lines.push('settle = join + walk to the target + 700 ms with no edge event (wall clock).');
  lines.push(`RESULT: ${ok ? 'PASS' : 'FAIL'} (${checks.filter((check) => check.ok).length}/${checks.length} checks passed)`);
  lines.push('Note: embedded mode needs no MongoDB — presence/rooms are the Day 12 in-memory harness; '
    + 'sockets, gateway, PeerGraph, EdgeStore and Redis are real.');

  for (const line of lines) {
    if (ok) output.info(line);
    else output.error(line);
  }

  return { ok, checks, table, suites: { after, before }, lines };
}

const invokedDirectly = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('server/scripts/mesh-check.js');

if (invokedDirectly) {
  runMeshCheck()
    .then((report) => process.exit(report.ok ? 0 : 1))
    .catch((err) => {
      log.error(`mesh-check failed: ${err?.message ?? err}`);
      process.exit(1);
    });
}
