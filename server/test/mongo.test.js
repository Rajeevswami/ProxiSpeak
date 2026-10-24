/**
 * MongoDB connection-lifecycle tests (Day 6). These need no database: they
 * assert on the listener bookkeeping of `bindConnectionLogging`, which is the
 * part of the connection lifecycle that can silently go wrong (a listener
 * registered once per call, and therefore duplicated log lines).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { bindConnectionLogging, redactUri } from '../src/db/mongo.js';

const events = ['connected', 'error', 'disconnected'];

test('MongoDB log redaction removes all userinfo and credential query values', () => {
  const uri = 'mongodb+srv://user:pass@host/proxispeak?password=secret&authSource=admin';
  const redacted = redactUri(uri);
  assert.equal(redacted, 'mongodb+srv://***:***@host/proxispeak?password=***&authSource=***');
  assert.equal(redactUri('mongodb://user@host'), 'mongodb://***:***@host');
  assert.doesNotMatch(redacted, /user|:pass@|=secret/);
});

test('MongoDB log redaction masks credential-bearing options and malformed userinfo', () => {
  const samples = [
    'mongodb://host/db?tlsCertificateKeyFilePassword=VerySecretValue',
    'mongodb://host/db?proxyPassword=VerySecretValue',
    'mongodb://host/db?authMechanismProperties=AWS_SESSION_TOKEN:VerySecretValue',
    'mongodb://host/db?username=alice&password=VerySecretValue',
    'mongodb://user:pass@word@host/db',
  ];
  for (const sample of samples) {
    const redacted = redactUri(sample);
    assert.doesNotMatch(redacted, /VerySecretValue|alice|user:pass|word@host/);
  }
  assert.equal(redactUri('mongodb://user:pass@word@host/db'), 'mongodb://***:***@host/db');
  assert.equal(
    redactUri('mongodb://host/db?retryWrites=true&tlsCertificateKeyFilePassword=VerySecretValue&appName=qa'),
    'mongodb://host/db?retryWrites=true&tlsCertificateKeyFilePassword=***&appName=qa',
  );
});

test('connection logging is bound once per connection object', () => {
  const connection = new EventEmitter();

  assert.equal(bindConnectionLogging(connection), true, 'the first call binds');
  for (const event of events) {
    assert.equal(connection.listenerCount(event), 1, `${event} listener`);
  }

  // Retries (a failed boot followed by a second attempt) must not stack
  // listeners: every event would otherwise be logged once per attempt.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(bindConnectionLogging(connection), false);
  }
  for (const event of events) {
    assert.equal(connection.listenerCount(event), 1, `${event} listener after retries`);
  }
});

test('binding is tracked per connection, not globally', () => {
  const first = new EventEmitter();
  const second = new EventEmitter();

  assert.equal(bindConnectionLogging(first), true);
  assert.equal(bindConnectionLogging(second), true, 'a different connection is bound on its own');
  assert.equal(bindConnectionLogging(first), false);
  assert.equal(first.listenerCount('connected'), 1);
  assert.equal(second.listenerCount('connected'), 1);
});

test('the bound listeners never throw when an event fires', () => {
  const connection = new EventEmitter();
  bindConnectionLogging(connection);

  assert.doesNotThrow(() => connection.emit('connected'));
  assert.doesNotThrow(() => connection.emit('disconnected'));
  assert.doesNotThrow(() => connection.emit('error', new Error('connection reset')));
});
