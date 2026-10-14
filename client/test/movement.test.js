/**
 * Day 5 unit tests for the pure movement module. No React, no DOM, no
 * socket — positions are plain objects and clocks are injected where
 * they matter, so everything here runs under `node --test` anywhere.
 *
 * Covered: constant speed, normalised diagonals, clamping at all four
 * room edges, click-target arrival, delta-time independence (60 Hz vs
 * 144 Hz), interpolation convergence and its snap threshold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERPOLATION_SNAP_PX,
  MAX_FRAME_DELTA_SECONDS,
  MOVEMENT_SPEED_PX_PER_SEC,
  REMOTE_SNAP_PX,
  clampFrameDelta,
  clampToBounds,
  directionFromKeys,
  interpolateToward,
  isMovementKey,
  keyDirection,
  moveTowardTarget,
  needsSnap,
  stepByDeltaTime,
} from '../src/movement/movement.js';
import { isTypingTarget } from '../src/movement/input.js';

const ROOM = { width: 1920, height: 1080 };
const EPS = 1e-6;
const near = (actual, expected, tol = EPS) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} ~= ${expected}`);

// ------------------------------------------------------------- key mapping ---

test('WASD and the arrow keys map to the four directions', () => {
  assert.equal(isMovementKey('KeyW'), true);
  assert.equal(isMovementKey('ArrowUp'), true);
  for (const code of ['KeyQ', 'ShiftLeft', 'Space', '', undefined, 'w']) {
    assert.equal(isMovementKey(code), false, `${code} is not a movement key`);
  }
  assert.deepEqual(keyDirection('KeyW'), { x: 0, y: -1 }); // up on screen
  assert.deepEqual(keyDirection('ArrowDown'), { x: 0, y: 1 });
  assert.deepEqual(keyDirection('KeyA'), { x: -1, y: 0 });
  assert.deepEqual(keyDirection('ArrowRight'), { x: 1, y: 0 });
  assert.equal(keyDirection('KeyX'), null);
});

test('directionFromKeys returns a unit vector and cancels opposite keys', () => {
  assert.deepEqual(directionFromKeys(new Set()), { x: 0, y: 0 });
  assert.deepEqual(directionFromKeys(['KeyD']), { x: 1, y: 0 });
  assert.deepEqual(directionFromKeys(['KeyW', 'ArrowUp']), { x: 0, y: -1 }, 'duplicates do not double');
  assert.deepEqual(directionFromKeys(['KeyA', 'KeyD']), { x: 0, y: 0 }, 'A+D is a standstill');
  assert.deepEqual(directionFromKeys(['KeyW', 'KeyS', 'KeyD']), { x: 1, y: 0 });

  const diagonal = directionFromKeys(new Set(['KeyW', 'KeyD']));
  near(Math.hypot(diagonal.x, diagonal.y), 1);
  near(diagonal.x, Math.SQRT1_2);
  near(diagonal.y, -Math.SQRT1_2);
});

test('isTypingTarget ignores movement while an input has focus', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'input', type: 'text' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget({ tagName: 'CANVAS' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget({}), false);
});

// -------------------------------------------------------- speed & stepping ---

test('speed is constant: distance is speed * elapsed time', () => {
  const half = { x: 100, y: 100 };
  stepByDeltaTime(half, { x: 1, y: 0 }, 0.5, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  near(half.x, 100 + 150);

  const whole = { x: 100, y: 100 };
  stepByDeltaTime(whole, { x: 0, y: 1 }, 1, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  near(whole.y, 400);

  const backwards = { x: 100, y: 100 };
  stepByDeltaTime(backwards, { x: -1, y: 0 }, 0.25, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  near(backwards.x, 25);
});

test('a diagonal is not faster than a straight line', () => {
  const start = { x: 960, y: 540 };
  const position = { x: 960, y: 540 };
  const diagonal = directionFromKeys(new Set(['KeyW', 'KeyD']));
  stepByDeltaTime(position, diagonal, 1, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  const travelled = Math.hypot(position.x - start.x, position.y - start.y);
  near(travelled, MOVEMENT_SPEED_PX_PER_SEC, 1e-9); // 300, not 300 * sqrt(2)

  // Frame by frame, same story.
  const framed = { x: 960, y: 540 };
  for (let i = 0; i < 60; i += 1) {
    stepByDeltaTime(framed, diagonal, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  }
  near(Math.hypot(framed.x - start.x, framed.y - start.y), MOVEMENT_SPEED_PX_PER_SEC, 1e-9);
});

test('delta-time independence: 60 Hz and 144 Hz cover the same distance', () => {
  const run = (fps) => {
    const position = { x: 100, y: 100 };
    const dt = 1 / fps;
    let frames = 0;
    while (frames < Math.round(fps)) {
      stepByDeltaTime(position, { x: 1, y: 0 }, dt, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
      frames += 1;
    }
    return position;
  };

  const at60 = run(60);
  const at144 = run(144);
  near(at60.x, 100 + MOVEMENT_SPEED_PX_PER_SEC, 1e-9);
  near(at144.x, 100 + MOVEMENT_SPEED_PX_PER_SEC, 1e-9);
  near(at60.x, at144.x, 1e-9);
  near(at60.y, at144.y, 1e-9);
});

test('one frame delta time is clamped: finite, non-negative, capped', () => {
  assert.equal(clampFrameDelta(Number.NaN), 0);
  assert.equal(clampFrameDelta(-5), 0);
  assert.equal(clampFrameDelta(0), 0);
  near(clampFrameDelta(0.016), 0.016);
  assert.equal(clampFrameDelta(99), MAX_FRAME_DELTA_SECONDS);

  // A huge frame (a tab that was hidden) advances at most speed * cap.
  const position = { x: 100, y: 100 };
  stepByDeltaTime(position, { x: 1, y: 0 }, clampFrameDelta(30), MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  near(position.x, 100 + MOVEMENT_SPEED_PX_PER_SEC * MAX_FRAME_DELTA_SECONDS);
});

// ---------------------------------------------------------------- clamping ---

test('steps are clamped at all four room edges', () => {
  const cases = [
    { start: { x: 10, y: 500 }, direction: { x: -1, y: 0 }, expected: { x: 0, y: 500 } },
    { start: { x: 1910, y: 500 }, direction: { x: 1, y: 0 }, expected: { x: 1920, y: 500 } },
    { start: { x: 500, y: 10 }, direction: { x: 0, y: -1 }, expected: { x: 500, y: 0 } },
    { start: { x: 500, y: 1070 }, direction: { x: 0, y: 1 }, expected: { x: 500, y: 1080 } },
  ];
  for (const { start, direction, expected } of cases) {
    const position = { ...start };
    stepByDeltaTime(position, direction, 1, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
    assert.deepEqual(position, expected, `${JSON.stringify(start)} + ${JSON.stringify(direction)}`);
  }
});

test('clampToBounds pulls any position back into the room', () => {
  assert.deepEqual(clampToBounds({ x: -10, y: -10 }, ROOM), { x: 0, y: 0 });
  assert.deepEqual(clampToBounds({ x: 5000, y: 5000 }, ROOM), { x: 1920, y: 1080 });
  assert.deepEqual(clampToBounds({ x: -10, y: 5000 }, ROOM), { x: 0, y: 1080 });
  assert.deepEqual(clampToBounds({ x: 960, y: 540 }, ROOM), { x: 960, y: 540 });
});

// ------------------------------------------------------------ click to move ---

test('a click target is reached exactly, without overshoot', () => {
  const position = { x: 100, y: 100 };
  const target = { x: 400, y: 100 }; // 300 px away

  // 59 frames of 1/60 s: 295 px — still walking.
  for (let i = 0; i < 59; i += 1) {
    assert.equal(moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM), true);
  }
  near(position.x, 395);
  // Frame 60 covers the last 5 px and lands exactly on the target.
  assert.equal(moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM), false);
  assert.deepEqual(position, { x: 400, y: 100 });
});

test('a huge frame arrives at the target instead of flying past it', () => {
  const position = { x: 100, y: 100 };
  assert.equal(moveTowardTarget(position, { x: 150, y: 130 }, 10, MOVEMENT_SPEED_PX_PER_SEC, ROOM), false);
  assert.deepEqual(position, { x: 150, y: 130 });
});

test('a target already reached reports arrival immediately', () => {
  const position = { x: 150, y: 130 };
  assert.equal(moveTowardTarget(position, { x: 150, y: 130 }, 0, MOVEMENT_SPEED_PX_PER_SEC, ROOM), false);
  assert.deepEqual(position, { x: 150, y: 130 });
});

test('a target behind a wall stops at the wall and reports arrival', () => {
  const position = { x: 1800, y: 500 };
  const target = { x: 5000, y: 500 }; // outside the room

  // First big frame slides toward it and gets clamped at the right wall.
  assert.equal(moveTowardTarget(position, target, 10, MOVEMENT_SPEED_PX_PER_SEC, ROOM), true);
  assert.equal(position.x, ROOM.width);

  // Further frames cannot make progress: the walk is over.
  assert.equal(moveTowardTarget(position, target, 10, MOVEMENT_SPEED_PX_PER_SEC, ROOM), false);
  assert.deepEqual(position, { x: ROOM.width, y: 500 });
});

test('an out-of-room target is still walked toward along the reachable part', () => {
  const position = { x: 1800, y: 500 };
  const target = { x: 4000, y: 800 }; // diagonal, outside on both axes
  for (let i = 0; i < 120; i += 1) {
    moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM);
  }
  assert.equal(position.x, ROOM.width, 'x is pinned at the wall');
  assert.ok(position.y > 500 && position.y <= 800, `y keeps sliding toward the target (${position.y})`);
});

// ------------------------------------------------------------- interpolation ---

test('interpolation converges to the target and lands exactly on it', () => {
  const position = { x: 0, y: 0 };
  let previous = Infinity;
  for (let i = 0; i < 600; i += 1) {
    interpolateToward(position, 200, 100, 1 / 60); // 10 seconds
    const distance = Math.hypot(200 - position.x, 100 - position.y);
    assert.ok(distance <= previous + 1e-12, 'distance never grows');
    previous = distance;
  }
  assert.deepEqual(position, { x: 200, y: 100 });
});

test('interpolation is frame-rate independent', () => {
  // Half a second of smoothing leaves ~0.74 px to go — far from the
  // exact-landing snap, so all slicings below are pure exponential.
  const oneBigStep = { x: 0, y: 0 };
  interpolateToward(oneBigStep, 300, 0, 0.5); // one 0.5 s frame

  const at60 = { x: 0, y: 0 };
  for (let i = 0; i < 30; i += 1) {
    interpolateToward(at60, 300, 0, 1 / 60); // 30 frames of 1/60 s
  }

  const at144 = { x: 0, y: 0 };
  for (let i = 0; i < 72; i += 1) {
    interpolateToward(at144, 300, 0, 1 / 144); // 72 frames of 1/144 s
  }

  near(oneBigStep.x, at60.x, 1e-9);
  near(oneBigStep.x, at144.x, 1e-9);
  near(at60.x, at144.x, 1e-9);
  near(oneBigStep.y, at144.y, 1e-9);

  // ...and a different rate scales the speed, not the shape.
  const slow = { x: 0, y: 0 };
  interpolateToward(slow, 300, 0, 1, 4);
  near(slow.x, 300 * (1 - Math.exp(-4)));
});

test('interpolation snaps exactly onto a target it is already close to', () => {
  const position = { x: 100 - INTERPOLATION_SNAP_PX / 2, y: 0 };
  interpolateToward(position, 100, 0, 0);
  assert.deepEqual(position, { x: 100, y: 0 });
});

test('needsSnap is true only beyond the snap threshold', () => {
  assert.equal(needsSnap({ x: 0, y: 0 }, REMOTE_SNAP_PX - 0.1, 0), false);
  assert.equal(needsSnap({ x: 0, y: 0 }, REMOTE_SNAP_PX + 0.1, 0), true);
  assert.equal(needsSnap({ x: 0, y: 0 }, 3, 4, 10), false); // distance 5, threshold 10
  assert.equal(needsSnap({ x: 0, y: 0 }, 3, 4, 4), true); // distance 5, threshold 4
});
