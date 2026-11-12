/**
 * Unit, property, cross-check and mixer integration tests for sound-blocking
 * obstacles — Week 3 (Day 16).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceBetween, gainForDistance } from '../src/audio/attenuation.js';
import {
  PARAM_EPSILON,
  createObstacleCache,
  derivePeerVolume,
  formatPeerVolume,
  prepareObstacles,
  segmentIntersectsRect,
  transmissionBetween,
} from '../src/audio/occlusion.js';
import {
  OCCLUSION_TIME_CONSTANT,
  TARGET_TIME_CONSTANT,
  createAudioMixer,
} from '../src/audio/audioMixer.js';
import {
  applyJoinedSnapshot,
  createWorldState,
  updateRoomLayout,
} from '../src/realtime/worldState.js';
import { SEEDED_LOBBY_OBSTACLES, computeWorkedTable, runOcclusionBenchmark } from '../scripts/occlusion-bench.js';

function makePrng(seed = 1620261027) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Independent reference method for closed segment vs closed rectangle:
 * endpoint-in-rectangle check plus 2D cross-product orientation test against
 * each of the four closed boundary edges of [x, x+w] x [y, y+h].
 *
 * Scales collinearity tolerance by segment and edge Manhattan lengths times
 * `PARAM_EPSILON` (4 * Number.EPSILON) to match IEEE-754 float64 precision.
 */
function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointOnClosedSegmentBox(ax, ay, bx, by, px, py) {
  return (
    px >= Math.min(ax, bx) &&
    px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) &&
    py <= Math.max(ay, by)
  );
}

function segmentsIntersectRef(ax, ay, bx, by, cx, cy, dx, dy) {
  const scale = (Math.abs(bx - ax) + Math.abs(by - ay))
    * (Math.abs(dx - cx) + Math.abs(dy - cy))
    * PARAM_EPSILON;
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);

  if (
    ((o1 > scale && o2 < -scale) || (o1 < -scale && o2 > scale)) &&
    ((o3 > scale && o4 < -scale) || (o3 < -scale && o4 > scale))
  ) {
    return true;
  }
  if (Math.abs(o1) <= scale && pointOnClosedSegmentBox(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(o2) <= scale && pointOnClosedSegmentBox(ax, ay, bx, by, dx, dy)) return true;
  if (Math.abs(o3) <= scale && pointOnClosedSegmentBox(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(o4) <= scale && pointOnClosedSegmentBox(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

function segmentIntersectsRectReference(ax, ay, bx, by, rect) {
  const x0 = rect.x;
  const x1 = rect.x + rect.w;
  const y0 = rect.y;
  const y1 = rect.y + rect.h;

  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
  if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) return true;

  return (
    segmentsIntersectRef(ax, ay, bx, by, x0, y0, x1, y0) ||
    segmentsIntersectRef(ax, ay, bx, by, x1, y0, x1, y1) ||
    segmentsIntersectRef(ax, ay, bx, by, x1, y1, x0, y1) ||
    segmentsIntersectRef(ax, ay, bx, by, x0, y1, x0, y0)
  );
}

class TrackingParam {
  constructor() {
    this._value = 1;
    this.directWrites = 0;
    this.targets = [];
  }
  get value() {
    return this._value;
  }
  set value(next) {
    this._value = next;
    this.directWrites += 1;
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
    this.gain = new TrackingParam();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 4.25;
    this.destination = new FakeNode('destination');
    this.sources = [];
    this.gains = [];
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
  async resume() { this.state = 'running'; }
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
  const handlers = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name, handler) {
      if (handlers.get(name) === handler) handlers.delete(name);
    },
    get listenerCount() { return handlers.size; },
  };
}

test('segmentIntersectsRect covers crossing, miss, parallel, edge/corner touch, inside, zero-length, long and room-limit cases symmetrically', () => {
  const rect = { x: 100, y: 200, w: 60, h: 80 }; // [100, 160] x [200, 280]

  const cases = [
    // Crossing interior (horizontal, vertical, diagonals)
    [80, 240, 180, 240, rect, true, 'horizontal through interior'],
    [130, 180, 130, 300, rect, true, 'vertical through interior'],
    [80, 180, 180, 300, rect, true, 'diagonal top-left to bottom-right'],
    [80, 300, 180, 180, rect, true, 'diagonal bottom-left to top-right'],

    // Misses (outside bounding box and diagonal near-corner misses whose AABB overlaps rect)
    [10, 240, 99.999, 240, rect, false, 'horizontal stopping left of rect'],
    [130, 280.001, 130, 350, rect, false, 'vertical starting below rect'],
    [80, 210, 110, 180, rect, false, 'diagonal AABB overlaps top-left corner but misses'],
    [150, 180, 180, 210, rect, false, 'diagonal AABB overlaps top-right corner but misses'],
    [80, 270, 110, 300, rect, false, 'diagonal AABB overlaps bottom-left corner but misses'],
    [150, 300, 180, 270, rect, false, 'diagonal AABB overlaps bottom-right corner but misses'],

    // Parallel to edges: outside vs inside
    [80, 199.5, 180, 199.5, rect, false, 'parallel above top edge'],
    [80, 280.5, 180, 280.5, rect, false, 'parallel below bottom edge'],
    [99.5, 180, 99.5, 300, rect, false, 'parallel left of left edge'],
    [160.5, 180, 160.5, 300, rect, false, 'parallel right of right edge'],
    [110, 205, 150, 205, rect, true, 'horizontal parallel inside'],
    [105, 210, 105, 270, rect, true, 'vertical parallel inside'],

    // Touching edges (collinear and endpoint contact)
    [80, 200, 180, 200, rect, true, 'collinear along top edge'],
    [80, 280, 180, 280, rect, true, 'collinear along bottom edge'],
    [100, 180, 100, 300, rect, true, 'collinear along left edge'],
    [160, 180, 160, 300, rect, true, 'collinear along right edge'],
    [50, 240, 100, 240, rect, true, 'endpoint touches left edge'],
    [130, 320, 130, 280, rect, true, 'endpoint touches bottom edge'],

    // Touching corners (diagonal grazing and endpoint at corner)
    [80, 220, 120, 180, rect, true, 'diagonal grazes top-left corner (100,200)'],
    [140, 180, 180, 220, rect, true, 'diagonal grazes top-right corner (160,200)'],
    [80, 260, 120, 300, rect, true, 'diagonal grazes bottom-left corner (100,280)'],
    [140, 300, 180, 260, rect, true, 'diagonal grazes bottom-right corner (160,280)'],
    [50, 150, 100, 200, rect, true, 'endpoint lands exactly on top-left corner'],
    [0.1, 0.2, 0.7, 0.5, { x: 0.4, y: 0, w: 0.6, h: 0.35 }, true, 'float64 binary-inexact corner touch'],

    // One endpoint inside / both endpoints inside
    [120, 230, 250, 400, rect, true, 'listener inside, speaker outside'],
    [20, 40, 155, 275, rect, true, 'listener outside, speaker inside'],
    [110, 210, 150, 270, rect, true, 'both endpoints strictly inside'],

    // Zero-length segments (same position)
    [130, 240, 130, 240, rect, true, 'zero-length strictly inside'],
    [100, 200, 100, 200, rect, true, 'zero-length on corner'],
    [160, 250, 160, 250, rect, true, 'zero-length on right edge'],
    [99.99, 240, 99.99, 240, rect, false, 'zero-length just outside'],
    [500, 500, 500, 500, rect, false, 'zero-length far outside'],

    // Very long segments (hitting vs missing by a small margin)
    [-1e9, -1e9, 1e9, 1e9, { x: -5, y: -5, w: 10, h: 10 }, true, '2e9 diagonal hitting origin rect'],
    [-1e9, -1e9 + 50, 1e9, 1e9 + 50, { x: -5, y: -5, w: 10, h: 10 }, false, '2e9 diagonal missing origin rect'],

    // Coordinates at room limits (1920 x 1080)
    [0, 0, 1920, 1080, { x: 1880, y: 1040, w: 40, h: 40 }, true, 'room diagonal hitting bottom-right boundary obstacle'],
    [0, 1080, 1920, 1080, { x: 900, y: 1060, w: 80, h: 20 }, true, 'segment along bottom room limit y=1080'],
    [1920, 0, 1920, 1080, { x: 0, y: 0, w: 40, h: 1080 }, false, 'right room wall misses left room obstacle'],
  ];

  for (const [ax, ay, bx, by, r, expected, label] of cases) {
    assert.equal(segmentIntersectsRect(ax, ay, bx, by, r), expected, label);
    assert.equal(segmentIntersectsRect(bx, by, ax, ay, r), expected, `${label} (swapped endpoints)`);
  }

  // Invalid inputs return false without throwing
  assert.equal(segmentIntersectsRect(NaN, 0, 10, 10, rect), false);
  assert.equal(segmentIntersectsRect(0, 0, Infinity, 10, rect), false);
  assert.equal(segmentIntersectsRect(0, 0, 10, 10, null), false);
  assert.equal(segmentIntersectsRect(0, 0, 10, 10, { x: 0, y: 0, w: 0, h: 10 }), false);
  assert.equal(segmentIntersectsRect(0, 0, 10, 10, { x: 0, y: 0, w: -5, h: 10 }), false);
});

test('independent cross-check: 20,000 random segment/rectangle cases match 4-edge + point-in-rect reference with zero disagreements', () => {
  const rand = makePrng(20261027);
  let disagreements = 0;
  let asymmetries = 0;
  const totalCases = 20000;

  for (let i = 0; i < totalCases; i += 1) {
    let rect;
    let ax;
    let ay;
    let bx;
    let by;
    const bucket = i % 5;

    if (bucket === 0) {
      // Uniform float coordinates across 1920 x 1080 room
      const x = rand() * 1880;
      const y = rand() * 1040;
      rect = { x, y, w: 1 + rand() * Math.min(300, 1920 - x), h: 1 + rand() * Math.min(300, 1080 - y) };
      ax = rand() * 1920;
      ay = rand() * 1080;
      bx = rand() * 1920;
      by = rand() * 1080;
    } else if (bucket === 1) {
      // Grid-snapped integer coordinates (frequent exact edge/corner contacts)
      rect = {
        x: Math.floor(rand() * 16) * 100,
        y: Math.floor(rand() * 9) * 100,
        w: (1 + Math.floor(rand() * 3)) * 100,
        h: (1 + Math.floor(rand() * 3)) * 100,
      };
      ax = Math.floor(rand() * 20) * 100;
      ay = Math.floor(rand() * 12) * 100;
      bx = Math.floor(rand() * 20) * 100;
      by = Math.floor(rand() * 12) * 100;
    } else if (bucket === 2) {
      // Axis-aligned horizontal and vertical segments
      rect = { x: rand() * 1700, y: rand() * 900, w: 5 + rand() * 200, h: 5 + rand() * 150 };
      ax = rand() * 1920;
      ay = rand() * 1080;
      if (rand() < 0.5) {
        bx = ax;
        by = rand() * 1080;
      } else {
        bx = rand() * 1920;
        by = ay;
      }
    } else if (bucket === 3) {
      // Zero-length segments (inside, boundary, outside)
      rect = { x: 200 + rand() * 800, y: 100 + rand() * 500, w: 10 + rand() * 200, h: 10 + rand() * 200 };
      ax = rand() * 1920;
      ay = rand() * 1080;
      bx = ax;
      by = ay;
    } else {
      // Very long segments across [-1e5, 1e5]
      rect = { x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000, w: 1 + rand() * 400, h: 1 + rand() * 400 };
      ax = (rand() - 0.5) * 2e5;
      ay = (rand() - 0.5) * 2e5;
      bx = (rand() - 0.5) * 2e5;
      by = (rand() - 0.5) * 2e5;
    }

    const forward = segmentIntersectsRect(ax, ay, bx, by, rect);
    const reverse = segmentIntersectsRect(bx, by, ax, ay, rect);
    const reference = segmentIntersectsRectReference(ax, ay, bx, by, rect);

    if (forward !== reverse) asymmetries += 1;
    if (forward !== reference) disagreements += 1;
  }

  assert.equal(asymmetries, 0, 'endpoint swap must be 100% symmetric');
  assert.equal(disagreements, 0, 'Liang-Barsky and 4-edge reference must have zero disagreements across 20,000 cases');
});

test('transmissionBetween handles empty, single, multiplicative, non-blocking, 0/1 bounds, deduplication, invalid entries and monotonicity', () => {
  const a = { x: 100, y: 100 };
  const b = { x: 300, y: 100 };

  // No obstacles = 1
  assert.equal(transmissionBetween(a, b, []), 1);
  assert.equal(transmissionBetween(a, b, null), 1);
  assert.equal(transmissionBetween(a, b, undefined), 1);

  // One obstacle = its attenuation
  const wall = { id: 'w1', x: 180, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: 0.12 };
  assert.equal(transmissionBetween(a, b, [wall]), 0.12);
  assert.equal(transmissionBetween(b, a, [wall]), 0.12);

  // Several obstacles multiply
  const screen = { id: 's1', x: 240, y: 50, w: 14, h: 100, blocksAudio: true, attenuation: 0.45 };
  const desk = { id: 'd1', x: 120, y: 80, w: 30, h: 40, blocksAudio: true, attenuation: 0.5 };
  assert.ok(Math.abs(transmissionBetween(a, b, [wall, screen, desk]) - (0.12 * 0.45 * 0.5)) < 1e-15);
  assert.equal(
    transmissionBetween(a, b, [wall, screen, desk]),
    transmissionBetween(b, a, [wall, screen, desk]),
  );

  // blocksAudio: false ignored
  const nonBlocking = { id: 'rug', x: 150, y: 50, w: 80, h: 100, blocksAudio: false, attenuation: 0.05 };
  assert.equal(transmissionBetween(a, b, [nonBlocking]), 1);
  assert.equal(transmissionBetween(a, b, [wall, nonBlocking]), 0.12);

  // attenuation 0 gives 0; attenuation 1 gives 1
  const opaque = { id: 'vault', x: 190, y: 50, w: 20, h: 100, blocksAudio: true, attenuation: 0 };
  const transparent = { id: 'air', x: 190, y: 50, w: 20, h: 100, blocksAudio: true, attenuation: 1 };
  assert.equal(transmissionBetween(a, b, [wall, opaque, screen]), 0);
  assert.equal(transmissionBetween(a, b, [transparent]), 1);

  // Same obstacle counted once (crossing two edges of one rect, duplicate object ref, duplicate id)
  assert.equal(transmissionBetween(a, b, [wall, wall]), 0.12);
  assert.equal(
    transmissionBetween(a, b, [
      wall,
      { id: 'w1', x: 180, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: 0.12 },
    ]),
    0.12,
  );

  // Invalid / NaN / negative-size / out-of-bounds attenuation entries ignored or clamped without throwing
  const messy = [
    null,
    undefined,
    'not-an-object',
    [],
    { id: 'nan-x', x: NaN, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: 0.2 },
    { id: 'inf-y', x: 180, y: Infinity, w: 40, h: 100, blocksAudio: true, attenuation: 0.2 },
    { id: 'zero-w', x: 180, y: 50, w: 0, h: 100, blocksAudio: true, attenuation: 0.2 },
    { id: 'neg-h', x: 180, y: 50, w: 40, h: -10, blocksAudio: true, attenuation: 0.2 },
    { id: 'nan-att', x: 180, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: NaN },
    { id: 'no-flag', x: 180, y: 50, w: 40, h: 100, attenuation: 0.2 },
    { id: 'clamp-high', x: 180, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: 1.8 },
  ];
  const preparedMessy = prepareObstacles(messy);
  assert.equal(preparedMessy.length, 1);
  assert.equal(preparedMessy[0].attenuation, 1);
  assert.equal(transmissionBetween(a, b, messy), 1);

  const clampedLow = prepareObstacles([
    { id: 'clamp-low', x: 180, y: 50, w: 40, h: 100, blocksAudio: true, attenuation: -0.5 },
  ]);
  assert.equal(clampedLow[0].attenuation, 0);
  assert.equal(transmissionBetween(a, b, clampedLow), 0);

  // Property test: adding an obstacle never increases T
  const rand = makePrng(998877);
  for (let trial = 0; trial < 300; trial += 1) {
    const p1 = { x: rand() * 1920, y: rand() * 1080 };
    const p2 = { x: rand() * 1920, y: rand() * 1080 };
    const baseCount = Math.floor(rand() * 8);
    const base = [];
    for (let k = 0; k < baseCount; k += 1) {
      base.push({
        id: `obs-${trial}-${k}`,
        x: rand() * 1800,
        y: rand() * 980,
        w: 10 + rand() * 120,
        h: 10 + rand() * 120,
        blocksAudio: rand() < 0.85,
        attenuation: rand(),
      });
    }
    const extra = {
      id: `obs-${trial}-extra`,
      x: rand() * 1800,
      y: rand() * 980,
      w: 10 + rand() * 300,
      h: 10 + rand() * 300,
      blocksAudio: true,
      attenuation: rand(),
    };
    const tBefore = transmissionBetween(p1, p2, base);
    const tAfter = transmissionBetween(p1, p2, [...base, extra]);
    assert.ok(tBefore >= 0 && tBefore <= 1);
    assert.ok(tAfter >= 0 && tAfter <= 1);
    assert.ok(tAfter <= tBefore + 1e-15, `adding obstacle must not increase T (${tAfter} <= ${tBefore})`);
  }
});

test('layout caching reuses prepared obstacles on the same revision and rebuilds on a new revision', () => {
  const rev1List = [{ id: 'w-a', x: 100, y: 100, w: 40, h: 200, blocksAudio: true, attenuation: 0.2 }];
  const rev2List = [{ id: 'w-b', x: 300, y: 100, w: 40, h: 200, blocksAudio: true, attenuation: 0.5 }];

  // Direct prepareObstacles(obstacles, layoutRevision) cache
  const directA = prepareObstacles(rev1List, 10);
  const directB = prepareObstacles([{ id: 'ignored-same-rev', x: 0, y: 0, w: 5, h: 5, blocksAudio: true, attenuation: 0.1 }], 10);
  assert.equal(directA, directB, 'same layoutRevision reuses prepared array reference');
  const directC = prepareObstacles(rev2List, 11);
  assert.notEqual(directC, directA, 'new layoutRevision rebuilds prepared array');
  assert.equal(directC[0].id, 'w-b');

  // Per-mixer createObstacleCache()
  const cache = createObstacleCache();
  const room = { roomId: 'lobby', layoutRevision: 1, obstacles: rev1List };
  const first = cache.resolve(room);
  const second = cache.resolve(room);
  assert.equal(first, second);
  assert.equal(cache.stats().prepareCount, 1);

  room.obstacles = rev2List;
  room.layoutRevision = 2;
  const third = cache.resolve(room);
  assert.notEqual(third, first);
  assert.equal(cache.stats().prepareCount, 2);
  assert.equal(third[0].attenuation, 0.5);
});

test('audioMixer applies gainForDistance(d) * T across seeded lobby geometries, reacts to live room:layout without rejoin, and smooths with documented time constants', async () => {
  let clock = 0;
  const mixer = createAudioMixer({
    AudioContextFactory: FakeAudioContext,
    document: fakeDocument(),
    now: () => clock,
  });
  await mixer.resume();

  const world = createWorldState();
  applyJoinedSnapshot(world, {
    selfId: 'self',
    room: {
      roomId: 'lobby',
      name: 'Lobby',
      width: 1920,
      height: 1080,
      layoutRevision: 1,
      obstacles: [...SEEDED_LOBBY_OBSTACLES],
    },
    users: [
      { id: 'self', name: 'Self', x: 850, y: 540 },
      { id: 'peer', name: 'Peer', x: 920, y: 540 },
    ],
  });

  const { gain } = mixer.attach('peer', { id: 'stream-1' }, fakeElement());
  assert.equal(gain.gain.value, 0);
  assert.equal(gain.gain.directWrites, 1, 'initial 0 set once during attach');

  const getRemotePos = (id) => world.users.get(id) ?? null;

  // 1. Open space (same side of lobby wall, 70 px apart): gainForDistance(70) = 135/343 ≈ 0.39359, T = 1
  clock = 0;
  assert.equal(mixer.updateGains(world.users.get('self'), getRemotePos, ['peer'], world.room), true);
  const expectedOpen70 = 135 / 343;
  assert.ok(Math.abs(gain.gain.targets[0].value - expectedOpen70) < 1e-12);
  assert.ok(Math.abs(expectedOpen70 - 0.39359) < 1e-5);
  assert.equal(gain.gain.targets[0].constant, TARGET_TIME_CONSTANT);
  assert.equal(mixer.peerTransmission('peer'), 1);

  // 2. Move across the seeded 0.12 lobby wall (925,540 -> 995,540, still 70 px apart): ~0.04723
  world.users.get('self').x = 925;
  world.users.get('peer').x = 995;
  clock = 50;
  assert.equal(mixer.updateGains(world.users.get('self'), getRemotePos, ['peer'], world.room), true);
  const expectedWall70 = expectedOpen70 * 0.12;
  assert.ok(Math.abs(gain.gain.targets[1].value - expectedWall70) < 1e-12);
  assert.ok(Math.abs(expectedWall70 - 0.04723) < 1e-5);
  assert.equal(gain.gain.targets[1].constant, OCCLUSION_TIME_CONSTANT);
  assert.equal(OCCLUSION_TIME_CONSTANT, 0.08);
  assert.equal(mixer.peerTransmission('peer'), 0.12);
  assert.equal(mixer.obstacleCacheStats().prepareCount, 1, 'prepared obstacles reused across ticks on revision 1');

  // 3. Live room:layout removes the wall (revision 2) -> next tick restores open gain without re-join!
  assert.equal(
    updateRoomLayout(world, { roomId: 'lobby', layoutRevision: 2, obstacles: [] }),
    true,
  );
  clock = 100;
  assert.equal(mixer.updateGains(world.users.get('self'), getRemotePos, ['peer'], world.room), true);
  assert.ok(Math.abs(gain.gain.targets[2].value - expectedOpen70) < 1e-12);
  assert.equal(
    gain.gain.targets[2].constant,
    OCCLUSION_TIME_CONSTANT,
    'exiting occlusion also smooths with OCCLUSION_TIME_CONSTANT so unblocking does not click',
  );
  assert.equal(mixer.peerTransmission('peer'), 1);

  // 4. Live room:layout adds a screen (0.45) + plant (0.65) in line of sight (revision 3)
  assert.equal(
    updateRoomLayout(world, {
      roomId: 'lobby',
      layoutRevision: 3,
      obstacles: [
        { id: 'screen-mid', type: 'screen', x: 940, y: 500, w: 10, h: 80, blocksAudio: true, attenuation: 0.45 },
        { id: 'plant-mid', type: 'plant', x: 965, y: 525, w: 20, h: 30, blocksAudio: true, attenuation: 0.65 },
      ],
    }),
    true,
  );
  clock = 150;
  assert.equal(mixer.updateGains(world.users.get('self'), getRemotePos, ['peer'], world.room), true);
  const expectedCombo = expectedOpen70 * 0.45 * 0.65;
  assert.ok(Math.abs(gain.gain.targets[3].value - expectedCombo) < 1e-12);
  assert.equal(gain.gain.targets[3].constant, OCCLUSION_TIME_CONSTANT);
  assert.equal(gain.gain.directWrites, 1, 'no direct gain.value writes after initial attach');
  assert.ok(gain.gain.targets.every(({ value }) => value >= 0 && value <= 1));

  // Verify 20 Hz tick throttle still holds with obstacles active
  clock = 199;
  assert.equal(mixer.updateGains(world.users.get('self'), getRemotePos, ['peer'], world.room), false);
  assert.equal(gain.gain.targets.length, 4);

  await mixer.closeAll();
});

test('audioMixer disconnects every node across 50 attach/update/remove cycles and falls back safely when Web Audio is unavailable', async () => {
  let clock = 0;
  const doc = fakeDocument();
  const contexts = [];
  const mixer = createAudioMixer({
    AudioContextFactory: class extends FakeAudioContext {
      constructor() { super(); contexts.push(this); }
    },
    document: doc,
    now: () => clock,
  });
  await mixer.resume();

  const room = {
    roomId: 'lobby',
    layoutRevision: 1,
    obstacles: [...SEEDED_LOBBY_OBSTACLES],
  };

  const elements = [];
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const el = fakeElement();
    elements.push(el);
    const peerId = `peer-${cycle}`;
    const chain = mixer.attach(peerId, { id: cycle }, el);
    clock += 50;
    mixer.updateGains(
      { x: 925, y: 540 },
      () => ({ x: 995, y: 540 }),
      [peerId],
      room,
    );
    assert.ok(chain.gain.gain.targets.length === 1);
    assert.equal(mixer.remove(peerId), true);
    assert.equal(chain.source.disconnectCalls, 1);
    assert.equal(chain.gain.disconnectCalls, 1);
    assert.equal(el.removed, true);
  }
  assert.equal(mixer.size(), 0);
  await mixer.closeAll();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closeCalls, 1);
  assert.equal(doc.listenerCount, 0);

  // Web Audio unavailable fallback with blocking obstacles must not throw
  const fallbackMixer = createAudioMixer({
    AudioContextFactory: null,
    document: fakeDocument(),
    logger: { warn() {} },
    now: () => 100,
  });
  const fallbackEl = fakeElement();
  assert.equal(fallbackMixer.attach('fallback-peer', { id: 's' }, fallbackEl), null);
  assert.equal(fallbackEl.muted, false);
  assert.equal(
    fallbackMixer.updateGains({ x: 925, y: 540 }, () => ({ x: 995, y: 540 }), ['fallback-peer'], room),
    true,
  );
  assert.equal(fallbackMixer.peerTransmission('fallback-peer'), 1);
  assert.deepEqual(fallbackMixer.peerMetrics('fallback-peer'), { distancePx: 70, volumePercent: 100 });
  await fallbackMixer.closeAll();
});

test('overlay derivation computes transmission percentage and formatted text from known positions', () => {
  const prepared = prepareObstacles(SEEDED_LOBBY_OBSTACLES);

  // Open 70 px on same side of wall-core
  const open = derivePeerVolume({ x: 850, y: 540 }, { x: 920, y: 540 }, prepared);
  assert.equal(open.distancePx, 70);
  assert.equal(open.transmission, 1);
  assert.equal(open.transmissionPercent, 100);
  assert.equal(open.volumePercent, 39);
  assert.equal(open.blocked, false);
  assert.equal(open.text, 'volume 39% (100%)');

  // Blocked by wall-core (0.12) at 70 px: 0.39359 * 0.12 = 0.04723 -> 5%
  const wall70 = derivePeerVolume({ x: 925, y: 540 }, { x: 995, y: 540 }, prepared);
  assert.equal(wall70.distancePx, 70);
  assert.equal(wall70.transmission, 0.12);
  assert.equal(wall70.transmissionPercent, 12);
  assert.equal(wall70.volumePercent, 5);
  assert.equal(wall70.blocked, true);
  assert.equal(wall70.text, 'volume 5% (blocked 12%)');

  // Blocked by wall-core (0.12) at 73 px: gainForDistance(73) * 0.12 = 0.0410 -> 4%
  const wall73 = derivePeerVolume({ x: 923, y: 540 }, { x: 996, y: 540 }, prepared);
  assert.equal(wall73.distancePx, 73);
  assert.equal(wall73.text, 'volume 4% (blocked 12%)');

  // Full block (attenuation 0) inside inner radius
  const zeroWall = [{ id: 'zero', x: 10, y: 0, w: 5, h: 20, blocksAudio: true, attenuation: 0 }];
  const blockedZero = derivePeerVolume({ x: 0, y: 10 }, { x: 20, y: 10 }, zeroWall);
  assert.equal(blockedZero.text, 'volume 0% (blocked 0%)');

  // Unknown position fallback
  const unknown = derivePeerVolume({ x: 0, y: 0 }, null, prepared);
  assert.equal(unknown.distancePx, null);
  assert.equal(unknown.text, 'volume 0% (100%)');
  assert.equal(formatPeerVolume(4, 0.12), 'volume 4% (blocked 12%)');
});

test('worked table and 8-peer x 200-obstacle benchmark helpers produce consistent bounded figures', async () => {
  const rows = computeWorkedTable();
  assert.equal(rows.length, 8);
  assert.equal(rows[0].targetGain, 0.39359);
  assert.equal(rows[1].targetGain, 0.04723);

  const bench = await runOcclusionBenchmark({ iterations: 200, warmup: 50 });
  assert.equal(bench.peers, 8);
  assert.equal(bench.obstacles, 200);
  assert.equal(bench.checksPerTick, 1600);
  assert.ok(bench.aabbRejectedPercent > 80, 'most room-wide obstacles are rejected by the AABB pre-check');
  assert.equal(bench.prepareCountAcrossTicks, 1, 'layoutRevision cache builds prepared array only once');
});
