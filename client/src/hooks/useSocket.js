import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config.js';

/**
 * Socket.io connection + world state (Day 4; Day 5 adds `emitMove` and
 * the epoch the movement controller re-syncs on).
 *
 * The world (room blueprint + every avatar's position) lives in a ref,
 * NOT in React state: `user:moved` can arrive many times a second and
 * none of those updates should re-render React. The canvas reads the
 * ref directly on every animation frame. React state is reserved for
 * low-frequency facts only — connection status, the latest server
 * error, and a one-per-join summary — so joining, erroring and
 * disconnecting re-render, but avatar movement never does.
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

export function createWorldState() {
  return {
    /** { roomId, name, width, height, obstacles: [] } from `joined`, else null. */
    room: null,
    /** Map<socketId, { id, name, x, y }> — every avatar in the room, self included. */
    users: new Map(),
    /** This client's socket id, from `joined.selfId`. */
    selfId: null,
    /**
     * Bumped every time a `joined` snapshot (re)builds the world. The
     * Day 5 movement controller watches it to drop held keys and stale
     * click targets across a re-join, instead of fighting the
     * server-provided positions.
     */
    epoch: 0,
  };
}

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

  const [status, setStatus] = useState('idle'); // idle | connecting | joined | disconnected | error
  const [error, setError] = useState(null);
  // Set once per successful `joined` (never per move): { roomId, roomName, selfId, name }.
  const [joinedInfo, setJoinedInfo] = useState(null);

  const teardownSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    pendingJoinRef.current = null;
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
        const pending = pendingJoinRef.current;
        if (pending) socket.emit('join', pending);
      });

      socket.on('joined', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const world = worldRef.current;
        world.room = payload.room ?? null;
        world.selfId = payload.selfId ?? socket.id ?? null;
        // Snapshot known users BEFORE clearing, as a fallback for any
        // entry whose name is missing; the server now sends `name` in
        // every `joined.users` entry, and that name wins.
        const previousById = new Map(world.users);
        world.users.clear();
        for (const user of payload.users ?? []) {
          if (!user || typeof user.id !== 'string') continue;
          const existing = previousById.get(user.id);
          world.users.set(user.id, {
            id: user.id,
            name:
              user.name ??
              existing?.name ??
              (user.id === world.selfId ? (pendingJoinRef.current?.name ?? null) : null),
            x: user.x,
            y: user.y,
          });
        }
        setError(null);
        setStatus('joined');
        world.epoch += 1; // a fresh snapshot: movement state re-syncs to it
        setJoinedInfo({
          roomId: payload.room?.roomId ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          roomName: payload.room?.name ?? pendingJoinRef.current?.roomId ?? normalizedRoom,
          selfId: world.selfId,
          name: pendingJoinRef.current?.name ?? trimmedName,
        });
      });

      socket.on('user:joined', (user) => {
        if (!user || typeof user.id !== 'string') return;
        worldRef.current.users.set(user.id, {
          id: user.id,
          name: user.name ?? null,
          x: user.x,
          y: user.y,
        });
      });

      socket.on('user:moved', (user) => {
        if (!user || typeof user.id !== 'string') return;
        const world = worldRef.current;
        const existing = world.users.get(user.id);
        if (existing) {
          existing.x = user.x;
          existing.y = user.y;
        } else {
          world.users.set(user.id, { id: user.id, name: user.name ?? null, x: user.x, y: user.y });
        }
      });

      socket.on('user:left', (user) => {
        if (!user || typeof user.id !== 'string') return;
        worldRef.current.users.delete(user.id);
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
