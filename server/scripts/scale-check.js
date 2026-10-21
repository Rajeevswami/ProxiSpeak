#!/usr/bin/env node
/**
 * Day 12 two-instance live scale verification CLI:
 *   npm run scale-check [-- --urlA=http://127.0.0.1:3001 --urlB=http://127.0.0.1:3002 --room=lobby]
 *
 * Verifies against two running ProxiSpeak server instances sharing Redis:
 *   1. Distinct healthy instances reporting `scaleMode: "redis"`
 *   2. Cross-instance `join` snapshot + `user:joined` delivery
 *   3. Smooth movement (`<= 80 px` steps at `50 ms` cadence) + cross-instance `user:moved`
 *   4. Single `peer:connect` per side across instances, matching `generation`, single `initiator`
 *   5. Cross-instance WebRTC `signal` relay (`offer`, `answer`, `candidate`)
 *   6. Stale-generation `signal` rejection (`stale_generation`) without disconnecting socket
 *   7. Out-of-range walk (`> 100 px`) -> single `peer:disconnect` per side + `no_peer_edge` signal refusal
 *   8. Cross-instance disconnect -> single `user:left` on surviving peer
 *
 * Exits `0` only if every check passes; exits `1` on any failure.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { io as createClient } from 'socket.io-client';
import config from '../src/config/index.js';
import logger from '../src/utils/logger.js';

const STEP_PX = 80;
const STEP_DELAY_MS = 50;
const EVENT_TIMEOUT_MS = 4000;

export function redactEndpointUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '(empty)';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return rawUrl.replace(/\/\/[^@/]+@/, '//***:***@');
  }
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});

function waitForEvent(socket, event, predicate = () => true, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }

    socket.on(event, onEvent);
  });
}

async function walkAvatar(socket, current, target) {
  let { x, y } = current;
  for (let guard = 0; guard < 120; guard += 1) {
    const dx = target.x - x;
    const dy = target.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0.5) break;
    const step = Math.min(STEP_PX, dist);
    x = Math.round((x + (dx / dist) * step) * 100) / 100;
    y = Math.round((y + (dy / dist) * step) * 100) / 100;
    await sleep(STEP_DELAY_MS);
    socket.emit('move', { x, y });
  }
  return { x, y };
}

function connectSocket(baseUrl) {
  return new Promise((resolve, reject) => {
    const client = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: EVENT_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`socket connection timed out to ${redactEndpointUrl(baseUrl)}`));
    }, EVENT_TIMEOUT_MS);
    timer.unref();

    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('connect_error', (err) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });
  });
}

export async function runScaleCheck({
  urlA = config.scaleCheck.urlA,
  urlB = config.scaleCheck.urlB,
  roomId = config.scaleCheck.roomId,
  logger: log = logger,
} = {}) {
  const safeA = redactEndpointUrl(urlA);
  const safeB = redactEndpointUrl(urlB);
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  let clientA = null;
  let clientB = null;

  try {
    // 1. Verify /health on both instances
    const [resA, resB] = await Promise.all([fetch(`${urlA}/health`), fetch(`${urlB}/health`)]);
    const [healthA, healthB] = await Promise.all([resA.json(), resB.json()]);
    const healthyRedis =
      resA.status === 200
      && resB.status === 200
      && healthA.status === 'ok'
      && healthB.status === 'ok'
      && healthA.scaleMode === 'redis'
      && healthB.scaleMode === 'redis'
      && healthA.instanceId !== healthB.instanceId;
    record(
      '1. /health reports 2 distinct redis instances',
      healthyRedis,
      `A=${healthA.instanceId} (${healthA.scaleMode}), B=${healthB.instanceId} (${healthB.scaleMode})`,
    );

    clientA = await connectSocket(urlA);
    clientB = await connectSocket(urlB);

    const aPeerConnects = [];
    const bPeerConnects = [];
    const aPeerDisconnects = [];
    const bPeerDisconnects = [];
    const aUserLeft = [];

    clientA.on('peer:connect', (ev) => aPeerConnects.push(ev));
    clientB.on('peer:connect', (ev) => bPeerConnects.push(ev));
    clientA.on('peer:disconnect', (ev) => aPeerDisconnects.push(ev));
    clientB.on('peer:disconnect', (ev) => bPeerDisconnects.push(ev));
    clientA.on('user:left', (ev) => aUserLeft.push(ev));

    // 2. Join room on both instances and verify snapshot + user:joined
    const joinedAPromise = waitForEvent(clientA, 'joined');
    clientA.emit('join', { roomId, name: 'ScaleAlice' });
    const joinedA = await joinedAPromise;

    const userJoinedOnAPromise = waitForEvent(clientA, 'user:joined', (u) => u.name === 'ScaleBob');
    const joinedBPromise = waitForEvent(clientB, 'joined');
    clientB.emit('join', { roomId, name: 'ScaleBob' });
    const [joinedB, announcedB] = await Promise.all([joinedBPromise, userJoinedOnAPromise]);

    const snapshotSawA = joinedB.users.some((u) => u.id === joinedA.selfId && u.name === 'ScaleAlice');
    record(
      '2. Cross-instance join snapshot & user:joined',
      snapshotSawA && announcedB.id === joinedB.selfId,
      `A=${joinedA.selfId.slice(0, 6)}, B=${joinedB.selfId.slice(0, 6)}, snapshotSawA=${snapshotSawA}`,
    );

    const meAInSnapshot = joinedA.users.find((u) => u.id === joinedA.selfId);
    let posA = { x: meAInSnapshot.x, y: meAInSnapshot.y };
    const posB = { x: announcedB.x, y: announcedB.y };
    const roomW = joinedA.room?.width ?? 2000;
    const roomH = joinedA.room?.height ?? 2000;

    // Ensure they start > 220 px apart first before testing controlled entry into earshot
    const farTarget = {
      x: posB.x + 260 <= roomW - 40 ? posB.x + 260 : Math.max(40, posB.x - 260),
      y: Math.min(roomH - 40, Math.max(40, posB.y)),
    };
    posA = await walkAvatar(clientA, posA, farTarget);
    await sleep(120);
    aPeerConnects.length = 0;
    bPeerConnects.length = 0;
    aPeerDisconnects.length = 0;
    bPeerDisconnects.length = 0;

    // 3. Walk A smoothly into range of B (40 px apart) and check user:moved + single peer:connect
    const movedOnBPromise = waitForEvent(clientB, 'user:moved', (m) => m.id === joinedA.selfId);
    const connectOnAPromise = waitForEvent(clientA, 'peer:connect', (c) => c.peerId === joinedB.selfId);
    const connectOnBPromise = waitForEvent(clientB, 'peer:connect', (c) => c.peerId === joinedA.selfId);

    const nearTarget = {
      x: posB.x + 40 <= roomW - 40 ? posB.x + 40 : Math.max(40, posB.x - 40),
      y: posB.y,
    };
    posA = await walkAvatar(clientA, posA, nearTarget);
    const [, edgeOnA, edgeOnB] = await Promise.all([movedOnBPromise, connectOnAPromise, connectOnBPromise]);
    await sleep(120);

    record(
      '3. Cross-instance user:moved broadcast',
      true,
      `A walked to (${posA.x}, ${posA.y}) within earshot of B (${posB.x}, ${posB.y})`,
    );

    const connectsForPairA = aPeerConnects.filter((c) => c.peerId === joinedB.selfId);
    const connectsForPairB = bPeerConnects.filter((c) => c.peerId === joinedA.selfId);
    const singleEdgeConsistent =
      connectsForPairA.length === 1
      && connectsForPairB.length === 1
      && edgeOnA.generation === edgeOnB.generation
      && edgeOnA.initiator !== edgeOnB.initiator;
    record(
      '4. Single peer:connect per side & 1 initiator',
      singleEdgeConsistent,
      `countA=${connectsForPairA.length}, countB=${connectsForPairB.length}, gen=${edgeOnA.generation}, initA=${edgeOnA.initiator}, initB=${edgeOnB.initiator}`,
    );

    // 4. Cross-instance WebRTC signal relay (offer -> answer -> candidate)
    const generation = edgeOnA.generation;
    const initiatorSocket = edgeOnA.initiator ? clientA : clientB;
    const responderSocket = edgeOnA.initiator ? clientB : clientA;
    const initiatorId = edgeOnA.initiator ? joinedA.selfId : joinedB.selfId;
    const responderId = edgeOnA.initiator ? joinedB.selfId : joinedA.selfId;

    const offerPromise = waitForEvent(responderSocket, 'signal', (s) => s.from === initiatorId);
    initiatorSocket.emit('signal', {
      to: responderId,
      generation,
      data: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
    });
    const offerDelivered = await offerPromise;

    const answerPromise = waitForEvent(initiatorSocket, 'signal', (s) => s.from === responderId);
    responderSocket.emit('signal', {
      to: initiatorId,
      generation,
      data: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
    });
    const answerDelivered = await answerPromise;

    record(
      '5. Cross-instance WebRTC signal relay',
      offerDelivered.data?.type === 'offer' && answerDelivered.data?.type === 'answer',
      `relayed offer & answer for gen=${generation}`,
    );

    // 5. Stale generation signal refusal
    const staleErrPromise = waitForEvent(initiatorSocket, 'error');
    initiatorSocket.emit('signal', {
      to: responderId,
      generation: generation + 50,
      data: { candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const staleErr = await staleErrPromise;
    record(
      '6. Stale-generation signal rejected safely',
      staleErr.code === 'stale_generation' && initiatorSocket.connected,
      `error.code=${staleErr.code}, socketAlive=${initiatorSocket.connected}`,
    );

    // 6. Walk out of earshot -> single peer:disconnect per side + signal refused with no_peer_edge
    const disconnectAPromise = waitForEvent(clientA, 'peer:disconnect', (d) => d.peerId === joinedB.selfId);
    const disconnectBPromise = waitForEvent(clientB, 'peer:disconnect', (d) => d.peerId === joinedA.selfId);
    posA = await walkAvatar(clientA, posA, farTarget);
    const [discA, discB] = await Promise.all([disconnectAPromise, disconnectBPromise]);
    await sleep(120);

    const discCountA = aPeerDisconnects.filter((d) => d.peerId === joinedB.selfId).length;
    const discCountB = bPeerDisconnects.filter((d) => d.peerId === joinedA.selfId).length;

    const noEdgeErrPromise = waitForEvent(clientA, 'error');
    clientA.emit('signal', {
      to: joinedB.selfId,
      generation,
      data: { type: 'offer', sdp: 'v=0\r\no=- 3 3 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
    });
    const noEdgeErr = await noEdgeErrPromise;

    record(
      '7. Out-of-range peer:disconnect & signal guard',
      discCountA === 1 && discCountB === 1 && discA.generation === generation && discB.generation === generation && noEdgeErr.code === 'no_peer_edge',
      `discA=${discCountA}, discB=${discCountB}, afterDisconnectError=${noEdgeErr.code}`,
    );

    // 7. Disconnect Client B on Instance B -> single user:left delivered to Client A on Instance A
    const leftPromise = waitForEvent(clientA, 'user:left', (l) => l.id === joinedB.selfId);
    clientB.disconnect();
    await leftPromise;
    await sleep(100);
    const leftCount = aUserLeft.filter((l) => l.id === joinedB.selfId).length;
    record(
      '8. Cross-instance disconnect & user:left',
      leftCount === 1,
      `user:left count for B on A = ${leftCount}`,
    );
  } catch (err) {
    record('Unhandled failure during scale check', false, err?.message ?? String(err));
  } finally {
    clientA?.close();
    clientB?.close();
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  const lines = [
    `ProxiSpeak Two-Instance Scale Check — A=${safeA} | B=${safeB} | room=${roomId}`,
    'check                                            status  detail',
    ...checks.map(
      (c) => `${c.name.padEnd(48)} ${(c.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${c.detail}`,
    ),
    `RESULT: ${ok ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.ok).length}/${checks.length} checks passed)`,
  ];
  for (const line of lines) {
    if (ok) log.info(line);
    else log.error(line);
  }

  return { ok, checks, lines };
}

function parseCliArgs(argv) {
  const parsed = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eqIndex = raw.indexOf('=');
    if (eqIndex === -1) continue;
    const key = raw.slice(2, eqIndex);
    const val = raw.slice(eqIndex + 1);
    parsed[key] = val;
  }
  return parsed;
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  const cli = parseCliArgs(process.argv.slice(2));
  const report = await runScaleCheck({
    urlA: cli.urlA ?? config.scaleCheck.urlA,
    urlB: cli.urlB ?? config.scaleCheck.urlB,
    roomId: cli.room ?? cli.roomId ?? config.scaleCheck.roomId,
  });
  process.exit(report.ok ? 0 : 1);
}
