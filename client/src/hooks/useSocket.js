import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { recoverExpiredSession } from '../realtime/sessionRecovery.js';
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
import { createAudioMixer } from '../audio/audioMixer.js';
import { createLocalMedia } from '../webrtc/localMedia.js';
import { createPeerManager } from '../webrtc/peerManager.js';

/**
 * Socket.io connection + world state (Day 4; Day 5 adds `emitMove` and the
 * epoch the movement controller re-syncs on; Day 9 wires the WebRTC peer
 * manager into the same events).
 *
 * This hook owns the connection and the React-visible facts (status, the latest
 * server error, a one-per-join summary, the microphone state). The world itself
 * — room blueprint and every avatar — lives in `realtime/worldState.js`: *what*
 * the server told us is a pure, unit-tested data structure, *how* we hear it is
 * this hook. The world sits in a ref, not in React state, because `user:moved`
 * can arrive many times a second and none of those updates may re-render React;
 * the canvas reads the ref directly on every animation frame. The peer manager
 * lives in a ref for the same reason: its `signal` traffic must never render.
 *
 * Events (Day 3 + Day 8 contract):
 *   emit  join          { roomId, name }
 *   emit  move          { x, y }            (Day 5, via emitMove)
 *   emit  signal        { to, generation, data }       (Day 9, via peerManager)
 *   on    joined        { selfId, room, users: [{ id, name, x, y }], iceServers }
 *   on    user:joined   { id, name, x, y }
 *   on    user:moved    { id, x, y }
 *   on    user:left     { id }
 *   on    peer:connect  { peerId, name, initiator, generation, iceServers }  (Day 9)
 *   on    peer:disconnect { peerId, generation }                             (Day 9)
 *   on    signal        { from, generation, data }                           (Day 9)
 *   on    error         { code, message, field? }
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
  /** Microphone handle for this page (Day 9): one `createLocalMedia` per hook. */
  const localMediaRef = useRef(null);
  if (localMediaRef.current === null) localMediaRef.current = createLocalMedia();
  /** One shared remote-audio mixer for this app session; no React state. */
  const audioMixerRef = useRef(null);
  if (audioMixerRef.current === null) audioMixerRef.current = createAudioMixer();
  /** WebRTC mesh for the current connection (Day 9), kept out of React state. */
  const peerManagerRef = useRef(null);
  /** The user's last choice: 'mic' or 'listen-only'. Re-acquire the mic on a
   * reconnect only when the user asked to speak. */
  const micModeRef = useRef('listen-only');
  /** True while the microphone is (or was) capturing this session: only a mic
   * that worked before a drop is worth re-acquiring after the reconnect. */
  const micWasLiveRef = useRef(false);
  /** Set on 'disconnect', consumed by the next 'connect': the mic is only
   * re-requested after a real reconnect — never a second time inside the same
   * join (a denied permission must not be asked again immediately). */
  const reconnectingRef = useRef(false);
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
  // Microphone truth for the UI (Day 9): 'on', 'off' (requested but failed —
  // the join continues listen-only) or 'listen-only' (the user's choice).
  const [mic, setMic] = useState({ state: 'listen-only', notice: null });

  const teardownSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    pendingJoinRef.current = null;
    announcedRef.current.clear();
    departedRef.current.clear();
    snapshotPendingRef.current = false;
    // No connection, audio element, stats timer or microphone track may
    // outlive the socket that created it (Day 9).
    const peers = peerManagerRef.current;
    peerManagerRef.current = null;
    if (peers) peers.closeAll();
    else void audioMixerRef.current?.closeAll?.();
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }, []);

  /**
   * Ask for the microphone and publish the result. Never throws: a denial or a
   * missing device becomes a clear notice and the session continues in
   * listen-only mode (still hearing others).
   */
  const requestMic = useCallback(async () => {
    const result = await localMediaRef.current.request();
    if (result.ok) {
      micWasLiveRef.current = true;
      setMic({ state: 'on', notice: null });
      return true;
    }
    setMic({ state: 'off', notice: result.message });
    return false;
  }, []);

  const join = useCallback(
    async ({ roomId, name, withMic = true }) => {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const normalizedRoom = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';

      // Start from a clean slate: a (re)join never inherits stale avatars.
      teardownSocket();
      // Must run synchronously from the Join click's user gesture. The context
      // is shared across every remote peer in this page.
      void audioMixerRef.current.resume();
      const world = worldRef.current;
      world.room = null;
      world.users.clear();
      world.selfId = null;
      setJoinedInfo(null);
      setError(null);
      setStatus((prev) => statusAfter(prev, 'join-requested'));

      // 1. Microphone first — this call is inside the Join button click, so
      //    the permission prompt has a real user gesture behind it. A denial
      //    or missing device is announced and the join continues listen-only.
      micModeRef.current = withMic ? 'mic' : 'listen-only';
      reconnectingRef.current = false; // a fresh join is not a reconnect
      if (withMic) {
        await requestMic();
      } else {
        micWasLiveRef.current = false;
        localMediaRef.current.release();
        setMic({ state: 'listen-only', notice: null });
      }

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

      // 2. The Day 8 events drive one peer connection per edge. The manager is
      //    created with the local media handle so tracks follow the mic state
      //    and nothing outlives the socket (closeAll on disconnect/unmount).
      peerManagerRef.current = createPeerManager({
        socket,
        createPeerConnection: (configuration) => new RTCPeerConnection(configuration),
        localMedia: localMediaRef.current,
        audioMixer: audioMixerRef.current,
      });

      socket.on('connect', async () => {
        announcedRef.current.clear();
        departedRef.current.clear();
        snapshotPendingRef.current = true;
        // Only after a real reconnect (a 'disconnect' happened): closeAll ran
        // there and stopped the tracks, so get the microphone back before the
        // re-join when the user joined with a working mic. The permission is
        // already granted, so no prompt appears. A fresh join already asked
        // once inside the click — never ask twice; a mic that never worked is
        // not re-requested (listen-only already covers it).
        const reconnecting = reconnectingRef.current;
        reconnectingRef.current = false;
        if (
          reconnecting &&
          micModeRef.current === 'mic' &&
          micWasLiveRef.current &&
          !localMediaRef.current.isActive()
        ) {
          await requestMic();
        }
        const pending = pendingJoinRef.current;
        if (pending && socketRef.current === socket) socket.emit('join', pending);
      });

      socket.on('joined', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        audioMixerRef.current.setProximityRadius(payload.proximityRadiusPx);
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
        if (err?.code === 'session_expired') {
          // The presence row was swept, so every edge is dead: tear the mesh
          // down before the recovery re-joins. New peer:connect events after
          // the re-join rebuild it.
          peerManagerRef.current?.closeAll();
        }
        if (recoverExpiredSession(socket, err)) return;
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
        // Every edge belongs to the session that just died: no connection,
        // audio element, stats timer or microphone track survives it. The
        // 'connect' handler re-acquires the mic and the server re-creates the
        // edges through peer:connect after the re-join.
        reconnectingRef.current = true;
        peerManagerRef.current?.closeAll();
        // Socket.io reconnects on its own, so a member stays in the world and
        // the HUD reports the reconnect. A connection that drops *before* the
        // join was acknowledged becomes a visible error instead of leaving the
        // join form busy forever.
        setError({ code: 'connection_lost', message: `the connection to the server was lost (${reason})` });
        setStatus((prev) => statusAfter(prev, 'disconnected'));
      });
    },
    [teardownSocket, requestMic],
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

  /**
   * Read-only WebRTC rows for the status overlay (Day 9), polled at most once
   * a second: `[{ peerId, name, generation, connectionState, bytesReceived }]`.
   * Never reactive — the overlay decides when to read it.
   */
  const getAudioSnapshot = useCallback(() => {
    const mixer = audioMixerRef.current;
    return (peerManagerRef.current?.snapshot() ?? []).map((row) => ({
      ...row,
      ...(mixer.peerMetrics(row.peerId) ?? { distancePx: null, volumePercent: 0 }),
    }));
  }, []);

  /** Called from the canvas's existing rAF after movement/interpolation. */
  const updateAudioGains = useCallback(() => {
    const world = worldRef.current;
    const local = world.users.get(world.selfId);
    if (!local) return false;
    const peerIds = peerManagerRef.current?.peerIds?.() ?? [];
    return audioMixerRef.current.updateGains(
      { x: local.x, y: local.y },
      (peerId) => {
        const remote = world.users.get(peerId);
        return remote ? { x: remote.x, y: remote.y } : null;
      },
      peerIds,
    );
  }, []);

  return { world: worldRef, status, error, joinedInfo, join, emitMove, mic, getAudioSnapshot, updateAudioGains };
}

export default useSocket;
