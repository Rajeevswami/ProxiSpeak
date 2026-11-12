/**
 * Day 3 unit tests for the pieces that decide whether a client event is
 * allowed: payload validation, the boundary/step guards and the rate limiter.
 *
 * No server, no socket, no database — these run everywhere, including on a
 * machine where MongoDB is not available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateJoinPayload, validateMovePayload, MAX_NAME_LENGTH } from '../src/sockets/validation.js';
import { TokenBucket } from '../src/utils/rateLimiter.js';
import { socketCorsOrigin, describeCorsOrigin } from '../src/utils/origin.js';
import { ValidationError } from '../src/utils/errors.js';

const room = { roomId: 'lobby', width: 1920, height: 1080 };

/** Assert that a call throws a ValidationError, optionally on a given field. */
function rejectsInvalid(run, field) {
  assert.throws(run, (err) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'invalid_payload');
    assert.equal(err.status, 400);
    if (field !== undefined) assert.equal(err.details?.field, field);
    return true;
  });
}

// ---------------------------------------------------------------------- join ---

test('join payloads are trimmed, lowercased and sanitised', () => {
  assert.deepEqual(validateJoinPayload({ roomId: '  Lobby ', name: '  Ada  ' }), {
    roomId: 'lobby',
    name: 'Ada',
  });
  assert.equal(validateJoinPayload({ roomId: 'studio-2', name: 'B' }).name, 'B');
});

test('malformed join payloads are rejected as invalid_payload', () => {
  for (const payload of [undefined, null, 'join', 42, true, [], [room.roomId]]) {
    rejectsInvalid(() => validateJoinPayload(payload), 'roomId');
  }
  for (const roomId of [undefined, null, 42, '', '   ', 'a'.repeat(49), 'lobby!', 'lobby/../etc', 'lobby.dot', '$lobby']) {
    rejectsInvalid(() => validateJoinPayload({ roomId, name: 'Ada' }), 'roomId');
  }
  for (const name of [undefined, null, 7, '', '   ', 'A'.repeat(MAX_NAME_LENGTH + 1), 'Ada\u0007Bell']) {
    rejectsInvalid(() => validateJoinPayload({ roomId: 'lobby', name }), 'name');
  }
});

// ---------------------------------------------------------------------- move ---

test('non-finite and absurd coordinates are rejected', () => {
  const previous = { x: 100, y: 100 };
  const attempts = [
    { x: Number.NaN, y: 10 },
    { x: Number.POSITIVE_INFINITY, y: 10 },
    { x: Number.NEGATIVE_INFINITY, y: 10 },
    { x: '10', y: 10 },
    { x: null, y: 10 },
    { x: undefined, y: 10 },
    { x: [10], y: 10 },
    { x: {}, y: 10 },
    { x: 1e12, y: 10 },
    { y: 10 },
    {},
  ];
  for (const payload of attempts) {
    rejectsInvalid(() => validateMovePayload(payload, { room, previous, maxStepPx: 120 }));
  }
  rejectsInvalid(() => validateMovePayload({ x: 1, y: Number.NaN }, { room, previous, maxStepPx: 120 }), 'y');
  for (const payload of [null, 'move', [], 42]) {
    rejectsInvalid(() => validateMovePayload(payload, { room, previous, maxStepPx: 120 }));
  }
});

test('coordinates outside the room are clamped into it', () => {
  const previous = { x: 100, y: 100 };

  const right = validateMovePayload({ x: 99999, y: 500 }, { room, previous, maxStepPx: 1e6 });
  assert.equal(right.x, room.width);
  assert.equal(right.y, 500);
  assert.equal(right.outOfBounds, true);
  assert.equal(right.limited, false);

  const left = validateMovePayload({ x: -50, y: -50 }, { room, previous, maxStepPx: 1e6 });
  assert.deepEqual({ x: left.x, y: left.y }, { x: 0, y: 0 });
  assert.equal(left.outOfBounds, true);

  const inside = validateMovePayload({ x: 300, y: 400 }, { room, previous, maxStepPx: 1e6 });
  assert.deepEqual({ x: inside.x, y: inside.y }, { x: 300, y: 400 });
  assert.equal(inside.outOfBounds, false);
  assert.equal(inside.limited, false);
});

test('a single move can never travel further than maxStepPx', () => {
  const previous = { x: 100, y: 100 };
  const maxStepPx = 120;

  const teleport = validateMovePayload({ x: 1800, y: 900 }, { room, previous, maxStepPx });
  const travelled = Math.hypot(teleport.x - previous.x, teleport.y - previous.y);
  assert.ok(travelled <= maxStepPx + 0.01, `travelled ${travelled}`);
  assert.ok(travelled > maxStepPx - 1, 'a capped move still goes as far as it may');
  assert.equal(teleport.limited, true);

  // The requested direction survives the cap.
  const requested = Math.atan2(900 - previous.y, 1800 - previous.x);
  const delivered = Math.atan2(teleport.y - previous.y, teleport.x - previous.x);
  assert.ok(Math.abs(requested - delivered) < 0.01, 'the step keeps the direction the client asked for');

  const legal = validateMovePayload({ x: 150, y: 100 }, { room, previous, maxStepPx });
  assert.deepEqual({ x: legal.x, y: legal.y }, { x: 150, y: 100 });
  assert.equal(legal.limited, false);
});

// ------------------------------------------------------------- rate limiter ---

test('the token bucket allows a burst, then refuses until it refills', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 3 });
  const now = 1_000_000;

  assert.equal(bucket.take(now), true);
  assert.equal(bucket.take(now), true);
  assert.equal(bucket.take(now), true);
  assert.equal(bucket.take(now), false, 'the bucket is empty');

  // One second later exactly three more tokens are available.
  assert.equal(bucket.take(now + 1000), true);
  assert.equal(bucket.take(now + 1000), true);
  assert.equal(bucket.take(now + 1000), true);
  assert.equal(bucket.take(now + 1000), false);

  // Idle time never overfills the bucket (no endless burst credit).
  assert.equal(bucket.take(now + 60_000), true);
  assert.equal(bucket.take(now + 60_000), true);
  assert.equal(bucket.take(now + 60_000), true);
  assert.equal(bucket.take(now + 60_000), false);
});

test('a token bucket requires a positive capacity and refill rate', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSec: 3 }));
  assert.throws(() => new TokenBucket({ capacity: 3, refillPerSec: 0 }));
});

// ------------------------------------------------------------------ cors ---

test('socket CORS: an unset CLIENT_URL grants no wildcard', () => {
  const cfg = { server: { clientOrigins: [] } };
  assert.equal(socketCorsOrigin(cfg), false);
  assert.match(describeCorsOrigin(cfg), /same-origin/);
});

test('socket CORS: an explicit list becomes an allow-list', () => {
  const cfg = { server: { clientOrigins: ['http://localhost:5173', 'https://proxispeak.example'] } };
  const origin = socketCorsOrigin(cfg);
  assert.equal(typeof origin, 'function');

  const decisions = [];
  const decide = (requestOrigin) => origin(requestOrigin, (err, allowed) => decisions.push({ err, allowed }));
  decide('http://localhost:5173');
  decide('https://proxispeak.example');
  decide(undefined); // node clients / same-origin requests carry no Origin
  decide('https://evil.example');

  assert.deepEqual(decisions, [
    { err: null, allowed: true },
    { err: null, allowed: true },
    { err: null, allowed: true },
    { err: null, allowed: false }, // denied without throwing: no 500 on the handshake
  ]);
  assert.equal(describeCorsOrigin(cfg), 'http://localhost:5173, https://proxispeak.example');
});

test('socket CORS: "*" is the explicit opt-in for every origin', () => {
  const cfg = { server: { clientOrigins: ['*'] } };
  assert.equal(socketCorsOrigin(cfg), true);
  assert.match(describeCorsOrigin(cfg), /any origin/);
});
