import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAN,
  PAN_INNER_PX,
  PAN_TIME_CONSTANT,
  formatPeerPan,
  panForPositions,
} from '../src/audio/panning.js';

const TOLERANCE = 1e-5;
const ORIGIN = { x: 0, y: 0 };

function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('exported constants match the company-approved pan law', () => {
  assert.equal(MAX_PAN, 0.85);
  assert.equal(PAN_INNER_PX, 30);
  assert.equal(PAN_TIME_CONSTANT, 0.05);
});

test('panForPositions matches the documented worked values', () => {
  const cases = [
    [10, 0, 0.28333],
    [30, 0, 0.85],
    [70, 0, 0.85],
    [-70, 0, -0.85],
    [0, 70, 0],
    // The brief listed 0.60098; the formula gives 0.6010408 (0.85*70/hypot(70,70)).
    [70, 70, 0.60104],
    [20, 20, 0.56667],
  ];
  for (const [dx, dy, expected] of cases) {
    const pan = panForPositions(ORIGIN, { x: dx, y: dy });
    assert.ok(
      Math.abs(pan - expected) <= TOLERANCE,
      `dx=${dx} dy=${dy}: expected ${expected}, got ${pan}`,
    );
  }
});

test('panForPositions is exactly 0 for the same position and for dx=0', () => {
  assert.equal(panForPositions(ORIGIN, ORIGIN), 0);
  assert.equal(panForPositions({ x: 500, y: 300 }, { x: 500, y: 300 }), 0);
  assert.ok(Object.is(panForPositions(ORIGIN, { x: 0, y: -40 }), 0), 'no negative zero');
});

test('panForPositions stays within [-MAX_PAN, MAX_PAN] over 100,000 random pairs', () => {
  const rand = makePrng(20261028);
  for (let i = 0; i < 100000; i += 1) {
    const listener = { x: (rand() - 0.5) * 4000, y: (rand() - 0.5) * 4000 };
    const speaker = { x: (rand() - 0.5) * 4000, y: (rand() - 0.5) * 4000 };
    const pan = panForPositions(listener, speaker);
    assert.ok(pan >= -MAX_PAN && pan <= MAX_PAN, `out of range: ${pan}`);
  }
});

test('mirroring x negates pan and swapping listener and speaker negates pan (100,000 pairs)', () => {
  const rand = makePrng(7);
  for (let i = 0; i < 100000; i += 1) {
    const listener = { x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000 };
    const speaker = { x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000 };
    const pan = panForPositions(listener, speaker);
    const mirrored = panForPositions(
      { x: -listener.x, y: listener.y },
      { x: -speaker.x, y: speaker.y },
    );
    const swapped = panForPositions(speaker, listener);
    assert.ok(Math.abs(mirrored + pan) <= 1e-9, 'mirror antisymmetry');
    assert.ok(Math.abs(swapped + pan) <= 1e-9, 'swap antisymmetry');
  }
});

test('pan is translation invariant over 100,000 random pairs', () => {
  const rand = makePrng(99);
  for (let i = 0; i < 100000; i += 1) {
    const listener = { x: (rand() - 0.5) * 1000, y: (rand() - 0.5) * 1000 };
    const speaker = { x: (rand() - 0.5) * 1000, y: (rand() - 0.5) * 1000 };
    const shift = { x: (rand() - 0.5) * 5000, y: (rand() - 0.5) * 5000 };
    const base = panForPositions(listener, speaker);
    const moved = panForPositions(
      { x: listener.x + shift.x, y: listener.y + shift.y },
      { x: speaker.x + shift.x, y: speaker.y + shift.y },
    );
    assert.ok(Math.abs(base - moved) <= 1e-9, `translation changed pan: ${base} vs ${moved}`);
  }
});

test('pan sign equals the sign of dx for 100,000 random pairs (and 0 when dx is 0)', () => {
  const rand = makePrng(4242);
  for (let i = 0; i < 100000; i += 1) {
    const dx = (rand() - 0.5) * 600;
    const dy = (rand() - 0.5) * 600;
    const pan = panForPositions(ORIGIN, { x: dx, y: dy });
    if (dx > 0) assert.ok(pan > 0, `dx=${dx} should pan right`);
    else if (dx < 0) assert.ok(pan < 0, `dx=${dx} should pan left`);
    else assert.equal(pan, 0);
  }
});

test('continuity: adjacent samples on fine sweeps never jump (through zero and across PAN_INNER_PX)', () => {
  // Step 0.01 px. The pan slope is at most about 0.85 / 30 per px, so adjacent
  // samples differ by about 0.0004 at most; the epsilon is 0.001.
  const EPSILON = 1e-3;
  const STEP = 0.01;
  let worst = 0;

  // Straight sweep across the listener (dist 0 at x=0) and both inner-radius crossings (x=+-30).
  let previous = panForPositions(ORIGIN, { x: -60, y: 0 });
  for (let x = -60 + STEP; x <= 60; x += STEP) {
    const pan = panForPositions(ORIGIN, { x, y: 0 });
    worst = Math.max(worst, Math.abs(pan - previous));
    previous = pan;
  }

  // Diagonal and vertical sweeps that cross dist = PAN_INNER_PX at other angles.
  for (const y of [-30, -12, 0, 17, 30]) {
    previous = panForPositions(ORIGIN, { x: -60, y });
    for (let x = -60 + STEP; x <= 60; x += STEP) {
      const pan = panForPositions(ORIGIN, { x, y });
      worst = Math.max(worst, Math.abs(pan - previous));
      previous = pan;
    }
  }

  // Radial sweep from the listener itself through zero distance and out past the inner radius.
  for (const theta of [0, 0.7, Math.PI / 2, 2.4, Math.PI]) {
    previous = panForPositions(ORIGIN, { x: 0, y: 0 });
    for (let r = STEP; r <= 60; r += STEP) {
      const pan = panForPositions(ORIGIN, { x: r * Math.cos(theta), y: r * Math.sin(theta) });
      worst = Math.max(worst, Math.abs(pan - previous));
      previous = pan;
    }
  }

  assert.ok(worst < EPSILON, `largest adjacent change ${worst} exceeds ${EPSILON}`);
});

test('invalid input gives 0 and never throws', () => {
  const bad = [
    [null, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, undefined],
    [{ x: NaN, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: Infinity, y: 0 }],
    [{ x: 0, y: -Infinity }, { x: 1, y: 1 }],
    [{ x: '5', y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1 }],
    [{ x: 0, y: 0 }, { y: 1 }],
    [{ x: 0, y: 0 }, {}],
    [{ x: 0, y: 0 }, 42],
    [{ x: 0, y: 0 }, { x: true, y: false }],
    [{ x: 0, y: 0 }, { x: 1e308 * 10, y: 0 }],
    [{ x: 1.7e308, y: 0 }, { x: -1.7e308, y: 0 }],
  ];
  for (const [listener, speaker] of bad) {
    let pan;
    assert.doesNotThrow(() => { pan = panForPositions(listener, speaker); });
    assert.equal(pan, 0);
  }
  assert.equal(panForPositions(), 0);
});

test('formatPeerPan renders side and strength, including the centre case', () => {
  assert.equal(formatPeerPan(0), 'pan C');
  assert.equal(formatPeerPan(0.0001), 'pan C', 'strength rounds to 0%');
  assert.equal(formatPeerPan(-0), 'pan C');
  assert.equal(formatPeerPan(0.28333), 'pan R 33%');
  assert.equal(formatPeerPan(0.85), 'pan R 100%');
  assert.equal(formatPeerPan(-0.85), 'pan L 100%');
  assert.equal(formatPeerPan(0.60098), 'pan R 71%');
  assert.equal(formatPeerPan(0.56667), 'pan R 67%');
  assert.equal(formatPeerPan(-0.34), 'pan L 40%');
  assert.equal(formatPeerPan(0.527), 'pan R 62%');
});

test('formatPeerPan reports unknown pan without claiming centre', () => {
  assert.equal(formatPeerPan(null), 'pan n/a');
  assert.equal(formatPeerPan(undefined), 'pan n/a');
  assert.equal(formatPeerPan(NaN), 'pan n/a');
  assert.equal(formatPeerPan(Infinity), 'pan n/a');
  assert.equal(formatPeerPan('0.5'), 'pan n/a');
});

test('formatPeerPan derives its text from panForPositions for worked geometries', () => {
  assert.equal(formatPeerPan(panForPositions(ORIGIN, { x: 0, y: 70 })), 'pan C');
  assert.equal(formatPeerPan(panForPositions(ORIGIN, { x: 10, y: 0 })), 'pan R 33%');
  assert.equal(formatPeerPan(panForPositions(ORIGIN, { x: -70, y: 0 })), 'pan L 100%');
  assert.equal(formatPeerPan(panForPositions(ORIGIN, { x: 70, y: 70 })), 'pan R 71%');
});
