/**
 * Peer manager tests (Day 9). No browser, no real WebRTC: every dependency
 * (RTCPeerConnection factory, socket-like emitter, logger, local media,
 * remote-audio sink, stats poller) is a fake, so the whole signaling flow —
 * generations, ICE queueing, one-connection-per-peer, cleanup — runs in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPeerManager } from '../src/webrtc/peerManager.js';

// ------------------------------------------------------------------ fakes ---

/** Socket-like emitter: records emits, dispatch delivers to registered handlers. */
function createFakeSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    connected: true,
    sent,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit(event, payload) {
      sent.push({ event, payload });
    },
    /** Deliver one event to every handler and await their (possibly async) work. */
    async dispatch(event, payload) {
      const pending = [];
      for (const handler of handlers.get(event) ?? []) pending.push(handler(payload));
      await Promise.all(pending.map((value) => Promise.resolve(value)));
    },
    signalsTo(peerId) {
      return sent.filter((entry) => entry.event === 'signal' && entry.payload.to === peerId);
    },
  };
}

/** Recording RTCPeerConnection. */
function createFakePcFactory() {
  const created = [];
  const factory = (configuration) => {
    const pc = {
      configuration,
      connectionState: 'new',
      signalingState: 'stable',
      localDescription: null,
      remoteDescription: null,
      addedTracks: [],
      transceivers: [],
      addedCandidates: [],
      closed: false,
      createOffer: async () => ({ type: 'offer', sdp: 'offer-sdp' }),
      createAnswer: async () => ({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: async (desc) => {
        pc.localDescription = desc;
        pc.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
      },
      setRemoteDescription: async (desc) => {
        pc.remoteDescription = desc;
        pc.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
      },
      addIceCandidate: async (candidate) => {
        pc.addedCandidates.push(candidate);
      },
      addTrack: (track, stream) => {
        pc.addedTracks.push({ track, stream });
        return { track };
      },
      addTransceiver: (kind, init) => {
        const transceiver = { kind, ...(init ?? {}) };
        pc.transceivers.push(transceiver);
        return transceiver;
      },
      getStats: async () => new Map(),
      close: () => {
        pc.closed = true;
        pc.connectionState = 'closed';
      },
      onicecandidate: null,
      ontrack: null,
      onconnectionstatechange: null,
    };
    created.push(pc);
    return pc;
  };
  factory.created = created;
  return factory;
}

/** Local media whose tracks record `stop()`. */
function createFakeLocalMedia({ withMic = true } = {}) {
  const tracks = withMic
    ? [
        {
          kind: 'audio',
          readyState: 'live',
          stopped: false,
          stop() {
            this.stopped = true;
            this.readyState = 'ended';
          },
        },
      ]
    : [];
  const stream = withMic ? { getAudioTracks: () => tracks, getTracks: () => tracks } : null;
  return {
    tracks,
    stream,
    released: false,
    getStream: () => (tracks.some((track) => track.readyState === 'live') ? stream : null),
    release() {
      for (const track of tracks) track.stop();
      this.released = true;
      return tracks.length;
    },
  };
}

/** Remote-audio sink that records "elements" per peer. */
function createFakeRemoteAudio() {
  const elements = new Map();
  return {
    elements,
    attach(peerId, stream) {
      elements.set(peerId, { peerId, stream });
      return elements.get(peerId);
    },
    remove(peerId) {
      return elements.delete(peerId);
    },
    removeAll() {
      elements.clear();
    },
  };
}

/** Stats poller that records watch/unwatch/stopAll. */
function createFakeStats() {
  const watched = new Map();
  return {
    watched,
    stopAllCalls: 0,
    watch(peerId, pc) {
      watched.set(peerId, pc);
    },
    unwatch(peerId) {
      watched.delete(peerId);
    },
    stopAll() {
      watched.clear();
      this.stopAllCalls += 1;
    },
    get(peerId) {
      return watched.has(peerId) ? { connectionState: 'new', bytesReceived: 0 } : null;
    },
  };
}

function createFakeLogger() {
  const errors = [];
  const debugs = [];
  return {
    errors,
    debugs,
    debug: (...args) => debugs.push(args),
    info: () => {},
    warn: () => {},
    error: (...args) => errors.push(args),
  };
}

/** One manager wired to fakes — everything the tests assert on. */
function setup({ withMic = true, fallbackIceServers = [] } = {}) {
  const socket = createFakeSocket();
  const createPeerConnection = createFakePcFactory();
  const localMedia = createFakeLocalMedia({ withMic });
  const remoteAudio = createFakeRemoteAudio();
  const stats = createFakeStats();
  const logger = createFakeLogger();
  const manager = createPeerManager({
    socket,
    createPeerConnection,
    localMedia,
    remoteAudio,
    stats,
    logger,
    fallbackIceServers,
  });
  return { socket, createPeerConnection, localMedia, remoteAudio, stats, logger, manager };
}

const connectEvent = (over = {}) => ({
  peerId: 'bob',
  name: 'Bob',
  initiator: false,
  generation: 1,
  iceServers: [{ urls: 'stun:stun.example' }],
  ...over,
});

const offerSignal = (generation = 1, sdp = 'remote-offer') => ({
  from: 'bob',
  generation,
  data: { type: 'offer', sdp },
});

const candidateSignal = (generation, id) => ({
  from: 'bob',
  generation,
  data: { type: 'candidate', candidate: { candidate: `candidate:${id}` } },
});

// ------------------------------------------------- signaling and offering ---

test('the initiator creates an offer, sets it as local description and signals it', async () => {
  const { socket, createPeerConnection, manager } = setup();

  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 1 }));

  assert.equal(createPeerConnection.created.length, 1);
  const pc = createPeerConnection.created[0];
  assert.deepEqual(pc.configuration.iceServers, [{ urls: 'stun:stun.example' }]);
  assert.equal(pc.addedTracks.length, 1, 'the microphone track is attached');
  assert.equal(pc.localDescription.type, 'offer');
  assert.equal(manager.size(), 1);

  const signals = socket.signalsTo('bob');
  assert.equal(signals.length, 1, 'exactly one signal: the offer');
  assert.deepEqual(signals[0].payload, {
    to: 'bob',
    generation: 1,
    data: { type: 'offer', sdp: 'offer-sdp' },
  });
});

test('a non-initiator waits for the offer and answers it', async () => {
  const { socket, createPeerConnection, manager } = setup();

  await socket.dispatch('peer:connect', connectEvent({ initiator: false, generation: 1 }));
  assert.equal(socket.sent.length, 0, 'no offer before the remote one arrives');
  assert.equal(createPeerConnection.created[0].localDescription, null);

  await socket.dispatch('signal', offerSignal(1));
  const pc = createPeerConnection.created[0];
  assert.deepEqual(pc.remoteDescription, { type: 'offer', sdp: 'remote-offer' });
  assert.equal(pc.localDescription.type, 'answer');

  const signals = socket.signalsTo('bob');
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].payload, {
    to: 'bob',
    generation: 1,
    data: { type: 'answer', sdp: 'answer-sdp' },
  });
  assert.equal(manager.size(), 1);
});

test('the peer:connect iceServers win; the joined list is only a fallback', async () => {
  const joined = [{ urls: 'stun:joined.example' }];
  const { socket, createPeerConnection } = setup({ fallbackIceServers: joined });

  await socket.dispatch('joined', { selfId: 'me', iceServers: joined });
  await socket.dispatch('peer:connect', connectEvent({ iceServers: [{ urls: 'stun:edge.example' }] }));
  assert.deepEqual(createPeerConnection.created[0].configuration.iceServers, [
    { urls: 'stun:edge.example' },
  ]);

  await socket.dispatch('peer:connect', connectEvent({ peerId: 'cat', iceServers: [] }));
  assert.deepEqual(createPeerConnection.created[1].configuration.iceServers, joined,
    'an empty list falls back to the servers from joined');
});

test('local ICE candidates are signalled as they are gathered', async () => {
  const { socket, createPeerConnection } = setup();
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 4 }));
  const pc = createPeerConnection.created[0];

  pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:1 1 udp', sdpMid: '0' }) } });
  pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:2 1 udp' }) } });
  pc.onicecandidate({ candidate: null }); // end-of-candidates: nothing to trickle

  const candidates = socket
    .signalsTo('bob')
    .map((entry) => entry.payload.data)
    .filter((data) => data.type === 'candidate');
  assert.deepEqual(candidates, [
    { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0' } },
    { type: 'candidate', candidate: { candidate: 'candidate:2 1 udp' } },
  ]);
});

// ------------------------------------------------------------ ICE queueing ---

test('candidates before the remote description are queued and flushed in order', async () => {
  const { socket, createPeerConnection } = setup();
  await socket.dispatch('peer:connect', connectEvent({ initiator: false, generation: 1 }));
  const pc = createPeerConnection.created[0];

  await socket.dispatch('signal', candidateSignal(1, 'first'));
  await socket.dispatch('signal', candidateSignal(1, 'second'));
  await socket.dispatch('signal', candidateSignal(1, 'third'));
  assert.deepEqual(pc.addedCandidates, [], 'nothing is added before the remote SDP');

  await socket.dispatch('signal', offerSignal(1));
  assert.deepEqual(
    pc.addedCandidates.map((c) => c.candidate),
    ['candidate:first', 'candidate:second', 'candidate:third'],
    'queued candidates are flushed in arrival order after setRemoteDescription',
  );

  // Later candidates go straight in — no more queueing.
  await socket.dispatch('signal', candidateSignal(1, 'fourth'));
  assert.equal(pc.addedCandidates.length, 4);
});

test('the answer path also flushes candidates queued before the answer SDP', async () => {
  const { socket, createPeerConnection } = setup();
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 1 }));
  const pc = createPeerConnection.created[0];

  await socket.dispatch('signal', candidateSignal(1, 'early'));
  assert.deepEqual(pc.addedCandidates, []);

  await socket.dispatch('signal', { from: 'bob', generation: 1, data: { type: 'answer', sdp: 'remote-answer' } });
  assert.deepEqual(
    pc.addedCandidates.map((c) => c.candidate),
    ['candidate:early'],
  );
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'remote-answer' });
});

// ---------------------------------------------------- generations, one pc ---

test('stale-generation signals and signals from unknown peers are ignored', async () => {
  const { socket, createPeerConnection, manager } = setup();
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 2 }));
  const pc = createPeerConnection.created[0];

  await socket.dispatch('signal', offerSignal(1, 'stale-offer'));
  await socket.dispatch('signal', candidateSignal(7, 'stale'));
  assert.equal(pc.remoteDescription, null, 'no stale signal touches the connection');
  assert.equal(pc.addedCandidates.length, 0);

  await socket.dispatch('signal', { from: 'ghost', generation: 2, data: { type: 'offer', sdp: 'unknown-offer' } });
  assert.equal(pc.remoteDescription, null, 'unknown peers never create work');
  assert.equal(manager.size(), 1);
  assert.equal(socket.signalsTo('bob').length, 1, 'the original offer is still the only signal sent');
});

test('a newer-generation peer:connect closes the old connection first — one pc per peer', async () => {
  const { socket, createPeerConnection, manager } = setup();

  await socket.dispatch('peer:connect', connectEvent({ generation: 1 }));
  const first = createPeerConnection.created[0];
  await socket.dispatch('peer:connect', connectEvent({ generation: 5 }));
  const second = createPeerConnection.created[1];

  assert.equal(first.closed, true, 'the old generation is closed before the new one opens');
  assert.equal(manager.size(), 1, 'never two connections for one peer');
  assert.equal(manager.snapshot()[0].generation, 5);

  // Same generation again: a duplicate, ignored (no third pc).
  await socket.dispatch('peer:connect', connectEvent({ generation: 5 }));
  // Older generation: stale, ignored.
  await socket.dispatch('peer:connect', connectEvent({ generation: 4 }));
  assert.equal(createPeerConnection.created.length, 2);
  assert.equal(second.closed, false);
  assert.equal(manager.size(), 1);
});

test('a signal for the previous generation after a replacement is dropped', async () => {
  const { socket, createPeerConnection } = setup();
  await socket.dispatch('peer:connect', connectEvent({ generation: 1 }));
  await socket.dispatch('peer:connect', connectEvent({ generation: 2 }));
  const current = createPeerConnection.created[1];

  await socket.dispatch('signal', offerSignal(1, 'old-edge'));
  assert.equal(current.remoteDescription, null, 'only the current generation is applied');
});

// --------------------------------------------------------------- teardown ---

test('peer:disconnect closes the connection and removes the audio element', async () => {
  const { socket, createPeerConnection, remoteAudio, stats, manager } = setup();
  await socket.dispatch('peer:connect', connectEvent({ generation: 3 }));
  const pc = createPeerConnection.created[0];

  // Simulate the remote stream arriving (mic-on side hears the peer).
  pc.ontrack({ streams: [{ id: 'remote-stream' }] });
  assert.equal(remoteAudio.elements.size, 1);

  // A disconnect for an older generation is stale: nothing changes.
  await socket.dispatch('peer:disconnect', { peerId: 'bob', generation: 2 });
  assert.equal(pc.closed, false);
  assert.equal(remoteAudio.elements.size, 1);

  await socket.dispatch('peer:disconnect', { peerId: 'bob', generation: 3 });
  assert.equal(pc.closed, true);
  assert.equal(remoteAudio.elements.size, 0, 'the audio element is gone');
  assert.equal(stats.watched.size, 0, 'the stats poll is gone');
  assert.equal(manager.size(), 0, 'the registry entry is gone');

  // Unknown peers and repeats are no-ops.
  await socket.dispatch('peer:disconnect', { peerId: 'ghost', generation: 3 });
  await socket.dispatch('peer:disconnect', { peerId: 'bob', generation: 3 });
  assert.equal(manager.size(), 0);
});

test('a failed connection is cleaned up with no auto-retry', async () => {
  const { socket, createPeerConnection, manager } = setup();
  await socket.dispatch('peer:connect', connectEvent({ generation: 1 }));
  const pc = createPeerConnection.created[0];

  pc.connectionState = 'failed';
  pc.onconnectionstatechange();
  assert.equal(manager.size(), 0, 'the dead edge is dropped');
  assert.equal(createPeerConnection.created.length, 1, 'no retry connection is created');

  // The server re-creates the edge; that is the only path back.
  await socket.dispatch('peer:connect', connectEvent({ generation: 2 }));
  assert.equal(manager.size(), 1);
  assert.equal(createPeerConnection.created.length, 2);
});

test('closeAll leaves zero connections, audio elements, stats timers and active tracks', async () => {
  const { socket, createPeerConnection, localMedia, remoteAudio, stats, manager } = setup();
  await socket.dispatch('peer:connect', connectEvent({ peerId: 'bob', generation: 1 }));
  await socket.dispatch('peer:connect', connectEvent({ peerId: 'cat', name: 'Cat', generation: 1 }));
  const [pcBob, pcCat] = createPeerConnection.created;
  pcBob.ontrack({ streams: [{}] });
  pcCat.ontrack({ streams: [{}] });
  assert.equal(remoteAudio.elements.size, 2);
  assert.ok(localMedia.tracks.every((track) => !track.stopped));

  manager.closeAll();

  assert.equal(manager.size(), 0);
  assert.deepEqual(manager.snapshot(), []);
  assert.equal(remoteAudio.elements.size, 0);
  assert.equal(stats.watched.size, 0);
  assert.ok(stats.stopAllCalls >= 1, 'every stats timer is stopped');
  assert.equal(pcBob.closed, true);
  assert.equal(pcCat.closed, true);
  assert.ok(
    localMedia.tracks.every((track) => track.stopped),
    'no microphone track is left capturing',
  );
  assert.equal(localMedia.released, true);
});

test('listen-only adds a recvonly audio transceiver and no track', async () => {
  const { socket, createPeerConnection } = setup({ withMic: false });
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 1 }));
  const pc = createPeerConnection.created[0];

  assert.equal(pc.addedTracks.length, 0, 'nothing is sent in listen-only mode');
  assert.deepEqual(pc.transceivers, [{ kind: 'audio', direction: 'recvonly' }]);
});

// ------------------------------------------------------------ error safety ---

test('an exception inside a handler is caught and logged, never thrown', async () => {
  const socket = createFakeSocket();
  const logger = createFakeLogger();
  const createPeerConnection = () => {
    const pc = createFakePcFactory()({});
    pc.createOffer = () => {
      throw new Error('offer exploded');
    };
    return pc;
  };
  const manager = createPeerManager({
    socket,
    createPeerConnection,
    logger,
    localMedia: createFakeLocalMedia(),
    remoteAudio: createFakeRemoteAudio(),
    stats: createFakeStats(),
  });

  // dispatch awaits the safe wrapper; a crash would reject this line.
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 1 }));
  assert.equal(logger.errors.length, 1);
  assert.match(String(logger.errors[0].join(' ')), /offer exploded/);

  // A throwing setRemoteDescription is equally contained.
  const socket2 = createFakeSocket();
  const logger2 = createFakeLogger();
  const factory2 = createFakePcFactory();
  const manager2 = createPeerManager({
    socket: socket2,
    createPeerConnection: (configuration) => {
      const pc = factory2(configuration);
      pc.setRemoteDescription = () => Promise.reject(new Error('sdp exploded'));
      return pc;
    },
    logger: logger2,
    localMedia: createFakeLocalMedia({ withMic: false }),
    remoteAudio: createFakeRemoteAudio(),
    stats: createFakeStats(),
  });
  await socket2.dispatch('peer:connect', connectEvent({ generation: 1 }));
  await socket2.dispatch('signal', offerSignal(1));
  assert.equal(logger2.errors.length, 1);
  assert.match(String(logger2.errors[0].join(' ')), /sdp exploded/);
  assert.equal(manager2.size(), 1, 'the manager keeps serving after a logged error');

  manager.closeAll();
  manager2.closeAll();
  assert.equal(manager.size(), 0);
  assert.equal(manager2.size(), 0);
});

test('a disconnected socket never sends stale signaling', async () => {
  const { socket, manager } = setup();
  await socket.dispatch('peer:connect', connectEvent({ initiator: true, generation: 1 }));
  assert.equal(socket.signalsTo('bob').length, 1);

  socket.connected = false;
  await socket.dispatch('peer:connect', connectEvent({ peerId: 'cat', initiator: true, generation: 1 }));
  assert.equal(socket.signalsTo('cat').length, 0, 'offers wait for the connection to return');
  manager.closeAll();
});
