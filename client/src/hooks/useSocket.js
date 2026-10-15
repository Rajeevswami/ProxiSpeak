import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config.js';
import {
  addUser,
  applyJoinedSnapshot,
  createWorldState,
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

  const [status, setStatus] = useState('idle'); // idle | connecting | joined | disconnected | error
  const [error, setError] = useState(null);
  // Set once per successful `joined` (never per move): { roomId, roomName, selfId, name }.
  const [joinedInfo, setJoinedInfo] = useState(null);

  const teardownSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    pendingJoinRef.current = null;
    announcedRef.current.clear();
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
      setStatus('connecting');

      pendingJoinRef.current = { roomId: normalizedRoom, name: trimmedName };

      // '' means same origin (production); socket.io-client defaults to
      // the page origin when no URL is passed.
      const socket = io(SERVER_URL || undefined, {
        autoConnect: true,
        reconnectionAttempts: 5,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        announcedRef.current.clear();
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
        });
        announcedRef.current.clear();
        setError(null);
        setStatus('joined');
        setJoinedInfo({
          roomId: payload.room?.roomId ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          roomName: payload.room?.name ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          selfId: world.selfId,
          name: pendingJoinRef.current?.name ?? trimmedName,
        });
      });

      socket.on('user:joined', (user) => {
        if (addUser(worldRef.current, user)) announcedRef.current.add(user.id);
      });

      socket.on('user:moved', (user) => {
        moveUser(worldRef.current, user);
      });

      socket.on('user:left', (user) => {
        removeUser(worldRef.current, user);
      });

      socket.on('error', (err) => {
        setError(toError(err));
        // A rejected join leaves us connected but not in a room; the
        // join screen reads `error` and stays up. Once joined, a later
        // error is surfaced without tearing the world down.
        setStatus((prev) => (prev === 'joined' ? prev : 'error'));
      });

      socket.on('connect_error', (err) => {
        setError({ code: 'connection_failed', message: err?.message ?? 'could not reach the server' });
        setStatus((prev) => (prev === 'joined' ? prev : 'error'));
      });

      socket.on('disconnect', () => {
        setStatus((prev) => (prev === 'joined' ? 'disconnected' : prev));
      });
    },
    [teardownSocket],
  );

  /**
   * Send a position to the server (Day 5). Only used by the movement
   * controller's 10 Hz throttle; skipped while the socket is down so a
   * buffered emit can never hit a reconnected (not-yet-joined) session
   * and produce a spurious `not_joined` error.
   */
  const emitMove = useCallback((x, y) => {
    const socket = socketRef.current;
    if (socket && socket.connected) socket.emit('move', { x, y });
  }, []);

  // Clean disconnect on unmount: no socket (and no presence document
  // server-side) outlives the component that opened it.
  useEffect(() => teardownSocket, [teardownSocket]);

  return { world: worldRef, status, error, joinedInfo, join, emitMove };
}

export default useSocket;
