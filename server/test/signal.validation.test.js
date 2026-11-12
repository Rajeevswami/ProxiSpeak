/**
 * `signal` payload validation (Week 2, Day 8) — pure functions, no database.
 *
 * The relay trusts nothing: ids and generations are checked here, SDP must be
 * a string, candidate objects are whitelisted field by field, and the whole
 * `data` object is capped at 16 KB before it can reach another browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SIGNAL_BYTES, validateSignalPayload } from '../src/sockets/validation.js';

const TO = 'AbC123_-xyz';
const generation = 7;
const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };

const expectInvalid = (payload, field) => {
  assert.throws(
    () => validateSignalPayload(payload),
    (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.code, 'invalid_payload');
      if (field) assert.equal(err.details?.field, field);
      return true;
    },
  );
};

test('offers and answers require a string sdp and are not trimmed', () => {
  const answer = { type: 'answer', sdp: '  v=0\n a=ice-ufrag:abc  ' };
  assert.deepEqual(validateSignalPayload({ to: TO, generation, data: offer }), {
    to: TO, generation, data: { type: 'offer', sdp: offer.sdp },
  });
  const parsedAnswer = validateSignalPayload({ to: TO, generation, data: answer });
  assert.equal(parsedAnswer.data.sdp, answer.sdp, 'whitespace is significant in SDP');

  for (const sdp of [42, null, {}, '', undefined]) {
    expectInvalid({ to: TO, generation, data: { type: 'offer', sdp } }, 'data.sdp');
  }
});

test('candidates accept a raw string, a browser-shaped object or null', () => {
  assert.deepEqual(
    validateSignalPayload({ to: TO, generation, data: { type: 'candidate', candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' } }).data,
    { type: 'candidate', candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' },
  );
  assert.deepEqual(
    validateSignalPayload({ to: TO, generation, data: { type: 'candidate', candidate: null } }).data,
    { type: 'candidate', candidate: null },
  );
  assert.deepEqual(
    validateSignalPayload({
      to: TO,
      generation,
      data: {
        type: 'candidate',
        candidate: {
          candidate: 'candidate:2 1 udp 1 10.0.0.2 5001 typ host',
          sdpMid: 'audio',
          sdpMLineIndex: 1,
          usernameFragment: 'ufrag',
          ignored: 'must not be relayed',
        },
        extra: 'must not be relayed either',
      },
    }),
    {
      to: TO,
      generation,
      data: {
        type: 'candidate',
        candidate: {
          candidate: 'candidate:2 1 udp 1 10.0.0.2 5001 typ host',
          sdpMid: 'audio',
          sdpMLineIndex: 1,
          usernameFragment: 'ufrag',
        },
      },
    },
  );
  // Null socket identifiers are legal candidate fields and are simply omitted.
  assert.deepEqual(
    validateSignalPayload({
      to: TO, generation, data: { type: 'candidate', candidate: { candidate: 'candidate:3', sdpMid: null, sdpMLineIndex: null } },
    }).data.candidate,
    { candidate: 'candidate:3' },
  );
});

test('malformed envelopes and candidate shapes are rejected', () => {
  const cases = [
    [null, 'to'],
    ['not-an-object', 'to'],
    [{}, 'to'],
    [{ to: 42, generation, data: offer }, 'to'],
    [{ to: `${TO}!`, generation, data: offer }, 'to'],
    [{ to: TO, generation: '7', data: offer }, 'generation'],
    [{ to: TO, generation: 7.5, data: offer }, 'generation'],
    [{ to: TO, generation: -1, data: offer }, 'generation'],
    [{ to: TO, generation: Number.NaN, data: offer }, 'generation'],
    [{ to: TO, generation, data: null }, 'data'],
    [{ to: TO, generation, data: [] }, 'data'],
    [{ to: TO, generation, data: { type: 'bogus', sdp: 'x' } }, 'data.type'],
    [{ to: TO, generation, data: { type: 'candidate', candidate: 42 } }, 'data.candidate'],
    [{ to: TO, generation, data: { type: 'candidate', candidate: { sdpMid: '0' } } }, 'data.candidate.candidate'],
    [{ to: TO, generation, data: { type: 'candidate', candidate: { candidate: 'x', sdpMLineIndex: -1 } } }, 'data.candidate.sdpMLineIndex'],
    [{ to: TO, generation, data: { type: 'candidate', candidate: { candidate: 'x', sdpMLineIndex: 1.5 } } }, 'data.candidate.sdpMLineIndex'],
    [{ to: TO, generation, data: { type: 'candidate', candidate: { candidate: 'x', sdpMid: 7 } } }, 'data.candidate.sdpMid'],
  ];
  for (const [payload, field] of cases) expectInvalid(payload, field);
});

test('the data object is capped at 16 KB (sdp, candidate strings and junk included)', () => {
  assert.equal(MAX_SIGNAL_BYTES, 16 * 1024);

  const atLimitSdp = 'x'.repeat(MAX_SIGNAL_BYTES - 40);
  assert.doesNotThrow(() => validateSignalPayload({
    to: TO, generation, data: { type: 'offer', sdp: atLimitSdp },
  }));

  expectInvalid(
    { to: TO, generation, data: { type: 'offer', sdp: 'x'.repeat(MAX_SIGNAL_BYTES + 1) } },
    'data',
  );
  expectInvalid(
    { to: TO, generation, data: { type: 'candidate', candidate: 'y'.repeat(MAX_SIGNAL_BYTES) } },
    'data',
  );
  expectInvalid(
    { to: TO, generation, data: { type: 'offer', sdp: 'tiny', padding: 'z'.repeat(MAX_SIGNAL_BYTES) } },
    'data',
  );
});

test('generation 0 is structurally valid (the gateway refuses it as stale)', () => {
  const parsed = validateSignalPayload({ to: TO, generation: 0, data: offer });
  assert.equal(parsed.generation, 0);
  expectInvalid({ to: TO, generation: Number.MAX_SAFE_INTEGER + 1, data: offer }, 'generation');
});
