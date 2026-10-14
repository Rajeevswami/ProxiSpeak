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

test('a zero-duration frame does not cancel a pending click target', () => {
  const position = { x: 100, y: 100 };
  const target = { x: 400, y: 100 };

  assert.equal(moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM), true);
  near(position.x, 105);

  // Two rAF callbacks can share a timestamp: delta time 0 must keep the
  // walk pending, not mistake "no time passed" for "walled in".
  assert.equal(moveTowardTarget(position, target, 0, MOVEMENT_SPEED_PX_PER_SEC, ROOM), true);
  assert.equal(position.x, 105, 'a 0 ms frame moves nothing');

  for (let i = 0; i < 58; i += 1) {
    assert.equal(moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM), true);
  }
  assert.equal(moveTowardTarget(position, target, 1 / 60, MOVEMENT_SPEED_PX_PER_SEC, ROOM), false);
  assert.deepEqual(position, { x: 400, y: 100 }, 'the walk still completes');
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

// ------------------------------------------------------- movement controller ---
// The controller is framework-free, so it is tested directly against a
// hand-built world state — the same shape the socket hook maintains.

import { createMovementController } from '../src/movement/controller.js';

function makeWorld({ self = { x: 960, y: 540 } } = {}) {
  const world = {
    room: { roomId: 'lobby', name: 'Lobby', width: ROOM.width, height: ROOM.height, obstacles: [] },
    users: new Map(),
    selfId: 'self',
    epoch: 1,
  };
  world.users.set('self', { id: 'self', name: 'Self', x: self.x, y: self.y });
  return world;
}

const idleController = (world) => createMovementController({ world, emitMove: () => {}, now: () => 0 });

test('held keys move the local avatar by delta time, clamped at the walls', () => {
  const world = makeWorld({ self: { x: 1800, y: 1000 } });
  const controller = idleController(world);
  const self = world.users.get('self');

  controller.pressKey('KeyD');
  controller.pressKey('KeyS');
  controller.update(1); // clamped to MAX_FRAME_DELTA_SECONDS -> 30 px diagonally
  near(self.x, 1800 + MOVEMENT_SPEED_PX_PER_SEC * MAX_FRAME_DELTA_SECONDS * Math.SQRT1_2, 1e-9);
  near(self.y, 1000 + MOVEMENT_SPEED_PX_PER_SEC * MAX_FRAME_DELTA_SECONDS * Math.SQRT1_2, 1e-9);

  for (let i = 0; i < 100; i += 1) controller.update(0.1); // keep walking into the corner
  assert.equal(self.x, ROOM.width);
  assert.equal(self.y, ROOM.height);

  controller.releaseKey('KeyD');
  controller.releaseKey('KeyS');
  controller.update(0.1);
  assert.equal(self.x, ROOM.width, 'no keys held, no movement');
  assert.equal(self.y, ROOM.height);
});

test('non-movement keys are ignored and a release without a press is a no-op', () => {
  const world = makeWorld();
  const controller = idleController(world);
  controller.pressKey('KeyQ');
  controller.pressKey('shift');
  controller.update(1);
  assert.deepEqual({ x: world.users.get('self').x, y: world.users.get('self').y }, { x: 960, y: 540 });
  controller.releaseKey('KeyW'); // never pressed
  controller.update(1);
  assert.equal(world.users.get('self').x, 960);
});

test('a click walks the avatar to the target and stops exactly on it', () => {
  const world = makeWorld();
  const controller = idleController(world);
  const self = world.users.get('self');

  controller.handleWorldClick({ x: 1260, y: 540 }); // 300 px to the right
  controller.update(1 / 60);
  controller.update(0); // a 0 ms frame must not cancel the walk
  for (let i = 0; i < 58; i += 1) controller.update(1 / 60);
  assert.ok(self.x > 1200 && self.x < 1260, `still walking (${self.x})`);
  controller.update(1 / 60); // the last few px
  assert.equal(self.x, 1260, 'arrival lands exactly on the target');
  assert.equal(self.y, 540);
  controller.update(1 / 60);
  assert.equal(self.x, 1260, 'and the avatar stays there');
});

test('a click outside the room walks to the nearest in-bounds point', () => {
  const world = makeWorld();
  const controller = idleController(world);
  const self = world.users.get('self');

  controller.handleWorldClick({ x: 99999, y: 540 }); // target clamped to (1920, 540)
  for (let i = 0; i < 40; i += 1) controller.update(0.1); // 960 px = 32 frames of 30 px
  assert.equal(self.x, ROOM.width);
  assert.equal(self.y, 540);
  controller.update(0.1);
  assert.equal(self.x, ROOM.width, 'arrived at the wall, not grinding on it');
});

test('keyboard input cancels a pending click target', () => {
  const world = makeWorld();
  const controller = idleController(world);
  const self = world.users.get('self');

  controller.handleWorldClick({ x: 1260, y: 540 });
  controller.pressKey('KeyW');
  for (let i = 0; i < 30; i += 1) controller.update(1 / 60); // 0.5 s: 150 px up
  assert.equal(self.x, 960);
  assert.equal(self.y, 390);
});

test('a fresh joined snapshot (epoch bump) drops held keys and click targets', () => {
  const world = makeWorld();
  const controller = idleController(world);
  const self = world.users.get('self');

  controller.pressKey('KeyD');
  controller.handleWorldClick({ x: 1500, y: 540 });
  world.epoch += 1; // what the socket hook does on every `joined`
  controller.update(1 / 60);
  assert.deepEqual({ x: self.x, y: self.y }, { x: 960, y: 540 }, 'neither key nor click survived');
});

test('update is a no-op before join and ignores junk arguments', () => {
  const world = { room: null, users: new Map(), selfId: null, epoch: 0 };
  const controller = idleController(world);
  controller.update(0.016); // no room, no self: must not throw
  controller.update(Number.NaN);
  controller.handleWorldClick(null);
  controller.handleWorldClick({ x: Number.NaN, y: 1 });
  controller.handleWorldClick({ x: 100, y: 100 }); // no room yet: ignored
  assert.equal(world.users.size, 0);
});

// --------------------------------------------------------- move throttling ---

import { MOVE_SEND_INTERVAL_MS, MOVE_BROADCAST_HZ } from '../src/movement/movement.js';
import { createMoveThrottle } from '../src/movement/throttle.js';

/** A throttle driven by a fake clock, reporting every emit with its time. */
function fakeThrottle() {
  let clock = 0;
  const sent = [];
  const throttle = createMoveThrottle({
    emit: (x, y) => sent.push({ x, y, at: clock }),
    now: () => clock,
  });
  return { throttle, sent, tick: (ms) => (clock += ms) };
}

test('the throttle emits at most 10 moves per second while moving', () => {
  const { throttle, sent, tick } = fakeThrottle();

  // A moving avatar at 60 fps for 10 seconds (5 px per frame).
  for (let frame = 0; frame < 60 * 10; frame += 1) {
    tick(1000 / 60);
    throttle.update(frame * 5, 0);
  }

  assert.ok(sent.length >= 85 && sent.length <= 100, `emitted ${sent.length} times in 10 s`);
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(
      sent[i].at - sent[i - 1].at >= MOVE_SEND_INTERVAL_MS - 1e-9,
      `gap ${sent[i].at - sent[i - 1].at} ms`,
    );
  }
  // No sliding one-second window ever sees more than 10 emits.
  for (let i = 0; i < sent.length; i += 1) {
    const inWindow = sent.filter((s) => s.at > sent[i].at && s.at <= sent[i].at + 1000).length;
    assert.ok(inWindow <= MOVE_BROADCAST_HZ, `${inWindow} emits within one second of t=${sent[i].at}`);
  }
  // The same holds at 144 fps.
  const fast = fakeThrottle();
  for (let frame = 0; frame < 144 * 10; frame += 1) {
    fast.tick(1000 / 144);
    fast.throttle.update(frame * 5, 0);
  }
  assert.ok(fast.sent.length >= 85 && fast.sent.length <= 100, `144 Hz emitted ${fast.sent.length}`);
});

test('a resting avatar emits nothing — only real change is sent', () => {
  const { throttle, sent, tick } = fakeThrottle();
  throttle.reset(100, 100); // the server-provided position is the baseline
  for (let frame = 0; frame < 60 * 3; frame += 1) {
    tick(1000 / 60);
    throttle.update(100, 100); // never moves
  }
  assert.equal(sent.length, 0);
});

test('after movement stops, exactly one more emit carries the resting position', () => {
  const { throttle, sent, tick } = fakeThrottle();

  for (let frame = 0; frame < 21; frame += 1) {
    tick(1000 / 60);
    throttle.update(frame * 5, 0); // 0.35 s of walking
  }
  const duringMove = sent.length;
  assert.ok(duringMove >= 1, 'movement itself was reported');

  const resting = { x: 21 * 5, y: 0 };
  for (let frame = 0; frame < 60 * 1.5; frame += 1) {
    tick(1000 / 60);
    throttle.update(resting.x, resting.y); // stopped: position frozen
  }
  assert.equal(sent.length, duringMove + 1, 'exactly one final emit after stopping');
  assert.deepEqual({ x: sent[sent.length - 1].x, y: sent[sent.length - 1].y }, resting);
  assert.ok(sent[sent.length - 1].at <= 350 + MOVE_SEND_INTERVAL_MS + 1, 'it goes out on the next tick');
});

test('reset rebases on a known position and never bursts', () => {
  const { throttle, sent, tick } = fakeThrottle();
  tick(1000); // created at t=0, so t=1000 is the first possible emit
  throttle.update(50, 50);
  assert.equal(sent.length, 1);

  throttle.reset(); // baseline unknown again
  tick(10);
  throttle.update(400, 400); // changed, but only 10 ms since the reset
  assert.equal(sent.length, 1, 'no burst right after a reset');
  tick(100);
  throttle.update(400, 400);
  assert.equal(sent.length, 2);

  throttle.reset(400, 400); // baseline known: nothing to say
  tick(1000);
  throttle.update(400, 400);
  assert.equal(sent.length, 2, 'an unchanged baseline emits nothing');
});

test('non-finite positions are refused, not emitted', () => {
  const { throttle, sent, tick } = fakeThrottle();
  tick(1000);
  throttle.update(Number.NaN, 0);
  throttle.update(10, Number.POSITIVE_INFINITY);
  assert.equal(sent.length, 0);
});

test('the controller broadcasts its predicted position through the throttle', () => {
  const world = makeWorld();
  const sent = [];
  let clock = 0;
  const controller = createMovementController({
    world,
    emitMove: (x, y) => sent.push({ x, y, at: clock }),
    now: () => clock,
  });

  controller.pressKey('KeyD');
  for (let frame = 0; frame < 60 * 2; frame += 1) {
    clock += 1000 / 60;
    controller.update(1 / 60);
  }

  const self = world.users.get('self');
  assert.ok(sent.length >= 15 && sent.length <= 20, `emits: ${sent.length}`);
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(sent[i].at - sent[i - 1].at >= MOVE_SEND_INTERVAL_MS - 1e-9);
  }
  for (const s of sent) {
    near(s.x, 960 + MOVEMENT_SPEED_PX_PER_SEC * (s.at / 1000), 0.1); // the predicted position at emit time
    near(s.y, 540, 1e-9);
  }
  // Stopping flushes the exact resting position on the next tick.
  controller.releaseKey('KeyD');
  const before = sent.length;
  for (let frame = 0; frame < 60; frame += 1) {
    clock += 1000 / 60;
    controller.update(1 / 60);
  }
  assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1].x, self.x, 'peers see the exact resting position');
  assert.equal(sent[sent.length - 1].y, self.y);
});

test('a freshly joined avatar that never moves broadcasts nothing', () => {
  const world = makeWorld();
  const sent = [];
  let clock = 0;
  const controller = createMovementController({
    world,
    emitMove: (x, y) => sent.push({ x, y }),
    now: () => clock,
  });

  world.epoch += 1; // the `joined` snapshot that produced this world
  for (let frame = 0; frame < 60 * 3; frame += 1) {
    clock += 1000 / 60;
    controller.update(1 / 60);
  }
  assert.equal(sent.length, 0, 'the server already knows the position it assigned');
});

// ----------------------------------------------- remote avatar interpolation ---

test('remote avatars glide toward their last reported position and land on it', () => {
  const world = makeWorld();
  // What the socket hook keeps after a user:moved: the drawn position
  // stays put, the target moves.
  world.users.set('remote', { id: 'remote', name: 'Remote', x: 900, y: 540, tx: 960, ty: 540 });
  const controller = idleController(world);
  const self = world.users.get('self');
  const remote = world.users.get('remote');

  controller.update(1 / 60);
  assert.ok(remote.x > 900 && remote.x < 960, `gliding, not snapping (${remote.x})`);

  for (let i = 0; i < 60 * 5; i += 1) controller.update(1 / 60); // 5 s of frames
  assert.equal(remote.x, 960, 'lands exactly on the reported position');
  assert.equal(remote.y, 540);
  assert.deepEqual({ x: self.x, y: self.y }, { x: 960, y: 540 }, 'the local avatar is untouched');
});

test('a remote avatar far from its target snaps instead of gliding', () => {
  const world = makeWorld();
  world.users.set('remote', { id: 'remote', name: 'Remote', x: 0, y: 0, tx: 1000, ty: 0 });
  const controller = idleController(world);
  const remote = world.users.get('remote');

  controller.update(1 / 60); // one frame, distance 1000 > snap threshold
  assert.equal(remote.x, 1000, 'a reconnect-sized gap teleports, no sweep across the floor');
  assert.equal(remote.y, 0);
});

test('remote entries without targets (or the local avatar) are skipped safely', () => {
  const world = makeWorld();
  world.users.set('half', { id: 'half', name: 'Half', x: 10, y: 10 }); // no tx/ty yet
  const controller = idleController(world);
  controller.update(1 / 60); // must not throw
  assert.deepEqual({ x: world.users.get('half').x, y: world.users.get('half').y }, { x: 10, y: 10 });
});

test('a moving remote keeps receiving new targets and keeps gliding', () => {
  const world = makeWorld();
  world.users.set('remote', { id: 'remote', name: 'Remote', x: 900, y: 540, tx: 900, ty: 540 });
  const controller = idleController(world);
  const remote = world.users.get('remote');

  // Ten seconds of a peer walking right at 300 px/s, reported at 10 Hz:
  // every report moves the target 30 px ahead of the glide.
  let reported = 900;
  for (let tick = 0; tick < 100; tick += 1) {
    for (let frame = 0; frame < 6; frame += 1) controller.update(1 / 60); // 100 ms of frames
    reported += 30;
    remote.tx = reported;
  }
  assert.ok(remote.x > reported - 60, `the glide keeps up with the reports (${remote.x} vs ${reported})`);
  assert.ok(remote.x < reported, 'and never reaches ahead of the last report');
});
