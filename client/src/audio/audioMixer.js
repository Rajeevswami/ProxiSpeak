import { distanceBetween, gainForDistance } from './attenuation.js';

const noop = () => {};
const NOOP_LOGGER = { warn: noop };
const UPDATE_INTERVAL_MS = 50;
const TARGET_TIME_CONSTANT = 0.05;

/**
 * Create the app's one remote-audio Web Audio mixer. Dependencies are
 * injectable so lifecycle and gain behavior can be exercised in Node.
 *
 * @param {object} [options]
 * @param {Function|null} [options.AudioContextFactory] constructor/factory
 * @param {Document|null} [options.document] visibility-event target
 * @param {object} [options.logger] optional `{ warn() }` client logger
 * @param {Function} [options.now] monotonic milliseconds clock
 */
export function createAudioMixer({
  AudioContextFactory = defaultAudioContextFactory(),
  document: doc = typeof document === 'undefined' ? null : document,
  logger = NOOP_LOGGER,
  now = defaultNow,
} = {}) {
  let context = null;
  let unavailable = false;
  let warned = false;
  let outerPx = 100;
  let lastUpdateMs = -Infinity;
  let visibilityListening = false;
  const peers = new Map();

  const warnUnavailableOnce = () => {
    if (warned) return;
    warned = true;
    logger?.warn?.('Web Audio API unavailable; remote audio is using full-volume element playback.');
  };

  const fallbackElement = (element) => {
    if (element) element.muted = false;
    warnUnavailableOnce();
  };

  const ensureContext = () => {
    if (context || unavailable) return context;
    if (typeof AudioContextFactory !== 'function') {
      unavailable = true;
      warnUnavailableOnce();
      return null;
    }
    try {
      context = new AudioContextFactory();
      return context;
    } catch {
      unavailable = true;
      warnUnavailableOnce();
      return null;
    }
  };

  const ensureVisibilityListener = () => {
    if (visibilityListening || !doc?.addEventListener) return;
    doc.addEventListener('visibilitychange', onVisibilityChange);
    visibilityListening = true;
  };

  function onVisibilityChange() {
    if (doc?.visibilityState === 'visible' && context?.state === 'suspended') {
      void resume();
    }
  }

  /** Create or resume the shared context; call directly from the Join gesture. */
  const resume = async () => {
    ensureVisibilityListener();
    const audioContext = ensureContext();
    if (!audioContext) return false;
    if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
      try {
        await audioContext.resume();
      } catch {
        // Autoplay policy may still require another user gesture.
      }
    }
    return true;
  };

  const remove = (peerId) => {
    const peer = peers.get(peerId);
    if (!peer) return false;
    peers.delete(peerId);
    try { peer.source?.disconnect(); } catch { /* already disconnected */ }
    try { peer.gain?.disconnect(); } catch { /* already disconnected */ }
    peer.element?.pause?.();
    if (peer.element) {
      peer.element.srcObject = null;
      peer.element.remove?.();
    }
    return true;
  };

  const attach = (peerId, stream, element) => {
    remove(peerId);
    if (!stream || !element) return null;
    element.muted = true;
    const audioContext = ensureContext();
    if (!audioContext) {
      fallbackElement(element);
      peers.set(peerId, { source: null, gain: null, element, destinationConnected: true, gainValue: 1, distancePx: null });
      return null;
    }

    try {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      // Deliberately do not connect gain -> destination until updateGains has
      // applied the first distance-derived value (including unknown = 0).
      peers.set(peerId, {
        source,
        gain,
        element,
        destinationConnected: false,
        gainValue: 0,
        distancePx: null,
      });
      return { source, gain };
    } catch {
      fallbackElement(element);
      peers.set(peerId, { source: null, gain: null, element, destinationConnected: true, gainValue: 1, distancePx: null });
      return null;
    }
  };

  const updateGains = (localPos, getRemotePos, peerList) => {
    const timestamp = now();
    if (timestamp - lastUpdateMs < UPDATE_INTERVAL_MS) return false;
    lastUpdateMs = timestamp;
    const ids = peerList instanceof Map
      ? [...peerList.keys()]
      : Array.isArray(peerList)
        ? peerList.map((peer) => typeof peer === 'string' ? peer : peer?.peerId).filter(Boolean)
        : peerList && typeof peerList[Symbol.iterator] === 'function'
          ? [...peerList]
          : [...peers.keys()];

    for (const peerId of ids) {
      const peer = peers.get(peerId);
      if (!peer) continue;
      let remotePos = null;
      try {
        remotePos = typeof getRemotePos === 'function' ? getRemotePos(peerId) : null;
      } catch {
        remotePos = null;
      }
      const distancePx = distanceBetween(localPos, remotePos);
      const target = Number.isFinite(distancePx)
        ? gainForDistance(distancePx, { innerPx: 30, outerPx })
        : 0;
      peer.distancePx = Number.isFinite(distancePx) ? distancePx : null;
      if (!peer.gain) {
        peer.gainValue = 1; // plain HTMLMediaElement fallback is intentionally full-volume
        continue;
      }
      peer.gainValue = target;
      try {
        peer.gain.gain.setTargetAtTime(target, context.currentTime, TARGET_TIME_CONSTANT);
        if (!peer.destinationConnected) {
          peer.gain.connect(context.destination);
          peer.destinationConnected = true;
        }
      } catch {
        // A peer can be concurrently torn down by a browser connection event.
      }
    }
    return true;
  };

  const closeAll = async () => {
    for (const peerId of [...peers.keys()]) remove(peerId);
    if (visibilityListening) {
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
      visibilityListening = false;
    }
    const oldContext = context;
    context = null;
    if (oldContext && typeof oldContext.close === 'function') {
      try { await oldContext.close(); } catch { /* already closed */ }
    }
    lastUpdateMs = -Infinity;
  };

  return {
    resume,
    attach,
    remove,
    updateGains,
    closeAll,
    setProximityRadius(value) {
      outerPx = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 100;
    },
    peerMetrics(peerId) {
      const peer = peers.get(peerId);
      return peer ? { distancePx: peer.distancePx, volumePercent: Math.round(peer.gainValue * 100) } : null;
    },
    size() { return peers.size; },
    getContext() { return context; },
  };
}

function defaultAudioContextFactory() {
  if (typeof globalThis === 'undefined') return null;
  return globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export default createAudioMixer;
