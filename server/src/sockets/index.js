/**
 * Socket.io gateway (Day 3).
 *
 * The realtime channel is attached to the *existing* HTTP server, so it shares
 * the Express port and the `/health` endpoint keeps working untouched.
 *
 * Event contract (every inbound payload is validated server-side):
 *   C -> S  join     { roomId, name }   S -> C  joined     { selfId, room, users }
 *   C -> S  move     { x, y }           S -> C  user:moved { id, x, y }
 *   (socket disconnects)                S -> C  user:left  { id }
 *   other clients in the room           S -> C  user:joined { id, name, x, y }
 *   any rejection                       S -> C  error       { code, message, field? }
 *
 * Payloads carry ids, names and pixels only — never a connection string, a
 * document `_id` or any other database detail.
 */
import { Server } from 'socket.io';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { describeCorsOrigin, socketCorsOrigin, socketAllowRequest } from '../utils/origin.js';
import { createGeoTransform } from '../utils/geo.js';
import { TokenBucket } from '../utils/rateLimiter.js';
import { validateJoinPayload, validateMovePayload } from './validation.js';
import * as presenceStore from '../services/presenceStore.js';
import * as roomService from '../services/roomService.js';

/** Deterministic colour for avatars: the Day 3 `join` payload carries a name only. */
const DEFAULT_AVATAR_COLOR = '#4f8cff';

/**
 * @param {object} options
 * @param {import('node:http').Server} options.httpServer the server Express already uses
 * @param {object} [options.config] config override
 * @param {object} [options.logger] logger override
 * @param {object} [options.presence] presence store override (defaults to the Day 2 store)
 * @param {object} [options.rooms] room service override (defaults to the Day 2 service)
 * @returns {import('socket.io').Server}
 */
export function createSocketServer({
  httpServer,
  config: cfg = config,
  logger: log = logger,
  presence = presenceStore,
  rooms = roomService,
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

  // One transform per process: the room is a flat pixel plane, MongoDB wants
  // GeoJSON, and both must always agree.
  const geo = createGeoTransform(cfg.world);

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

  /**
   * Wait for every presence cleanup the gateway has started. Call it after
   * `io.close()` and before the database connection is closed: otherwise the
   * documents of the clients that were connected are cut off mid-delete and
   * stay behind as ghosts.
   */
  io.drainSessions = async () => {
    // Looping (not a single pass) also covers a cleanup that starts while an
    // earlier one is being awaited.
    while (pendingCleanups.size) await Promise.allSettled([...pendingCleanups]);
  };

  io.on('connection', (socket) => registerHandlers(socket, { io, cfg, log, presence, rooms, geo, track }));

  log.info(`Socket.io attached to the HTTP server (CORS: ${describeCorsOrigin(cfg)})`);
  return io;
}

function registerHandlers(socket, ctx) {
  const { cfg, log, presence, rooms, geo, track } = ctx;
  // Captured once: the id is this connection's identity everywhere (presence
  // documents, broadcasts, room membership) and Socket.io clears it the moment
  // the connection drops, which is far too late for cleanup.
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

  /**
   * Every handler runs through here, so one malformed payload can never take
   * the process down: validation errors become a documented `error` event and
   * unexpected failures are logged (message only, never the payload) and
   * answered with a generic code.
   */
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

  // ------------------------------------------------------------------ join ---
  socket.on(
    'join',
    guard('join', async (payload) => {
      const { roomId, name } = validateJoinPayload(payload);

      // Joins are serialised per socket. `session` is only set once the presence
      // write has been awaited, so a second `join` that arrives before the first
      // one finished (a double-click, or a client that re-sends while the first
      // reply is still in flight) would otherwise run the whole join path again —
      // two presence writes and two `user:joined` broadcasts for one avatar.
      while (joinInFlight) await joinInFlight.catch(() => {});

      // A repeated join for the room this socket is already in is a no-op apart
      // from a fresh snapshot: no second presence document, no second
      // `user:joined` for the people already inside.
      if (session && session.roomId === roomId) {
        const users = await snapshotUsers(presence, roomId);
        socket.emit('joined', buildJoined(clientId, session.room, users));
        socketLog.debug(`duplicate join ignored (already in "${roomId}")`);
        return;
      }

      // One socket owns one room. Switching rooms means reconnecting, so a
      // stray join can never leave a presence document behind in a room the
      // socket no longer belongs to.
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

    // Presence first: a user that is broadcast to the room but missing from
    // the database would be an invisible ghost on the next join.
    await presence.upsertPosition(user, geo);

    // The socket can disappear while that write is in flight. Its disconnect
    // handler ran before `session` existed, so it had nothing to clean up: undo
    // the row here, where it is still visible. (No await between this check and
    // the assignment below, so the disconnect handler cannot slip in either.)
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
    await socket.join(roomId);

    socket.to(roomId).emit('user:joined', { id: user.id, name: user.name, x: user.x, y: user.y });

    const users = await snapshotUsers(presence, roomId);
    socket.emit('joined', buildJoined(clientId, room, users));
    socketLog.info(`joined "${roomId}" as "${name}" (${users.length} in room)`);
  }

  // ------------------------------------------------------------------ move ---
  socket.on(
    'move',
    guard('move', async (payload) => {
      if (!session) {
        throw new AppError('join a room before sending move events', { code: 'not_joined', status: 409 });
      }

      // Rate limiting runs before any database work. Throttled events are
      // dropped silently on purpose: answering a flood with an error per event
      // would amplify the very traffic the limit exists to stop.
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
      const user = { ...current.user }; // immutable payload for this accepted move
      await queuePresenceWrite(async () => {
        if (socket.disconnected || session !== current) return;
        try {
          await presence.upsertPosition(user, geo);
        } catch (err) {
          socketLog.error('position persist failed:', err?.message ?? err);
        }
        if (socket.disconnected || session !== current) return;
        socket.to(current.roomId).emit('user:moved', { id: clientId, x, y });
      });
    }),
  );

  // ------------------------------------------------------------ disconnect ---
  /**
   * Release everything this socket owns: the peers' view of it, its room
   * membership and its presence document.
   *
   * Safe to call at any time — a socket that never joined, or whose presence
   * was already removed, is a no-op — and scoped to `clientId`, so a socket
   * that reconnects (new id, brand new document) is never cleaned up by the
   * teardown of the connection it replaced.
   */
  async function releaseSession(reason) {
    if (!session) return;
    const { roomId } = session;
    session = null;

    // Peers first, while the room channel is unambiguous, then the channel and
    // finally this socket's own document.
    socket.to(roomId).emit('user:left', { id: clientId });

    try {
      await Promise.resolve(socket.leave(roomId));
    } catch {
      /* the adapter already dropped the membership */
    }

    // A write already in flight may still upsert. Delete only after it ends.
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
    // The socket is already gone at this point, so the broadcast targets the
    // room's remaining members and the delete is a no-op when nothing is left.
    // Tracked, so a shutdown waits for this delete instead of cutting it off.
    track(
      releaseSession(`disconnect: ${reason}`).catch((err) =>
        socketLog.error('disconnect cleanup failed:', err?.message ?? err),
      ),
    );
  });
  socket.on('error', (err) => socketLog.error('socket error:', err?.message ?? err));
}

// ------------------------------------------------------------- wire format ---

/** The `joined` reply: who you are, the room blueprint and everybody inside. */
const buildJoined = (selfId, room, users) => ({ selfId, room: toRoomPayload(room), users });

/**
 * Room dimensions + obstacles, whitelisted field by field. Spawn points and
 * document internals stay on the server; collision/occlusion logic does not
 * exist yet, so obstacles are shipped as data only.
 */
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

/** Presence rows -> the minimal `{ id, name, x, y }` list the client needs. */
async function snapshotUsers(presence, roomId) {
  const rows = await presence.listPresenceByRoom(roomId);
  return rows.map((row) => ({ id: row.sessionId, name: row.name, x: row.x, y: row.y }));
}

/**
 * Spawn on the point furthest away from the users already inside, so two
 * clients never stack on the same pixel. Deterministic: ties keep the first
 * point, and a room without spawn points falls back to its centre.
 */
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
