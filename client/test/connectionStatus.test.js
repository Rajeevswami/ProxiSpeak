/**
 * Connection status rules (Day 6). These decide what the user sees when the
 * network goes away, so they are tested rather than only observed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTION_STATUS, statusAfter } from '../src/realtime/connectionStatus.js';

test('a join request starts from scratch', () => {
  for (const status of [CONNECTION_STATUS.IDLE, CONNECTION_STATUS.ERROR, CONNECTION_STATUS.DISCONNECTED]) {
    assert.equal(statusAfter(status, 'join-requested'), CONNECTION_STATUS.CONNECTING);
  }
});

test('only an acknowledged join counts as joined', () => {
  assert.equal(statusAfter(CONNECTION_STATUS.CONNECTING, 'joined'), CONNECTION_STATUS.JOINED);
  assert.equal(statusAfter(CONNECTION_STATUS.DISCONNECTED, 'joined'), CONNECTION_STATUS.JOINED, 'a reconnect lands back in the world');
});

test('a connection that drops before the join lands is an error, not a busy form', () => {
  // The bug this encodes: status stayed 'connecting' forever, so the join
  // button stayed disabled and the user saw "Joining…" for a server that was
  // gone.
  assert.equal(statusAfter(CONNECTION_STATUS.CONNECTING, 'disconnected'), CONNECTION_STATUS.ERROR);
  assert.equal(statusAfter(CONNECTION_STATUS.IDLE, 'disconnected'), CONNECTION_STATUS.ERROR);
});

test('a member who is dropped stays in the world while Socket.io reconnects', () => {
  assert.equal(statusAfter(CONNECTION_STATUS.JOINED, 'disconnected'), CONNECTION_STATUS.DISCONNECTED);
});

test('server errors are actionable before the join and non-destructive after it', () => {
  assert.equal(statusAfter(CONNECTION_STATUS.CONNECTING, 'error'), CONNECTION_STATUS.ERROR);
  // room_not_found on a re-join, or an event the server refused: the world stays
  // (the HUD shows the message) and the error is visible, not hidden by a
  // "reconnecting…" that would no longer be true.
  assert.equal(statusAfter(CONNECTION_STATUS.JOINED, 'error'), CONNECTION_STATUS.JOINED);
  assert.equal(statusAfter(CONNECTION_STATUS.DISCONNECTED, 'error'), CONNECTION_STATUS.ERROR);
});

test('a failed reconnect attempt keeps saying "reconnecting…"', () => {
  assert.equal(statusAfter(CONNECTION_STATUS.CONNECTING, 'connect-error'), CONNECTION_STATUS.ERROR, 'the join form shows it');
  assert.equal(statusAfter(CONNECTION_STATUS.JOINED, 'connect-error'), CONNECTION_STATUS.JOINED);
  assert.equal(statusAfter(CONNECTION_STATUS.DISCONNECTED, 'connect-error'), CONNECTION_STATUS.DISCONNECTED);
});
