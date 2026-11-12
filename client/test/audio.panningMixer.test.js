import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioMixer, TARGET_TIME_CONSTANT } from '../src/audio/audioMixer.js';
import { PAN_TIME_CONSTANT } from '../src/audio/panning.js';
import { gainForDistance } from '../src/audio/attenuation.js';

/** AudioParam fake: records `value` writes separately from scheduled automation. */
class FakeParam {
  constructor(initial) {
    this._value = initial;
    this.valueWrites = 0;
    this.setValueCalls = [];
    this.targets = [];
  }
  get value() { return this._value; }
  set value(next) { this.valueWrites += 1; this._value = next; }
  setValueAtTime(value, time) { this.setValueCalls.push({ value, time }); this._value = value; }
  setTargetAtTime(value, time, constant) { this.targets.push({ value, time, constant }); }
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

class FakeSource extends FakeNode {
  constructor(stream) {
    super('source');
    this.stream = stream;
  }
}

class FakePanner extends FakeNode {
  constructor() {
    super('panner');
    this.pan = new FakeParam(0);
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super('gain');
    this.gain = new FakeParam(1);
  }
}

/** Context with a StereoPannerNode; every created node is recorded for leak checks. */
class FakePannerContext {
  constructor({ withPanner = true } = {}) {
    this.state = 'running';
    this.currentTime = 3;
    this.destination = new FakeNode('destination');
    this.created = [];
    this.resumeCalls = 0;
    this.closeCalls = 0;
    if (withPanner) this.createStereoPanner = () => this.track(new FakePanner());
  }
  track(node) { this.created.push(node); return node; }
  createMediaStreamSource(stream) { return this.track(new FakeSource(stream)); }
  createGain() { return this.track(new FakeGain()); }
  async resume() { this.resumeCalls += 1; }
  async close() { this.closeCalls += 1; this.state = 'closed'; }
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
  return {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Build a mixer whose clock advances 50 ms per update so every tick is accepted. */
function makeMixer(contextOptions = {}, extra = {}) {
  let clock = 0;
  const contexts = [];
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakePannerContext {
      constructor() { super(contextOptions); contexts.push(this); }
    },
    document: fakeDocument(),
    logger: { warn() {} },
    now: () => clock,
    ...extra,
  });
  return {
    mixer,
    contexts,
    tick(ms = 50) { clock += ms; },
    get context() { return contexts[0]; },
  };
}

/** Walls/obstacles in the same room coordinate space as the peers. */
const WALL_RIGHT = { id: 'wall-right', x: 35, y: -50, w: 10, h: 100, blocksAudio: true, attenuation: 0.12 };
const WALL_LEFT = { id: 'wall-left', x: -45, y: -50, w: 10, h: 100, blocksAudio: true, attenuation: 0.12 };

test('every peer chain is source -> StereoPannerNode -> GainNode -> destination', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  const chains = ['a', 'b', 'c'].map((id) => h.mixer.attach(id, { id }, fakeElement()));

  for (const chain of chains) {
    const source = chain.source;
    const panner = source.connections[0];
    assert.equal(source.connections.length, 1, 'source has exactly one output');
    assert.equal(panner.kind, 'panner');
    assert.deepEqual(panner.connections, [chain.gain], 'panner feeds the gain');
    assert.deepEqual(chain.gain.connections, [], 'gain is silent until the first update');
  }

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, (id) => ({ x: 10, y: 0 }), ['a', 'b', 'c']);
  for (const chain of chains) {
    assert.deepEqual(chain.gain.connections, [h.context.destination], 'gain reaches the destination after the first update');
  }
  assert.equal(h.context.created.filter((n) => n.kind === 'panner').length, 3, 'one panner per peer');
  await h.mixer.closeAll();
});

test('first pan uses setValueAtTime with no sweep, later pans use setTargetAtTime with PAN_TIME_CONSTANT', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  const panner = h.mixer.attach('peer', { id: 1 }, fakeElement()).source.connections[0];

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 70, y: 0 }), ['peer']);
  assert.deepEqual(panner.pan.setValueCalls, [{ value: 0.85, time: 3 }], 'initial pan is set directly');
  assert.equal(panner.pan.targets.length, 0, 'no smoothing on the first connection');

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: -70, y: 0 }), ['peer']);
  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 0, y: 70 }), ['peer']);

  assert.equal(panner.pan.setValueCalls.length, 1, 'setValueAtTime only once');
  assert.deepEqual(
    panner.pan.targets.map(({ value }) => value),
    [-0.85, 0],
    'later targets follow the speaker',
  );
  assert.ok(panner.pan.targets.every(({ time, constant }) => time === 3 && constant === PAN_TIME_CONSTANT));
  assert.equal(PAN_TIME_CONSTANT, 0.05);
  assert.equal(panner.pan.valueWrites, 0, 'no direct pan.value writes at any point');
  await h.mixer.closeAll();
});

test('pan targets match the worked geometries and gain follows distance', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  const cases = [
    ['right-near', { x: 10, y: 0 }, 0.28333],
    ['right-inner', { x: 30, y: 0 }, 0.85],
    ['right-far', { x: 70, y: 0 }, 0.85],
    ['left-far', { x: -70, y: 0 }, -0.85],
    ['centre-below', { x: 0, y: 70 }, 0],
    ['diagonal-far', { x: 70, y: 70 }, 0.60104],
    ['diagonal-inner', { x: 20, y: 20 }, 0.56667],
    ['same-spot', { x: 0, y: 0 }, 0],
  ];
  const ids = cases.map(([id]) => id);
  const positions = new Map(cases.map(([id, pos]) => [id, pos]));
  for (const id of ids) h.mixer.attach(id, { id }, fakeElement());

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, (id) => positions.get(id), ids);

  for (const [id, pos, expectedPan] of cases) {
    const chain = h.contexts[0].created.find((n) => n.kind === 'source' && n.stream.id === id);
    const panner = chain.connections[0];
    const pan = panner.pan.setValueCalls[0].value;
    assert.ok(Math.abs(pan - expectedPan) <= 1e-5, `${id}: expected ${expectedPan}, got ${pan}`);

    const dist = Math.hypot(pos.x, pos.y);
    const expectedGain = gainForDistance(dist, { innerPx: 30, outerPx: 100 });
    const gainTarget = chain.connections[0].connections[0].gain.targets[0].value;
    assert.ok(Math.abs(gainTarget - expectedGain) <= 1e-9, `${id}: gain ${gainTarget} vs ${expectedGain}`);
  }
  await h.mixer.closeAll();
});

test('a blocked peer is quieter but keeps its side (panning ignores obstacles)', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  const room = { roomId: 'lobby', layoutRevision: 1, obstacles: [WALL_RIGHT, WALL_LEFT] };
  const positions = { 'blocked-right': { x: 70, y: 0 }, 'blocked-left': { x: -70, y: 0 } };
  h.mixer.attach('blocked-right', { id: 'blocked-right' }, fakeElement());
  h.mixer.attach('blocked-left', { id: 'blocked-left' }, fakeElement());

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, (id) => positions[id], Object.keys(positions), room);

  const byId = (id) => h.contexts[0].created.find((n) => n.kind === 'source' && n.stream.id === id);
  const rightPan = byId('blocked-right').connections[0].pan.setValueCalls[0].value;
  const leftPan = byId('blocked-left').connections[0].pan.setValueCalls[0].value;
  const rightGain = byId('blocked-right').connections[0].connections[0].gain.targets[0].value;
  const leftGain = byId('blocked-left').connections[0].connections[0].gain.targets[0].value;

  assert.ok(rightPan > 0.8, `blocked right speaker stays on the right (${rightPan})`);
  assert.ok(leftPan < -0.8, `blocked left speaker stays on the left (${leftPan})`);
  assert.ok(rightGain < 0.1, `blocked right speaker is attenuated (${rightGain})`);
  assert.ok(leftGain < 0.1, `blocked left speaker is attenuated (${leftGain})`);

  // Same geometry with the walls removed (layout revision 2): identical pan, much louder.
  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, (id) => positions[id], ['blocked-right'], { roomId: 'lobby', layoutRevision: 2, obstacles: [] });
  const openGain = byId('blocked-right').connections[0].connections[0].gain.targets.at(-1).value;
  const openPan = byId('blocked-right').connections[0].pan.targets.at(-1).value;
  assert.ok(openGain > rightGain * 5, 'removing the wall restores volume');
  assert.ok(Math.abs(openPan - rightPan) <= 1e-9, 'pan unchanged by obstacles');
  await h.mixer.closeAll();
});

test('without createStereoPanner the chain is source -> gain -> destination and warns once', async () => {
  const warnings = [];
  const h = makeMixer({ withPanner: false }, { logger: { warn: (m) => warnings.push(m) } });
  await h.mixer.resume();
  const first = h.mixer.attach('one', { id: 1 }, fakeElement());
  const second = h.mixer.attach('two', { id: 2 }, fakeElement());

  assert.equal(first.source.connections[0], first.gain, 'source connects straight to the gain');
  assert.equal(second.source.connections[0], second.gain);
  assert.equal(h.context.created.some((n) => n.kind === 'panner'), false);
  assert.equal(warnings.length, 1, 'one warning for the whole mixer');

  h.tick();
  assert.doesNotThrow(() => h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 70, y: 0 }), ['one', 'two']));
  assert.equal(first.gain.connections[0], h.context.destination);
  assert.equal(h.mixer.peerPan('one'), null, 'no pan value without a panner');
  assert.equal(warnings.length, 1);
  await h.mixer.closeAll();
});

test('peer removal and closeAll disconnect source, panner and gain nodes with no leftovers over 50 cycles', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  let allNodes = [];
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const ids = [`c${cycle}-a`, `c${cycle}-b`, `c${cycle}-c`];
    for (const id of ids) h.mixer.attach(id, { id }, fakeElement());
    h.tick();
    h.mixer.updateGains({ x: 0, y: 0 }, (id) => ({ x: 20, y: 5 }), ids);
    h.mixer.remove(ids[0]);
    h.mixer.remove(ids[1]);
    h.mixer.remove(ids[2]);
    allNodes = allNodes.concat(h.context.created.slice());
    h.context.created.length = 0;
    assert.equal(h.mixer.size(), 0);
    // Removal disconnects panner-chain nodes; a later attach creates fresh ones.
  }
  // Every node created in every cycle must have been disconnected.
  const leftovers = allNodes.filter((n) => n.kind !== 'destination' && n.disconnectCalls === 0);
  assert.equal(leftovers.length, 0, 'every node was disconnected');
  assert.equal(allNodes.filter((n) => n.kind === 'panner').length, 150, 'three panners per cycle');

  // closeAll path: peers still attached are disconnected too.
  const attachedIds = ['x-1', 'x-2'];
  for (const id of attachedIds) h.mixer.attach(id, { id }, fakeElement());
  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 15, y: 0 }), attachedIds);
  const attachedNodes = h.context.created.slice();
  await h.mixer.closeAll();
  assert.equal(h.mixer.size(), 0);
  assert.equal(attachedNodes.filter((n) => n.disconnectCalls === 0).length, 0, 'closeAll leaves nothing connected');
  assert.equal(h.context.closeCalls, 1);
});

test('updates stay throttled to at most 20 Hz and pan follows exactly the accepted ticks', async () => {
  let clock = 0;
  const contexts = [];
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakePannerContext {
      constructor() { super(); contexts.push(this); }
    },
    document: fakeDocument(),
    now: () => clock,
  });
  await mixer.resume();
  const chain = mixer.attach('peer', { id: 1 }, fakeElement());
  const panner = chain.source.connections[0];
  const update = () => mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 15, y: 0 }), ['peer']);

  assert.equal(update(), true);
  clock = 49;
  assert.equal(update(), false, 'a tick 49 ms later is skipped');
  assert.equal(panner.pan.setValueCalls.length + panner.pan.targets.length, 1);
  clock = 50;
  assert.equal(update(), true);
  clock = 120;
  assert.equal(update(), true);
  assert.equal(panner.pan.targets.length, 2, 'one smoothed pan write per accepted tick');
  assert.equal(chain.gain.gain.targets.length, 3, 'gain is still written on each accepted tick');
  assert.equal(TARGET_TIME_CONSTANT, 0.05);
  await mixer.closeAll();
});

test('Web Audio unavailable still falls back to full-volume elements with no panner', async () => {
  const warnings = [];
  const mixer = createAudioMixer({
    AudioContextFactory: null,
    document: fakeDocument(),
    logger: { warn: (m) => warnings.push(m) },
  });
  const element = fakeElement();
  mixer.attach('peer', { id: 1 }, element);
  assert.equal(element.muted, false);
  assert.equal(mixer.peerPan('peer'), null);
  assert.doesNotThrow(() => mixer.updateGains({ x: 0, y: 0 }, () => ({ x: 70, y: 0 }), ['peer']));
  assert.equal(mixer.peerMetrics('peer').volumePercent, 100);
  assert.equal(warnings.length, 1, 'the Web Audio fallback warning is still the only warning');
  await mixer.closeAll();
  assert.equal(element.removed, true);
});

test('a room:layout change alters gain without re-join and leaves pan unchanged', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  const roomOpen = { roomId: 'lobby', layoutRevision: 1, obstacles: [] };
  const roomWalled = { roomId: 'lobby', layoutRevision: 2, obstacles: [WALL_RIGHT] };
  const element = fakeElement();
  const chain = h.mixer.attach('peer', { id: 'peer' }, element);
  const position = () => ({ x: 70, y: 0 });

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, position, ['peer'], roomOpen);
  const beforeGain = chain.gain.gain.targets.at(-1).value;
  const beforePan = chain.source.connections[0].pan.setValueCalls[0].value;

  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, position, ['peer'], roomWalled);
  const afterGain = chain.gain.gain.targets.at(-1).value;
  const panTargets = chain.source.connections[0].pan.targets;

  assert.ok(afterGain < beforeGain * 0.2, `wall lowers gain (${beforeGain} -> ${afterGain})`);
  assert.ok(panTargets.length === 1 && Math.abs(panTargets[0].value - beforePan) <= 1e-9, 'pan target unchanged by the layout');
  assert.equal(h.mixer.size(), 1, 'no re-join: the same peer chain');
  assert.equal(h.mixer.peerTransmission('peer'), 0.12);
  assert.equal(element.removed, false);
  await h.mixer.closeAll();
});

test('peerPan exposes the last applied pan for overlay derivation', async () => {
  const h = makeMixer();
  await h.mixer.resume();
  h.mixer.attach('peer', { id: 1 }, fakeElement());
  assert.equal(h.mixer.peerPan('peer'), 0, 'starts centred');
  assert.equal(h.mixer.peerPan('missing'), null);
  h.tick();
  h.mixer.updateGains({ x: 0, y: 0 }, () => ({ x: -10, y: 0 }), ['peer']);
  assert.ok(Math.abs(h.mixer.peerPan('peer') - (-0.28333)) <= 1e-5);
  await h.mixer.closeAll();
});
