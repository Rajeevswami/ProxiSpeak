import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config.js';
import { CONNECTION_STATUS, statusAfter } from '../realtime/connectionStatus.js';
import {
  addUser,
  applyJoinedSnapshot,
  createWorldState,
  hasJoinedConnection,
  moveUser,
  removeUser,
} from '../realtime/worldState.js';

/**
 * Socket.io connection + world state (Day 4; Day 5 adds `emitMove` and the
 * epoch the movement controller re-syncs on).
 *
 * This hook owns the connection and the React-visible facts (status, the latest
 * server error, a one-per-join summary). The world itself — room blueprint and
 * every avatar — lives in `realtime/worldState.js`: *what* the server told us is
 * a pure, unit-tested data structure, *how* we hear it is this hook. The world
 * sits in a ref, not in React state, because `user:moved` can arrive many times
 * a second and none of those updates may re-render React; the canvas reads the
 * ref directly on every animation frame.
 *
 * Events (Day 3 contract):
 *   emit  join        { roomId, name }
 *   emit  move        { x, y }            (Day 5, via emitMove)
 *   on    joined      { selfId, room, users: [{ id, name, x, y }] }
 *   on    user:joined { id, name, x, y }
 *   on    user:moved  { id, x, y }
 *   on    user:left   { id }
 *   on    error       { code, message, field? }
 */

const toError = (err) => {
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    return { code: err.code, message: err.message ?? err.code, field: err.field };
  }
  return { code: 'connection_failed', message: err?.message ?? 'could not reach the server' };
};

export function useSocket() {
  const worldRef = useRef(null);
  if (worldRef.current === null) worldRef.current = createWorldState();

  const socketRef = useRef(null);
  const pendingJoinRef = useRef(null);
  /**
   * Ids announced by `user:joined` on the current connection. Used by the
   * snapshot merge: a user who announces themselves while our own join is in
   * flight may be missing from the `joined` snapshot. Cleared on every connect
   * (a reconnect starts a brand new connection) and after the snapshot.
   */
  const announcedRef = useRef(new Set());
  // Only retain join-race tombstones while a snapshot is pending, never for
  // the whole connection lifetime (room churn must not grow these forever).
  const departedRef = useRef(new Set());
  const snapshotPendingRef = useRef(false);

  // idle | connecting | joined | disconnected | error — see connectionStatus.js
  const [status, setStatus] = useState(CONNECTION_STATUS.IDLE);
  const [error, setError] = useState(null);
  // Set once per successful `joined` (never per move): { roomId, roomName, selfId, name }.
  const [joinedInfo, setJoinedInfo] = useState(null);

  const teardownSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    pendingJoinRef.current = null;
    announcedRef.current.clear();
    departedRef.current.clear();
    snapshotPendingRef.current = false;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }, []);

  const join = useCallback(
    ({ roomId, name }) => {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const normalizedRoom = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';

      // Start from a clean slate: a (re)join never inherits stale avatars.
      teardownSocket();
      const world = worldRef.current;
      world.room = null;
      world.users.clear();
      world.selfId = null;
      setJoinedInfo(null);
      setError(null);
      setStatus((prev) => statusAfter(prev, 'join-requested'));

      pendingJoinRef.current = { roomId: normalizedRoom, name: trimmedName };

      // '' means same origin (production); socket.io-client defaults to
      // the page origin when no URL is passed.
      const socket = io(SERVER_URL || undefined, {
        autoConnect: true,
        // Socket.io keeps reconnecting on its own — the client never has to
        // reload the page to get back into the room. The HUD shows the
        // reconnect while it happens (see statusAfter).
        reconnectionAttempts: Infinity,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        announcedRef.current.clear();
        departedRef.current.clear();
        snapshotPendingRef.current = true;
        const pending = pendingJoinRef.current;
        if (pending) socket.emit('join', pending);
      });

      socket.on('joined', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const world = worldRef.current;
        applyJoinedSnapshot(world, payload, {
          selfId: payload.selfId ?? socket.id ?? null,
          name: pendingJoinRef.current?.name ?? null,
          announcedIds: announcedRef.current,
          departedIds: departedRef.current,
        });
        snapshotPendingRef.current = false;
        announcedRef.current.clear();
        departedRef.current.clear();
        setError(null);
        setStatus((prev) => statusAfter(prev, 'joined'));
        setJoinedInfo({
          roomId: payload.room?.roomId ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          roomName: payload.room?.name ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          selfId: world.selfId,
          name: pendingJoinRef.current?.name ?? trimmedName,
        });
      });

      socket.on('user:joined', (user) => {
        if (addUser(worldRef.current, user) && snapshotPendingRef.current) {
          announcedRef.current.add(user.id);
          departedRef.current.delete(user.id);
        }
      });

      socket.on('user:moved', (user) => {
        moveUser(worldRef.current, user);
      });

      socket.on('user:left', (user) => {
        if (snapshotPendingRef.current && typeof user?.id === 'string') {
          departedRef.current.add(user.id);
          announcedRef.current.delete(user.id);
        }
        removeUser(worldRef.current, user);
      });

      socket.on('error', (err) => {
        setError(toError(err));
        // A rejected join leaves us connected but not in a room; the join
        // screen reads `error` and stays up. Once joined, a later error is
        // surfaced in the HUD without tearing the world down.
        setStatus((prev) => statusAfter(prev, 'error'));
      });

      socket.on('connect_error', (err) => {
        setError({ code: 'connection_failed', message: err?.message ?? 'could not reach the server' });
        setStatus((prev) => statusAfter(prev, 'connect-error'));
      });

      socket.on('disconnect', (reason) => {
        // Socket.io reconnects on its own, so a member stays in the world and
        // the HUD reports the reconnect. A connection that drops *before* the
        // join was acknowledged becomes a visible error instead of leaving the
        // join form busy forever.
        setError({ code: 'connection_lost', message: `the connection to the server was lost (${reason})` });
        setStatus((prev) => statusAfter(prev, 'disconnected'));
      });
    },
    [teardownSocket],
  );

  /**
   * Send a position to the server (Day 5). Only used by the movement
   * controller's 10 Hz throttle; skipped while the socket is down so a
   * buffered emit can never hit a closed connection.
   *
   * `socket.connected` on its own is not enough: after an automatic reconnect
   * the transport is up and the id is new, while the re-join is still in
   * flight. A `move` sent in that window belongs to the *previous* connection's
   * session, so the server answers `not_joined` — the gate stays shut until the
   * server has acknowledged the new connection with `joined.selfId`.
   */
  const emitMove = useCallback((x, y) => {
    const socket = socketRef.current;
    if (socket?.connected && hasJoinedConnection(worldRef.current, socket.id)) {
      socket.emit('move', { x, y });
    }
  }, []);

  // Clean disconnect on unmount: no socket (and no presence document
  // server-side) outlives the component that opened it.
  useEffect(() => teardownSocket, [teardownSocket]);

  return { world: worldRef, status, error, joinedInfo, join, emitMove };
}

export default useSocket;
