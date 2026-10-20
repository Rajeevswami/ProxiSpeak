import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioMixer } from '../src/audio/audioMixer.js';
import { createPeerManager } from '../src/webrtc/peerManager.js';

class FakeParam {
  constructor() {
    this.value = 1;
    this.targets = [];
  }
  setTargetAtTime(value, time, constant) {
    this.targets.push({ value, time, constant });
  }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    this.disconnectCalls = 0;
  }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnectCalls += 1; this.connections = []; }
}

class FakeGain extends FakeNode {
  constructor() {
    super('gain');
    this.gain = new FakeParam();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 12.5;
    this.destination = new FakeNode('destination');
    this.sources = [];
    this.gains = [];
    this.resumeCalls = 0;
    this.closeCalls = 0;
  }
  createMediaStreamSource(stream) {
    const source = new FakeNode('source');
    source.stream = stream;
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  async resume() {
    this.resumeCalls += 1;
    this.state = 'running';
  }
  async close() {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

function fakeElement() {
  return {
    muted: false,
    srcObject: { live: true },
    paused: false,
    removed: false,
    pause() { this.paused = true; },
    remove() { this.removed = true; },
  };
}

function fakeDocument() {
  const handlers = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name, handler) {
      if (handlers.get(name) === handler) handlers.delete(name);
    },
    dispatch(name) { handlers.get(name)?.(); },
    get listenerCount() { return handlers.size; },
  };
}

test('per-peer chain starts at zero, connects in order, and receives smoothed distance targets', async () => {
  let clock = 0;
  let factoryCalls = 0;
  const document = fakeDocument();
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakeAudioContext {
      constructor() { super(); factoryCalls += 1; }
    },
    document,
    now: () => clock,
  });
  await mixer.resume();
  const context = mixer.getContext();
  const element = fakeElement();
  const stream = { id: 'remote-stream' };
  const chain = mixer.attach('peer-a', stream, element);

  assert.equal(factoryCalls, 1, 'the app shares one AudioContext');
  assert.equal(element.muted, true, 'the media element stays attached but muted');
  assert.equal(chain.source.stream, stream);
  assert.equal(chain.source.connections[0], chain.gain, 'source connects to gain first');
  assert.equal(chain.gain.gain.value, 0, 'new peers start silent');
  assert.deepEqual(chain.gain.connections, [], 'destination is not connected before a distance update');

  const samples = [0, 15, 30, 65, 100];
  for (let index = 0; index < samples.length; index += 1) {
    clock = index * 50;
    const distance = samples[index];
    const updated = mixer.updateGains(
      { x: 0, y: 0 },
      () => ({ x: distance, y: 0 }),
      ['peer-a'],
    );
    assert.equal(updated, true);
    assert.equal(chain.gain.connections[0], context.destination);
  }

  assert.deepEqual(
    chain.gain.gain.targets.map(({ value }) => value),
    [1, 1, 1, 0.5, 0],
  );
  assert.ok(chain.gain.gain.targets.every(({ time, constant }) => time === context.currentTime && constant === 0.05));
  assert.deepEqual(mixer.peerMetrics('peer-a'), { distancePx: 100, volumePercent: 0 });
  await mixer.closeAll();
});

test('unknown remote position is silent; peer removal and closeAll disconnect nodes and remove elements', async () => {
  let clock = 0;
  const contexts = [];
  const document = fakeDocument();
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakeAudioContext {
      constructor() { super(); contexts.push(this); }
    },
    document,
    now: () => clock,
  });
  await mixer.resume();
  const firstElement = fakeElement();
  const secondElement = fakeElement();
  const first = mixer.attach('first', { id: 1 }, firstElement);
  const second = mixer.attach('second', { id: 2 }, secondElement);

  assert.equal(mixer.updateGains({ x: 1, y: 2 }, () => null, ['first']), true);
  assert.equal(first.gain.gain.targets[0].value, 0);
  assert.equal(first.gain.connections[0], contexts[0].destination);

  assert.equal(mixer.remove('first'), true);
  assert.equal(first.source.disconnectCalls, 1);
  assert.equal(first.gain.disconnectCalls, 1);
  assert.equal(firstElement.removed, true);
  assert.equal(mixer.remove('first'), false);

  await mixer.closeAll();
  assert.equal(second.source.disconnectCalls, 1);
  assert.equal(second.gain.disconnectCalls, 1);
  assert.equal(secondElement.removed, true);
  assert.equal(firstElement.removed, true);
  assert.equal(mixer.size(), 0);
  assert.equal(contexts[0].closeCalls, 1);
  assert.equal(document.listenerCount, 0);
});

test('suspended context resumes on the Join gesture and on a visible-tab event', async () => {
  const document = fakeDocument();
  const contexts = [];
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakeAudioContext {
      constructor() { super(); contexts.push(this); }
    },
    document,
  });

  await mixer.resume(); // called synchronously by the Join button handler
  assert.equal(contexts[0].resumeCalls, 1);
  contexts[0].state = 'suspended';
  document.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(contexts[0].resumeCalls, 2);
  await mixer.closeAll();
});

test('unavailable Web Audio falls back to full-volume elements and warns only once', async () => {
  const warnings = [];
  const mixer = createAudioMixer({
    AudioContextFactory: null,
    document: fakeDocument(),
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(await mixer.resume(), false);
  const one = fakeElement();
  const two = fakeElement();
  mixer.attach('one', { id: 1 }, one);
  mixer.attach('two', { id: 2 }, two);
  assert.equal(one.muted, false);
  assert.equal(two.muted, false);
  assert.equal(warnings.length, 1);
  assert.equal(mixer.size(), 2);
  await mixer.closeAll();
  assert.equal(one.removed, true);
  assert.equal(two.removed, true);
  assert.equal(mixer.size(), 0);
});

test('default fallback logger warns once when Web Audio is unavailable', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const mixer = createAudioMixer({ AudioContextFactory: null, document: fakeDocument() });
    await mixer.resume();
    mixer.attach('one', { id: 1 }, fakeElement());
    mixer.attach('two', { id: 2 }, fakeElement());
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], '[audio]');
    await mixer.closeAll();
  } finally {
    console.warn = originalWarn;
  }
});

test('gain updates are internally throttled to at most 20 Hz', async () => {
  let clock = 0;
  const mixer = createAudioMixer({ AudioContextFactory: FakeAudioContext, now: () => clock });
  await mixer.resume();
  const { gain } = mixer.attach('peer', { id: 1 }, fakeElement());
  const update = () => mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 15, y: 0 }), ['peer']);

  assert.equal(update(), true);
  clock = 49;
  assert.equal(update(), false);
  assert.equal(gain.gain.targets.length, 1);
  clock = 50;
  assert.equal(update(), true);
  assert.equal(gain.gain.targets.length, 2);
  await mixer.closeAll();
});

test('peerManager routes remote tracks into muted elements and cleans their mixer chain on peer close', async () => {
  const socket = { on() {}, emit() {} };
  const pc = {
    connectionState: 'new',
    addTransceiver() {},
    close() {},
    ontrack: null,
    onicecandidate: null,
    onconnectionstatechange: null,
  };
  const stream = { id: 'remote' };
  const element = fakeElement();
  const audioCalls = [];
  const mixerCalls = [];
  const audio = {
    attach(peerId, gotStream, options) {
      audioCalls.push({ peerId, gotStream, options });
      element.muted = options.muted;
      return element;
    },
    remove(peerId) { audioCalls.push({ remove: peerId }); },
    removeAll() {},
  };
  const mixer = {
    attach: (...args) => mixerCalls.push(['attach', ...args]),
    remove: (peerId) => mixerCalls.push(['remove', peerId]),
    closeAll: () => mixerCalls.push(['closeAll']),
  };
  const stats = { watch() {}, unwatch() {}, stopAll() {}, get() { return null; } };
  const manager = createPeerManager({
    socket,
    createPeerConnection: () => pc,
    remoteAudio: audio,
    audioMixer: mixer,
    stats,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await manager.handlePeerConnect({ peerId: 'peer', generation: 1, initiator: false });
  pc.ontrack({ streams: [stream] });

  assert.equal(audioCalls[0].options.muted, true);
  assert.equal(element.muted, true);
  assert.deepEqual(mixerCalls[0], ['attach', 'peer', stream, element]);
  await manager.handlePeerDisconnect({ peerId: 'peer', generation: 1 });
  assert.ok(mixerCalls.some((call) => call[0] === 'remove' && call[1] === 'peer'));
  assert.ok(audioCalls.some((call) => call.remove === 'peer'));
});
