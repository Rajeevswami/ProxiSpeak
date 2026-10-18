/**
 * Microphone access tests (Day 9). No browser: `mediaDevices` and
 * `isSecureContext` are injected, so every typed failure path runs in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_CONSTRAINTS,
  MEDIA_FAILURE,
  MEDIA_REQUEST,
  classifyMediaError,
  createLocalMedia,
} from '../src/webrtc/localMedia.js';

/** Fake MediaStream whose tracks record `stop()`. */
const fakeStream = (trackCount = 1) => {
  const tracks = Array.from({ length: trackCount }, () => ({
    kind: 'audio',
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
  }));
  return {
    tracks,
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  };
};

const rejectingDevices = (name) => ({
  getUserMedia: async () => {
    const err = new Error(name);
    err.name = name;
    throw err;
  },
});

test('a denied permission is typed permission_denied with a clear message', async () => {
  const media = createLocalMedia({ mediaDevices: rejectingDevices('NotAllowedError'), isSecureContext: true });
  const result = await media.request();
  assert.equal(result.ok, false);
  assert.equal(result.reason, MEDIA_FAILURE.PERMISSION_DENIED);
  assert.match(result.message, /permission/i);
  assert.equal(media.isActive(), false);
  assert.equal(media.getStream(), null);
});

test('a machine with no microphone is typed no_device', async () => {
  const media = createLocalMedia({ mediaDevices: rejectingDevices('NotFoundError'), isSecureContext: true });
  const result = await media.request();
  assert.equal(result.ok, false);
  assert.equal(result.reason, MEDIA_FAILURE.NO_DEVICE);
  assert.match(result.message, /microphone/i);
});

test('an insecure context is typed insecure_context without calling getUserMedia', async () => {
  let called = 0;
  const media = createLocalMedia({
    mediaDevices: { getUserMedia: async () => { called += 1; return fakeStream(); } },
    isSecureContext: false,
  });
  const result = await media.request();
  assert.equal(result.ok, false);
  assert.equal(result.reason, MEDIA_FAILURE.INSECURE_CONTEXT);
  assert.match(result.message, /secure/i);
  assert.equal(called, 0, 'getUserMedia must not be called in an insecure context');
});

test('a secure browser without getUserMedia is typed not_supported', async () => {
  const media = createLocalMedia({ mediaDevices: undefined, isSecureContext: true });
  const result = await media.request();
  assert.equal(result.ok, false);
  assert.equal(result.reason, MEDIA_FAILURE.NOT_SUPPORTED);
});

test('a successful request returns the stream and the mandated constraints', async () => {
  let received = null;
  const stream = fakeStream();
  const media = createLocalMedia({
    mediaDevices: {
      getUserMedia: async (constraints) => {
        received = constraints;
        return stream;
      },
    },
    isSecureContext: true,
  });

  const result = await media.request();
  assert.equal(result.ok, true);
  assert.equal(result.stream, stream);
  assert.equal(media.isActive(), true);
  assert.equal(media.getStream(), stream);

  // The exact company requirement: audio-only with all three processing flags.
  assert.equal(received.video, false);
  assert.deepEqual(received.audio, { ...AUDIO_CONSTRAINTS });
  assert.deepEqual(MEDIA_REQUEST.audio, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});

test('release stops every track and a new request acquires again', async () => {
  const stream = fakeStream(2);
  let calls = 0;
  const media = createLocalMedia({
    mediaDevices: {
      getUserMedia: async () => {
        calls += 1;
        return stream;
      },
    },
    isSecureContext: true,
  });

  await media.request();
  assert.equal(media.release(), 2, 'both tracks stopped');
  assert.equal(media.isActive(), false);
  assert.equal(media.getStream(), null);
  assert.ok(stream.tracks.every((track) => track.stopped), 'microphone LED off');
  assert.equal(media.release(), 0, 'release is idempotent');

  await media.request();
  assert.equal(calls, 2, 'a released microphone is requested again');
});

test('a second request while the mic is live reuses the stream', async () => {
  let calls = 0;
  const media = createLocalMedia({
    mediaDevices: {
      getUserMedia: async () => {
        calls += 1;
        return fakeStream();
      },
    },
    isSecureContext: true,
  });
  const first = await media.request();
  const second = await media.request();
  assert.equal(calls, 1, 'no second permission prompt');
  assert.equal(second.stream, first.stream);
});

test('classifyMediaError maps browser error names to typed reasons', () => {
  for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
    assert.equal(classifyMediaError({ name }), MEDIA_FAILURE.PERMISSION_DENIED, name);
  }
  for (const name of ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']) {
    assert.equal(classifyMediaError({ name }), MEDIA_FAILURE.NO_DEVICE, name);
  }
  for (const other of ['NotReadableError', 'AbortError', undefined, null, {}]) {
    assert.equal(classifyMediaError(other), MEDIA_FAILURE.ERROR);
  }
});
