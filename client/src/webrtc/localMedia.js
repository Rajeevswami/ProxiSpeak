/**
 * Microphone access (Week 2, Day 9).
 *
 * One job: ask the browser for the microphone with `getUserMedia` and report
 * either the live MediaStream or a *typed* failure the UI can explain. Nothing
 * here knows about React, sockets or peer connections — it is a plain module so
 * `client/test/webrtc.localMedia.test.js` can drive it with fake `mediaDevices`
 * in Node.
 *
 * The request is always audio-only with the three processing flags that make a
 * voice mesh bearable (echo cancellation, noise suppression, auto gain). The
 * typed failures cover the three cases a real deployment hits:
 *
 *   permission_denied  — the user (or the browser policy) said no
 *   no_device          — no microphone is present on this machine
 *   insecure_context   — getUserMedia does not exist outside https/localhost
 *
 * `release()` stops every track of the current stream, so a closed session
 * never leaves the microphone LED on.
 */

/** Typed failure reasons. Stable strings — the UI maps them to sentences. */
export const MEDIA_FAILURE = Object.freeze({
  PERMISSION_DENIED: 'permission_denied',
  NO_DEVICE: 'no_device',
  INSECURE_CONTEXT: 'insecure_context',
  NOT_SUPPORTED: 'not_supported',
  ERROR: 'error',
});

/** The exact constraints the company requirement mandates. */
export const AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

/** The full `getUserMedia` request: audio with processing, never video. */
export const MEDIA_REQUEST = Object.freeze({
  audio: Object.freeze({ ...AUDIO_CONSTRAINTS }),
  video: false,
});

const FAILURE_MESSAGES = Object.freeze({
  [MEDIA_FAILURE.PERMISSION_DENIED]:
    'Microphone permission was denied. You can still join and hear others — you will be in listen-only mode.',
  [MEDIA_FAILURE.NO_DEVICE]:
    'No microphone was found on this device. You can still join and hear others — you will be in listen-only mode.',
  [MEDIA_FAILURE.INSECURE_CONTEXT]:
    'The microphone needs a secure page (https, or http://localhost). You can still join and hear others — you will be in listen-only mode.',
  [MEDIA_FAILURE.NOT_SUPPORTED]:
    'This browser does not support microphone capture (getUserMedia). You can still join and hear others — you will be in listen-only mode.',
  [MEDIA_FAILURE.ERROR]:
    'The microphone could not be started. You can still join and hear others — you will be in listen-only mode.',
});

/**
 * Map a `getUserMedia` rejection to a typed failure reason. Browsers use
 * `DOMException` names (`NotAllowedError`, `NotFoundError`, …); older WebKit
 * used its own (`PermissionDeniedError`, `DevicesNotFoundError`).
 */
export function classifyMediaError(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return MEDIA_FAILURE.PERMISSION_DENIED;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return MEDIA_FAILURE.NO_DEVICE;
  }
  return MEDIA_FAILURE.ERROR;
}

const failure = (reason) => ({ ok: false, reason, message: FAILURE_MESSAGES[reason] });

const stopStream = (stream) => {
  let stopped = 0;
  for (const track of stream?.getTracks?.() ?? []) {
    try {
      track.stop();
      stopped += 1;
    } catch {
      /* a track that refuses to stop is already gone */
    }
  }
  return stopped;
};

const hasLiveAudio = (stream) =>
  !!stream && (stream.getAudioTracks?.() ?? []).some((track) => track.readyState !== 'ended');

/**
 * Create a microphone handle. Injectable `mediaDevices` / `isSecureContext`
 * keep the module testable in Node; in the browser both default to the real
 * `navigator` values.
 *
 * @param {object} [options]
 * @param {MediaDevices} [options.mediaDevices] defaults to `navigator.mediaDevices`
 * @param {boolean} [options.isSecureContext] defaults to `globalThis.isSecureContext`
 * @returns {{request: Function, getStream: Function, isActive: Function, release: Function}}
 */
export function createLocalMedia({ mediaDevices, isSecureContext } = {}) {
  const devices =
    mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  const secure =
    typeof isSecureContext === 'boolean'
      ? isSecureContext
      : typeof globalThis.isSecureContext === 'boolean'
        ? globalThis.isSecureContext
        : undefined;

  let stream = null;

  return {
    /**
     * Ask for the microphone. Never throws: resolves with
     * `{ ok: true, stream }` or `{ ok: false, reason, message }`.
     */
    async request() {
      // `navigator.mediaDevices` only exists in a secure context; when the
      // page is plain http on a non-localhost host the API is simply missing.
      if (secure === false) return failure(MEDIA_FAILURE.INSECURE_CONTEXT);
      if (!devices || typeof devices.getUserMedia !== 'function') {
        return failure(secure === true ? MEDIA_FAILURE.NOT_SUPPORTED : MEDIA_FAILURE.INSECURE_CONTEXT);
      }
      if (hasLiveAudio(stream)) return { ok: true, stream };

      try {
        const acquired = await devices.getUserMedia(MEDIA_REQUEST);
        if (stream && stream !== acquired) stopStream(stream);
        stream = acquired;
        return { ok: true, stream };
      } catch (err) {
        return failure(classifyMediaError(err));
      }
    },

    /** The current live stream, or null after a failure or `release()`. */
    getStream() {
      return hasLiveAudio(stream) ? stream : null;
    },

    /** True while at least one audio track is still capturing. */
    isActive() {
      return hasLiveAudio(stream);
    },

    /** Stop every track and forget the stream. Safe to call twice. */
    release() {
      const stopped = stopStream(stream);
      stream = null;
      return stopped;
    },
  };
}

export default createLocalMedia;
