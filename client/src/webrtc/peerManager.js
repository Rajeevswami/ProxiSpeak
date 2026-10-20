/**
 * WebRTC peer manager (Week 2, Day 9).
 *
 * One `RTCPeerConnection` per peer *edge*, keyed by peerId and stamped with
 * the edge `generation` the Day 8 peer graph created. The server decides who
 * may talk to whom and who offers (the lexicographically smaller socket id),
 * so this module never negotiates glare; it only has to handle the three
 * things that break naive clients:
 *
 *   1. STALE SIGNALS — every envelope carries the edge generation. Anything
 *      that does not match the generation of the connection we hold is
 *      dropped instead of reviving a dead call.
 *   2. ICE RACE — candidates that arrive before the remote description are
 *      queued and replayed in order afterwards, never added to a pc that has
 *      no remote SDP yet.
 *   3. DEAD LINKS — a failed/closed connection is cleaned up and left alone;
 *      no auto-retry loops. The server re-creates edges through `peer:connect`.
 *
 * Plain JS with every dependency injected (RTCPeerConnection factory,
 * socket-like emitter, logger, local media, remote-audio sink, stats poller),
 * so `client/test/webrtc.peerManager.test.js` drives it with fakes in Node.
 * Errors inside any handler go to the logger and never reach the UI.
 *
 * Events (Day 8 contract, unchanged):
 *   on    joined         { selfId, room, users, iceServers }
 *   on    peer:connect   { peerId, name, initiator, generation, iceServers }
 *   on    peer:disconnect{ peerId, generation }
 *   on    signal         { from, generation, data }
 *   emit  signal         { to, generation, data }
 * with data = { type: "offer"|"answer", sdp } or { type: "candidate", candidate }.
 */

import { createRemoteAudio } from './remoteAudio.js';
import { createRtcStats } from './rtcStats.js';

const noop = () => {};

const defaultLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: (...args) => console.error('[webrtc]', ...args),
};

/**
 * @param {object} options
 * @param {{emit: Function, on: Function}} options.socket socket-like emitter
 *   (Socket.io works; tests use a fake). `connected === false` gates emits.
 * @param {Function} options.createPeerConnection (configuration) => RTCPeerConnection
 * @param {object} [options.logger] { debug, info, warn, error }
 * @param {object} [options.localMedia] { getStream(), release() } — the mic
 * @param {object} [options.remoteAudio] { attach(peerId, stream), remove(peerId), removeAll() };
 *   defaults to a real `createRemoteAudio()` (own `<audio>` element per peer)
 * @param {object} [options.audioMixer] { attach(peerId, stream, element), remove(peerId), closeAll() }
 * @param {object} [options.stats] { watch(peerId, pc), unwatch(peerId), stopAll(), get(peerId) };
 *   defaults to a real `createRtcStats()` (~1 s `getStats()` poll per peer)
 * @param {Array} [options.fallbackIceServers] ICE list from `joined`, used when
 *   a `peer:connect` arrives without one
 */
export function createPeerManager({
  socket,
  createPeerConnection,
  logger = defaultLogger,
  localMedia = null,
  remoteAudio = null,
  audioMixer = null,
  stats = null,
  fallbackIceServers = [],
} = {}) {
  if (!socket || typeof socket.on !== 'function' || typeof socket.emit !== 'function') {
    throw new Error('createPeerManager requires a socket-like emitter');
  }
  if (typeof createPeerConnection !== 'function') {
    throw new Error('createPeerManager requires a createPeerConnection factory');
  }
  const log = logger ?? defaultLogger;
  const audio = remoteAudio ?? createRemoteAudio();
  const statsPoll = stats ?? createRtcStats({ logger: log });

  /** peerId -> edge record (never two per peer). */
  const connections = new Map();
  /** ICE servers from the last `joined`, the fallback for peer:connect. */
  let joinedIceServers = Array.isArray(fallbackIceServers) ? fallbackIceServers : [];

  /**
   * Log-and-swallow wrapper: sync throws and async rejections both end here.
   * The returned promise settles after the handler (and any logging) finished,
   * so callers and tests can await exact completion.
   */
  const safe = (label, handler) => (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') {
        return result.catch((err) => log.error(`${label} handler failed:`, err?.message ?? err));
      }
      return result;
    } catch (err) {
      log.error(`${label} handler failed:`, err?.message ?? err);
      return undefined;
    }
  };

  const send = (to, generation, data) => {
    // A disconnected socket would buffer stale signaling that the server
    // rejects after the reconnect; drop it instead of spamming error events.
    if (socket.connected === false) {
      log.debug(`signal to ${to} skipped (socket down)`);
      return;
    }
    socket.emit('signal', { to, generation, data });
  };

  /** Close one edge: pc, stats timer, audio element, registry entry. */
  const closeEdge = (peerId, reason) => {
    const edge = connections.get(peerId);
    if (!edge) return false;
    connections.delete(peerId);
    try {
      statsPoll.unwatch(peerId);
    } catch (err) {
      log.debug(`stats unwatch for ${peerId} failed:`, err?.message ?? err);
    }
    try {
      audioMixer?.remove?.(peerId);
    } catch (err) {
      log.debug(`audio mixer remove for ${peerId} failed:`, err?.message ?? err);
    }
    try {
      audio.remove(peerId);
    } catch (err) {
      log.debug(`audio remove for ${peerId} failed:`, err?.message ?? err);
    }
    try {
      edge.pc.onicecandidate = null;
      edge.pc.ontrack = null;
      edge.pc.onconnectionstatechange = null;
      edge.pc.close();
    } catch (err) {
      log.debug(`pc close for ${peerId} failed:`, err?.message ?? err);
    }
    log.debug(`peer ${peerId} closed (${reason})`);
    return true;
  };

  /** Queue-then-flush: candidates must land after the remote description. */
  const flushCandidates = async (edge) => {
    const queued = edge.pendingCandidates;
    edge.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await edge.pc.addIceCandidate(candidate);
      } catch (err) {
        // One bad candidate must not abort the rest of the queue.
        log.error(`queued ICE candidate for ${edge.peerId} rejected:`, err?.message ?? err);
      }
    }
  };

  /** Create the pc for one edge: tracks/transceiver, handlers, stats watch. */
  const createEdge = ({ peerId, name, generation, iceServers }) => {
    const servers =
      Array.isArray(iceServers) && iceServers.length > 0 ? iceServers : joinedIceServers;
    const pc = createPeerConnection({ iceServers: servers });
    const edge = {
      peerId,
      name: typeof name === 'string' ? name : '',
      generation,
      pc,
      pendingCandidates: [],
      hasRemoteDescription: false,
    };
    connections.set(peerId, edge);

    // Mic on: send our audio. Listen-only: negotiate audio receive-only so the
    // SDP still carries an audio m-line and the remote stream can arrive.
    const stream = localMedia?.getStream?.() ?? null;
    const tracks = stream?.getAudioTracks?.() ?? [];
    if (tracks.length > 0) {
      for (const track of tracks) pc.addTrack(track, stream);
    } else if (typeof pc.addTransceiver === 'function') {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.onicecandidate = (event) => {
      try {
        if (!event?.candidate) return; // end-of-candidates marker: nothing to trickle
        const candidate =
          typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
        send(peerId, generation, { type: 'candidate', candidate });
      } catch (err) {
        log.error(`local ICE candidate for ${peerId} failed:`, err?.message ?? err);
      }
    };

    pc.ontrack = (event) => {
      try {
        const remote =
          event.streams?.[0] ??
          (typeof MediaStream === 'function' ? new MediaStream([event.track]) : null);
        if (remote) {
          const element = audio.attach(peerId, remote, { muted: Boolean(audioMixer) });
          if (element && audioMixer) audioMixer.attach(peerId, remote, element);
        }
      } catch (err) {
        log.error(`remote track for ${peerId} failed:`, err?.message ?? err);
      }
    };

    pc.onconnectionstatechange = () => {
      try {
        const state = pc.connectionState;
        if (state === 'failed' || state === 'closed') {
          // No auto-retry: the server owns the graph and re-creates the edge
          // through peer:connect when it should exist again.
          closeEdge(peerId, state);
        }
      } catch (err) {
        log.error(`connection state for ${peerId} failed:`, err?.message ?? err);
      }
    };

    try {
      statsPoll.watch(peerId, pc);
    } catch (err) {
      log.debug(`stats watch for ${peerId} failed:`, err?.message ?? err);
    }
    return edge;
  };

  const makeOffer = async (edge) => {
    const offer = await edge.pc.createOffer();
    await edge.pc.setLocalDescription(offer);
    // The edge may have been replaced while the awaits ran.
    if (connections.get(edge.peerId) !== edge) return;
    send(edge.peerId, edge.generation, {
      type: 'offer',
      sdp: edge.pc.localDescription?.sdp ?? offer.sdp,
    });
  };

  // ------------------------------------------------------------- handlers ---

  /** `joined` — remember the ICE servers for peer:connect events without one. */
  const handleJoined = (payload) => {
    const servers = payload?.iceServers;
    if (Array.isArray(servers)) joinedIceServers = servers;
    log.debug(`joined: fallback ICE servers set (${joinedIceServers.length})`);
  };

  /** `peer:connect` — open (or replace) the edge to one peer. */
  const handlePeerConnect = async (payload) => {
    const { peerId, name, initiator, generation, iceServers } = payload ?? {};
    if (typeof peerId !== 'string' || !peerId || !Number.isInteger(generation)) {
      log.debug('peer:connect ignored (malformed payload)');
      return;
    }
    const existing = connections.get(peerId);
    if (existing) {
      if (existing.generation >= generation) {
        // Duplicate or stale connect: the edge we hold is current.
        log.debug(`peer:connect for ${peerId} ignored (generation ${generation} <= ${existing.generation})`);
        return;
      }
      // A newer generation replaces the old edge — never two for one peer.
      closeEdge(peerId, 'replaced');
    }

    const edge = createEdge({ peerId, name, generation, iceServers });
    log.debug(`peer ${peerId} connected (generation ${generation}, initiator=${!!initiator})`);
    if (initiator) await makeOffer(edge);
  };

  /** `signal` — offer/answer/candidate relayed from one peer. */
  const handleSignal = async (payload) => {
    const { from, generation, data } = payload ?? {};
    if (typeof from !== 'string' || !from || !data || typeof data !== 'object') return;

    const edge = connections.get(from);
    if (!edge) {
      // Includes signals whose peer:connect was lost or already cleaned up.
      log.debug(`signal from unknown peer ${from} ignored`);
      return;
    }
    if (generation !== edge.generation) {
      log.debug(`stale signal from ${from} ignored (generation ${generation} != ${edge.generation})`);
      return;
    }

    if (data.type === 'offer') {
      await edge.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      edge.hasRemoteDescription = true;
      await flushCandidates(edge);
      const answer = await edge.pc.createAnswer();
      await edge.pc.setLocalDescription(answer);
      if (connections.get(from) !== edge) return; // replaced while answering
      send(from, edge.generation, {
        type: 'answer',
        sdp: edge.pc.localDescription?.sdp ?? answer.sdp,
      });
    } else if (data.type === 'answer') {
      // Only the answer to our own offer is meaningful; ignore duplicates.
      if (edge.pc.signalingState !== 'have-local-offer') return;
      await edge.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      edge.hasRemoteDescription = true;
      await flushCandidates(edge);
    } else if (data.type === 'candidate') {
      if (data.candidate === undefined || data.candidate === null) return; // end-of-candidates
      if (!edge.hasRemoteDescription) {
        edge.pendingCandidates.push(data.candidate); // flushed after the SDP
        return;
      }
      await edge.pc.addIceCandidate(data.candidate);
    }
  };

  /** `peer:disconnect` — the edge died; only the matching generation counts. */
  const handlePeerDisconnect = (payload) => {
    const { peerId, generation } = payload ?? {};
    const edge = connections.get(peerId);
    if (!edge) {
      log.debug(`peer:disconnect for unknown peer ${peerId} ignored`);
      return;
    }
    if (generation !== edge.generation) {
      log.debug(`stale peer:disconnect for ${peerId} ignored (generation ${generation} != ${edge.generation})`);
      return;
    }
    closeEdge(peerId, 'peer:disconnect');
  };

  // Wire the Day 8 events; every handler is log-and-swallow.
  socket.on('joined', safe('joined', handleJoined));
  socket.on('peer:connect', safe('peer:connect', handlePeerConnect));
  socket.on('peer:disconnect', safe('peer:disconnect', handlePeerDisconnect));
  socket.on('signal', safe('signal', handleSignal));

  return {
    handleJoined: safe('joined', handleJoined),
    handlePeerConnect: safe('peer:connect', handlePeerConnect),
    handlePeerDisconnect: safe('peer:disconnect', handlePeerDisconnect),
    handleSignal: safe('signal', handleSignal),

    /** Read-only rows for the status overlay / diagnostics. */
    snapshot() {
      return [...connections.values()].map((edge) => ({
        peerId: edge.peerId,
        name: edge.name,
        generation: edge.generation,
        connectionState: edge.pc.connectionState ?? 'new',
        bytesReceived: statsPoll.get?.(edge.peerId)?.bytesReceived ?? 0,
      }));
    },

    size() {
      return connections.size;
    },

    peerIds() {
      return [...connections.keys()];
    },

    /**
     * Tear everything down: every connection, every remote audio element,
     * every stats timer and the local tracks. Used on socket disconnect and
     * reconnect, `session_expired`, re-join and component unmount. Handlers
     * stay attached — the same socket serves the next session.
     */
    closeAll() {
      for (const peerId of [...connections.keys()]) closeEdge(peerId, 'closeAll');
      try {
        statsPoll.stopAll();
      } catch (err) {
        log.debug('stats stopAll failed:', err?.message ?? err);
      }
      try {
        audioMixer?.closeAll?.();
      } catch (err) {
        log.debug('audio mixer closeAll failed:', err?.message ?? err);
      }
      try {
        audio.removeAll();
      } catch (err) {
        log.debug('audio removeAll failed:', err?.message ?? err);
      }
      // No local track may outlive the session (microphone LED included).
      const stream = localMedia?.getStream?.() ?? null;
      for (const track of stream?.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      try {
        localMedia?.release?.();
      } catch (err) {
        log.debug('local media release failed:', err?.message ?? err);
      }
      log.debug('closeAll: nothing left behind');
    },
  };
}

export default createPeerManager;
