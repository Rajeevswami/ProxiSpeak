/**
 * Join-form rules (Day 6). Pure functions, so these run without React or a
 * browser — and the messages are exactly what the user sees when the server
 * refuses a join, which is why they are worth pinning down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_NAME_LENGTH, ROOMS, describeServerError, validateJoinInput } from '../src/join/joinForm.js';

test('the join form offers the rooms the seed script creates', () => {
  assert.deepEqual(
    ROOMS.map((room) => room.id),
    ['lobby', 'studio', 'lounge'],
  );
});

test('an empty or whitespace-only name is refused before any round trip', () => {
  assert.match(validateJoinInput('', 'lobby'), /enter your name/i);
  assert.match(validateJoinInput('   ', 'lobby'), /enter your name/i);
  assert.match(validateJoinInput(undefined, 'lobby'), /enter your name/i);
  assert.match(validateJoinInput(42, 'lobby'), /enter your name/i);
});

test('a name the server would reject is refused locally', () => {
  assert.match(validateJoinInput('x'.repeat(MAX_NAME_LENGTH + 1), 'lobby'), /24 characters or fewer/);
  assert.equal(validateJoinInput('x'.repeat(MAX_NAME_LENGTH), 'lobby'), null);
  assert.match(validateJoinInput('Ada\u0007', 'lobby'), /not allowed/i);
  assert.match(validateJoinInput('Evil\nName', 'lobby'), /not allowed/i);
  assert.equal(validateJoinInput(' Ada Lovelace ', 'lobby'), null, 'surrounding spaces are trimmed');
  assert.equal(validateJoinInput('Ada 🎧', 'lobby'), null, 'unicode names are fine');
});

test('a room id outside the server pattern is refused locally', () => {
  assert.match(validateJoinInput('Ada', ''), /choose a room/i);
  assert.match(validateJoinInput('Ada', '  '), /choose a room/i);
  assert.match(validateJoinInput('Ada', 'lobby room'), /a-z, 0-9/);
  assert.match(validateJoinInput('Ada', 'room/1'), /a-z, 0-9/);
  assert.match(validateJoinInput('Ada', '-lobby'), /a-z, 0-9/);
  assert.equal(validateJoinInput('Ada', 'LOBBY'), null, 'case is normalised, not rejected');
  assert.equal(validateJoinInput('Ada', ' room-a_2 '), null);
});

test('no error means no message', () => {
  assert.equal(describeServerError(null), null);
  assert.equal(describeServerError(undefined), null);
});

test('room_not_found tells the user to seed the database', () => {
  const message = describeServerError({ code: 'room_not_found', message: 'room "lobby" does not exist' });
  assert.match(message, /does not exist/i);
  assert.match(message, /npm run seed/);
  assert.match(message, /room "lobby" does not exist/, 'the server detail is kept');
});

test('invalid_payload names the offending field', () => {
  const message = describeServerError({ code: 'invalid_payload', message: '"name" is too long', field: 'name' });
  assert.match(message, /invalid/i);
  assert.match(message, /field: name/);
  assert.match(message, /"name" is too long/);
  assert.match(describeServerError({ code: 'invalid_payload' }), /invalid/i);
});

test('an unreachable server is explained with what to check', () => {
  for (const code of ['connection_failed', 'connect_error']) {
    const message = describeServerError({ code, message: 'xhr poll error' });
    assert.match(message, /could not reach the server/i, code);
    assert.match(message, /CLIENT_URL/, code);
  }
});

test('the remaining server codes have their own sentences', () => {
  assert.match(describeServerError({ code: 'already_joined' }), /already in a room/i);
  assert.match(describeServerError({ code: 'not_joined' }), /not in a room/i);
  assert.match(describeServerError({ code: 'server_error' }), /unexpected error/i);
});

test('an unknown code still surfaces the server message', () => {
  assert.equal(describeServerError({ code: 'who_knows', message: 'something specific' }), 'something specific');
  assert.match(describeServerError({ code: 'who_knows' }), /something went wrong/i);
});
