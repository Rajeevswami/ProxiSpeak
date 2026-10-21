/**
 * Socket.io gateway (Day 3, multi-instance signaling ready on Day 12).
 *
 * The realtime channel is attached to the *existing* HTTP server, so it shares
 * the Express port and the `/health` endpoint keeps working untouched.
 *
 * Event contract (every inbound payload is validated server-side):
 *   C -> S  join     { roomId, name }   S -> C  joined     { selfId, room, users, iceServers, proximityRadiusPx }
 *   C -> S  move     { x, y }           S -> C  user:moved { id, x, y }
 *   C -> S  signal   { to, generation, data }
 *                                       S -> C  signal     { from, generation, data }
 *   (socket disconnects)                S -> C  user:left  { id }
 *   other clients in the room           S -> C  user:joined { id, name, x, y }
 *   both users of a new edge            S -> C  peer:connect { peerId, name, initiator, generation, iceServers }
 *   both users of a removed edge        S -> C  peer:disconnect { peerId, generation }
 *   any rejection                       S -> C  error       { code, message, field? }
 *
 * Payloads carry ids, names and pixels only — never a connection string, a
 * document `_id` or any other database detail.
 */
import { Server } from 'socket.io';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { describeCorsOrigin, socketCorsOrigin, socketAllowRequest } from '../utils/origin.js';
import { createGeoTransform } from '../utils/geo.js';
import { TokenBucket } from '../utils/rateLimiter.js';
import { isPlainObject } from '../utils/validate.js';
import { validateJoinPayload, validateMovePayload, validateSignalPayload } from './validation.js';
import * as presenceStore from '../services/presenceStore.js';
import * as roomService from '../services/roomService.js';
import { MemoryEdgeStore } from '../services/edgeStore.js';
import { PeerGraph } from '../services/peerGraph.js';
import { findNearby } from '../services/proximityService.js';

/** Deterministic colour for avatars: the Day 3 `join` payload carries a name only. */
const DEFAULT_AVATAR_COLOR = '#4f8cff';

/**
 * @param {object} options
 * @param {import('node:http').Server} options.httpServer the server Express already uses
 * @param {object} [options.config] config override
 * @param {object} [options.logger] logger override
 * @param {object} [options.presence] presence store override (defaults to the Day 2 store)
 * @param {object} [options.rooms] room service override (defaults to the Day 2 service)
 * @param {Function} [options.findNearby] neighbor query override for the peer graph
 * @param {import('../services/edgeStore.js').EdgeStore} [options.edgeStore] optional shared store
 * @param {boolean} [options.multiInstance] whether cross-instance mode is active
 * @returns {import('socket.io').Server}
 */
export function createSocketServer({
  httpServer,
  config: cfg = config,
  logger: log = logger,
  presence = presenceStore,
  rooms = roomService,
  findNearby: neighborQuery = findNearby,
  edgeStore,
  multiInstance = false,
} = {}) {
  if (!httpServer) throw new Error('createSocketServer requires the HTTP server to attach to');

  const io = new Server(httpServer, {
    allowRequest: socketAllowRequest(cfg),
    cors: {
      origin: socketCorsOrigin(cfg),
      methods: ['GET', 'POST'],
    },
    // Every client payload in this protocol is a handful of numbers, so a small
    // cap is plenty and keeps a hostile client from buffering megabytes.
    maxHttpBufferSize: 100_000,
  });

  io.multiInstance = Boolean(multiInstance);

  // One transform per process: the room is a flat pixel plane, MongoDB wants
  // GeoJSON, and both must always agree.
  const geo = createGeoTransform(cfg.world);

  if (cfg.iceServersWarning) log.warn(cfg.iceServersWarning);

  const store = edgeStore ?? new MemoryEdgeStore();
  const resolvePeerName = async (roomId, userId) => {
    const localName = io.sockets.sockets.get(userId)?.data.name;
    if (localName) return localName;
    if (typeof presence.listPresenceByRoom === 'function') {
      const rows = await presence.listPresenceByRoom(roomId);
      const match = rows.find((row) => row.sessionId === userId);
      if (match?.name) return match.name;
    }
    return '';
  };

  const peers = new PeerGraph({
    findNearby: neighborQuery,
    radiusPx: cfg.proximity.radiusPx,
    edgeStore: store,
    allowRemotePeers: io.multiInstance,
    resolvePeerName,
    logger: log.child('peer-graph'),
  });

  const peerName = (roomId, userId) =>
    io.sockets.sockets.get(userId)?.data.name ?? peers.nameOf(roomId, userId);

  peers.setListeners({
    onEdgeAdded: (edge) => {
      for (const [recipient, peerId] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        io.to(recipient).emit('peer:connect', {
          peerId,
          name: peerName(edge.roomId, peerId),
          initiator: edge.initiator === recipient,
          generation: edge.generation,
          iceServers: cfg.iceServers,
        });
      }
    },
    onEdgeRemoved: (edge) => {
      for (const [recipient, peerId] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        io.to(recipient).emit('peer:disconnect', { peerId, generation: edge.generation });
      }
    },
  });

  // Exposed for tests/diagnostics and for presence/orphan sweeps.
  io.peerGraph = peers;
  io.edgeStore = store;
  io.removePeerEdges = (roomId, userId) => peers.leave(roomId, userId);

  /**
   * Presence cleanups that have started but not finished. Sockets disconnect
   * while `io.close()` runs and the cleanup is an asynchronous database write,
   * so a shutdown has to be able to wait for them — see `io.drainSessions`.
   */
  const pendingCleanups = new Set();
  const track = (promise) => {
    pendingCleanups.add(promise);
    const done = () => pendingCleanups.delete(promise);
    promise.then(done, done);
    return promise;
  };

  io.drainSessions = async () => {
    while (pendingCleanups.size) await Promise.allSettled([...pendingCleanups]);
  };

  io.on('connection', (socket) => registerHandlers(socket, { io, cfg, log, presence, rooms, geo, track, peers }));

  log.info(`Socket.io attached to the HTTP server (CORS: ${describeCorsOrigin(cfg)})`);
  return io;
}

function registerHandlers(socket, ctx) {
  const { io, cfg, log, presence, rooms, geo, track, peers } = ctx;
  const clientId = socket.id;
  const socketLog = log.child(clientId.slice(0, 6));

  /** This socket's presence: null until it has joined a room successfully. */
  let session = null;
  /** The join this socket is currently processing, if any (see the handler). */
  let joinInFlight = null;
  // Serialize writes per connection: old moves must not land after newer moves
  // or recreate a row after disconnect has deleted it. Drain on shutdown too.
  let presenceWrites = Promise.resolve();
  const queuePresenceWrite = (operation) => {
    const next = presenceWrites.then(operation);
    presenceWrites = next.catch(() => {});
    return track(next);
  };

  const fail = (code, message, field) =>
    socket.emit('error', field ? { code, message, field } : { code, message });

  const guard = (event, handler) => async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        socketLog.debug(`${event} rejected: ${err.message}`);
        fail(err.code, err.message, err.details?.field);
        return;
      }
      socketLog.error(`${event} failed:`, err?.message ?? err);
      fail('server_error', 'the server could not process that request');
    }
  };

  // Reuse Engine.IO's heartbeat, including idle clients, without a new event.
  socket.conn.on('packet', (packet) => {
    if (packet.type !== 'pong' || !session || !presence.refreshLastSeen) return;
    const current = session;
    const now = Date.now();
    current.user.lastSeen = now;
    queuePresenceWrite(async () => {
      if (socket.disconnected || session !== current) return;
      await presence.refreshLastSeen(clientId, current.roomId, cfg.server.instanceId, now);
    }).catch((err) => socketLog.error('heartbeat persist failed:', err?.message ?? err));
  });

  socketLog.debug('socket connected');

  // One bucket per socket: a client that floods `move` only starves itself.
  const moveBucket = new TokenBucket({
    capacity: cfg.socket.moveEventsPerSec,
    refillPerSec: cfg.socket.moveEventsPerSec,
  });
  // Signaling gets its own, larger bucket: one offer/answer exchange is a few
  // events, but trickled ICE candidates arrive in bursts.
  const signalBucket = new TokenBucket({
    capacity: cfg.socket.signalBurst,
    refillPerSec: cfg.socket.signalEventsPerSec,
  });

  // ------------------------------------------------------------------ join ---
  socket.on(
    'join',
    guard('join', async (payload) => {
      const { roomId, name } = validateJoinPayload(payload);

      while (joinInFlight) await joinInFlight.catch(() => {});

      if (session && session.roomId === roomId) {
        const users = await snapshotUsers(presence, roomId);
        socket.emit('joined', buildJoined(clientId, session.room, users, cfg.iceServers, cfg.proximity.radiusPx));
        socketLog.debug(`duplicate join ignored (already in "${roomId}")`);
        return;
      }

      if (session) {
        throw new AppError(`this socket already joined "${session.roomId}" — reconnect to join another room`, {
          code: 'already_joined',
          status: 409,
        });
      }

      joinInFlight = track(performJoin({ roomId, name }));
      try {
        await joinInFlight;
      } finally {
        joinInFlight = null;
      }
    }),
  );

  /** The accepted join path: room lookup, spawn, presence, room channel, replies. */
  async function performJoin({ roomId, name }) {
    const room = await rooms.getRoom(roomId);
    if (!room) {
      throw new AppError(
        `room "${roomId}" does not exist — run \`npm run seed\` to create the default rooms`,
        { code: 'room_not_found', status: 404 },
      );
    }

    const occupants = await snapshotUsers(presence, roomId);
    const spawn = chooseSpawn(room, occupants, cfg.world);

    const user = {
      id: clientId,
      roomId,
      name,
      color: DEFAULT_AVATAR_COLOR,
      avatar: 'circle',
      x: spawn.x,
      y: spawn.y,
      angle: 0,
      instanceId: cfg.server.instanceId,
      lastSeen: Date.now(),
    };

    await presence.upsertPosition(user, geo);

    if (socket.disconnected) {
      await track(
        presence
          .removeUser(clientId)
          .catch((err) => socketLog.error('aborted join cleanup failed:', err?.message ?? err)),
      );
      socketLog.debug('join aborted: the socket disconnected while joining');
      return;
    }

    session = { roomId, room, user };
    socket.data.roomId = roomId;
    socket.data.name = user.name;
    await socket.join(roomId);

    socket.to(roomId).emit('user:joined', { id: user.id, name: user.name, x: user.x, y: user.y });

    const currentSession = session;
    const users = await snapshotUsers(presence, roomId);
    if (socket.disconnected || session !== currentSession) return;
    for (const entry of users) {
      if (entry.id !== clientId && entry.name) peers.rememberPeerName(roomId, entry.id, entry.name);
    }
    socket.emit('joined', buildJoined(clientId, room, users, cfg.iceServers, cfg.proximity.radiusPx));

    try {
      await peers.join(roomId, clientId, { name: user.name });
    } catch (err) {
      socketLog.error('peer graph join failed:', err?.message ?? err);
    }
    socketLog.info(`joined "${roomId}" as "${name}" (${users.length} in room)`);
  }

  // ------------------------------------------------------------------ move ---
  socket.on(
    'move',
    guard('move', async (payload) => {
      if (socket.data.presenceExpired) {
        throw new AppError('presence expired; reconnect and join again', { code: 'session_expired', status: 409 });
      }
      if (!session) {
        throw new AppError('join a room before sending move events', { code: 'not_joined', status: 409 });
      }

      if (!moveBucket.take()) {
        socketLog.debug('move dropped (rate limit)');
        return;
      }

      const { x, y, limited, outOfBounds } = validateMovePayload(payload, {
        room: session.room,
        previous: session.user,
        maxStepPx: cfg.socket.maxStepPx,
      });
      if (limited || outOfBounds) {
        socketLog.debug(`move adjusted (bounds=${outOfBounds}, step=${limited})`);
      }

      session.user.x = x;
      session.user.y = y;
      session.user.lastSeen = Date.now();

      const current = session;
      const user = { ...current.user };
      await queuePresenceWrite(async () => {
        if (socket.disconnected || session !== current) return;
        if (socket.data.presenceExpired) {
          throw new AppError('presence expired; reconnect and join again', { code: 'session_expired', status: 409 });
        }
        let result;
        try {
          result = await presence.upsertPosition(user, geo, { upsert: false });
        } catch (err) {
          socketLog.error('position persist failed:', err?.message ?? err);
        }
        if (result?.matchedCount === 0) {
          socket.data.presenceExpired = true;
          throw new AppError('presence expired; reconnect and join again', { code: 'session_expired', status: 409 });
        }
        if (socket.disconnected || session !== current) return;
        try {
          await peers.sync(current.roomId, clientId);
        } catch (err) {
          socketLog.error('peer graph sync failed:', err?.message ?? err);
        }
        if (socket.disconnected || session !== current) return;
        socket.to(current.roomId).emit('user:moved', { id: clientId, x, y });
      });
    }),
  );

  // ---------------------------------------------------------------- signal ---
  socket.on(
    'signal',
    guard('signal', async (payload) => {
      if (socket.data.presenceExpired) {
        throw new AppError('presence expired; reconnect and join again', { code: 'session_expired', status: 409 });
      }
      if (!session) {
        throw new AppError('join a room before sending signaling messages', { code: 'not_joined', status: 409 });
      }
      if (!signalBucket.take()) {
        socketLog.debug('signal dropped (rate limit)');
        return;
      }

      if (isPlainObject(payload) && payload.from !== undefined && payload.from !== clientId) {
        throw new ValidationError('"from" cannot impersonate another session', { field: 'from' });
      }

      const { to, generation, data } = validateSignalPayload(payload);

      // Relay only along a live edge in this socket's room validated via EdgeStore.
      const edge = await peers.edgeBetween(session.roomId, clientId, to);
      if (!edge) {
        throw new AppError(`no live peer edge to "${to}" in this room`, {
          code: 'no_peer_edge', status: 409, details: { field: 'to' },
        });
      }
      if (edge.generation !== generation) {
        throw new AppError('that peer edge has been replaced; use the current generation', {
          code: 'stale_generation', status: 409, details: { field: 'generation' },
        });
      }

      const localTarget = io.sockets.sockets.get(to);
      if (!io.multiInstance && (!localTarget?.connected || localTarget.data.roomId !== session.roomId)) {
        throw new AppError(`no live peer edge to "${to}" in this room`, {
          code: 'no_peer_edge', status: 409, details: { field: 'to' },
        });
      }
      if (localTarget && (!localTarget.connected || localTarget.data.roomId !== session.roomId)) {
        throw new AppError(`no live peer edge to "${to}" in this room`, {
          code: 'no_peer_edge', status: 409, details: { field: 'to' },
        });
      }

      // Deliver via socket-id self-room so local and cross-instance targets work identically.
      io.to(to).emit('signal', { from: clientId, generation, data });
    }),
  );

  // ------------------------------------------------------------ disconnect ---
  async function releaseSession(reason) {
    if (!session) return;
    const { roomId } = session;
    session = null;

    try {
      await peers.leave(roomId, clientId);
    } catch (err) {
      socketLog.error('peer graph cleanup failed:', err?.message ?? err);
    }

    if (!socket.data.expiryAnnounced) socket.to(roomId).emit('user:left', { id: clientId });

    try {
      await Promise.resolve(socket.leave(roomId));
    } catch {
      /* the adapter already dropped the membership */
    }

    await presenceWrites;
    try {
      await presence.removeUser(clientId);
    } catch (err) {
      socketLog.error('presence cleanup failed:', err?.message ?? err);
    }

    socketLog.debug(`left "${roomId}" (${reason})`);
  }

  socket.on('disconnect', (reason) => {
    socketLog.debug(`socket disconnected (${reason})`);
    track(
      releaseSession(`disconnect: ${reason}`).catch((err) =>
        socketLog.error('disconnect cleanup failed:', err?.message ?? err),
      ),
    );
  });
  socket.on('error', (err) => socketLog.error('socket error:', err?.message ?? err));
}

// ------------------------------------------------------------- wire format ---

const buildJoined = (selfId, room, users, iceServers, proximityRadiusPx) => ({
  selfId,
  room: toRoomPayload(room),
  users,
  iceServers: iceServers ?? [],
  proximityRadiusPx,
});

function toRoomPayload(room) {
  return {
    roomId: room.roomId,
    name: room.name,
    width: room.width,
    height: room.height,
    obstacles: (room.obstacles ?? []).map((o) => ({
      id: o.id,
      type: o.type,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      blocksAudio: o.blocksAudio !== false,
      attenuation: o.attenuation ?? 0.2,
    })),
  };
}

async function snapshotUsers(presence, roomId) {
  const rows = await presence.listPresenceByRoom(roomId);
  return rows.map((row) => ({ id: row.sessionId, name: row.name, x: row.x, y: row.y }));
}

function chooseSpawn(room, occupants, world) {
  const points = room.spawnPoints?.length ? room.spawnPoints : [{ x: world.width / 2, y: world.height / 2 }];
  let best = points[0];
  if (occupants.length) {
    let bestDistance = -1;
    for (const point of points) {
      const nearest = Math.min(...occupants.map((u) => Math.hypot(u.x - point.x, u.y - point.y)));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = point;
      }
    }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

export default createSocketServer;
