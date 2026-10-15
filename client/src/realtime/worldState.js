/**
 * World state — everything the client knows about the room and the people in
 * it (Week 1). Plain data plus plain functions: no React, no socket, no DOM,
 * so every rule below is unit-tested with `node --test`.
 *
 * The world is a mutable object created once and mutated in place:
 *
 *   room   { roomId, name, width, height, obstacles[] } from `joined`, else null
 *   users  Map<socketId, { id, name, x, y, tx, ty }> — every avatar, self included
 *   selfId this connection's socket id, from `joined.selfId`
 *   epoch  bumped on every applied `joined` snapshot; the movement controller
 *          watches it to drop held keys and stale click targets across a
 *          (re-)join instead of fighting the server-provided positions
 *
 * For a remote avatar `x`/`y` is where it is currently drawn and `tx`/`ty` the
 * last position the server reported, which the render loop glides toward every
 * frame. The local avatar's `x`/`y` is the predicted position.
 *
 * The world deliberately lives in a ref rather than React state: `user:moved`
 * can arrive many times a second and none of those updates may re-render React.
 * The canvas reads this object directly on every animation frame.
 */

export function createWorldState() {
  return {
    room: null,
    users: new Map(),
    selfId: null,
    epoch: 0,
  };
}

/** A position we can actually draw: both coordinates finite numbers. */
const isDrawable = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y);

/**
 * True when the server has acknowledged a join on *this* connection.
 *
 * `joined.selfId` is the socket id the server knows for the connection that
 * joined, so comparing it with the live connection id answers "did this
 * connection complete a join?". That matters right after a reconnect: Socket.io
 * has already set `socket.connected = true` (with a new socket id) while the
 * re-join is still in flight, and a `move` sent in that window is answered with
 * `not_joined`.
 */
export function hasJoinedConnection(world, socketId) {
  return Boolean(world?.selfId && socketId && world.selfId === socketId);
}

/**
 * `user:joined` — somebody walked into the room. Upserts by id, so a repeated
 * announcement can never produce a second avatar; positions come from the
 * server, so a re-announced avatar snaps rather than glides from a stale spot.
 *
 * @returns {boolean} whether the user was stored
 */
export function addUser(world, user) {
  if (!world || typeof user?.id !== 'string' || !isDrawable(user)) return false;
  world.users.set(user.id, {
    id: user.id,
    name: user.name ?? null,
    x: user.x,
    y: user.y,
    tx: user.x,
    ty: user.y,
  });
  return true;
}

/**
 * `user:moved` — a remote avatar reported a new position: only its target
 * moves, the render loop interpolates the drawn position toward it.
 *
 * A move for an id we have never seen creates the entry on the spot: the mover
 * is provably in the room (the server only broadcasts room-scoped moves), so
 * this is the recovery path for a user who joined while our own join was in
 * flight.
 *
 * @returns {boolean} whether the move was applied
 */
export function moveUser(world, user) {
  if (!world || typeof user?.id !== 'string' || !isDrawable(user)) return false;
  const existing = world.users.get(user.id);
  if (existing) {
    existing.tx = user.x;
    existing.ty = user.y;
    return true;
  }
  return addUser(world, user);
}

/**
 * `user:left` — drop the avatar. Removing an unknown id is a no-op.
 *
 * @returns {boolean} whether an avatar was removed
 */
export function removeUser(world, user) {
  if (!world || typeof user?.id !== 'string') return false;
  return world.users.delete(user.id);
}

/**
 * Apply a `joined` snapshot: the room blueprint, this connection's id and every
 * avatar the server currently has in the room.
 *
 * The snapshot is authoritative for every id it lists — drawing position and
 * glide target both come from the server — and for every id it does not list,
 * with one exception. A snapshot is built from a database read, and a user who
 * announced themselves with `user:joined` while that read was in flight can be
 * missing from it: their row was written after the read. Such a user is already
 * on screen here, and dropping them would hide a peer (they would only reappear
 * when they moved), so ids listed in `announcedIds` are carried over instead of
 * cleared. `announcedIds` holds announcements seen on the current connection, so
 * a stale world from before a reconnect is still cleared completely.
 *
 * @param {object} world the mutable world state
 * @param {object} payload the `joined` payload ({ selfId, room, users })
 * @param {object} [options]
 * @param {string|null} [options.selfId] connection id, when the payload omits it
 * @param {string|null} [options.name] this user's name, for entries without one
 * @param {Set<string>|null} [options.announcedIds] ids announced during this join
 */
export function applyJoinedSnapshot(world, payload, { selfId = null, name = null, announcedIds = null } = {}) {
  const nextSelfId = payload?.selfId ?? selfId ?? world.selfId ?? null;
  const users = new Map();
  const snapshot = Array.isArray(payload?.users) ? payload.users : [];

  for (const user of snapshot) {
    if (typeof user?.id !== 'string' || !isDrawable(user)) continue;
    users.set(user.id, {
      id: user.id,
      // The server sends a name with every entry; the fallbacks only cover an
      // entry whose name is missing (an older server, or our own rename).
      name: user.name ?? world.users.get(user.id)?.name ?? (user.id === nextSelfId ? name : null),
      x: user.x,
      y: user.y,
      tx: user.x,
      ty: user.y,
    });
  }

  // Announced during this join but absent from the snapshot: they are in the
  // room (their `user:left` would have arrived after the announcement) and
  // already drawn, so keep them.
  if (announcedIds?.size) {
    for (const [id, user] of world.users) {
      if (!users.has(id) && announcedIds.has(id)) users.set(id, user);
    }
  }

  world.users.clear();
  for (const [id, user] of users) world.users.set(id, user);
  world.room = payload?.room ?? null;
  world.selfId = nextSelfId;
  world.epoch += 1;

  return world;
}
