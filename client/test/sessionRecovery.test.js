import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverExpiredSession } from '../src/realtime/sessionRecovery.js';

test('expiry recovery reconnects once and leaves ordinary errors alone', () => {
  const calls = [];
  const socket = { connected: true,
    disconnect() { this.connected = false; calls.push('disconnect'); },
    connect() { calls.push('connect'); },
  };
  assert.equal(recoverExpiredSession(socket, { code: 'server_error' }), false);
  assert.deepEqual(calls, []);
  assert.equal(recoverExpiredSession(socket, { code: 'session_expired' }), true);
  assert.equal(recoverExpiredSession(socket, { code: 'session_expired' }), true);
  assert.deepEqual(calls, ['disconnect', 'connect']);
});
