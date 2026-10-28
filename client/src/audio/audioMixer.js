import { distanceBetween, gainForDistance } from './attenuation.js';
import { createObstacleCache, transmissionBetween } from './occlusion.js';
import { PAN_TIME_CONSTANT, panForPositions } from './panning.js';

const defaultLogger = {
  warn(message) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[audio]', message);
    }
  },
};
const UPDATE_INTERVAL_MS = 50;
export const TARGET_TIME_CONSTANT = 0.05;
/**
 * Smoothing time constant (seconds) used when line-of-sight transmission is
 * attenuated or transitions across an obstacle boundary so stepping behind or
 * out from behind a wall never produces an audible click — Week 3 (Day 16).
 */
export const OCCLUSION_TIME_CONSTANT = 0.08;

/**
 * Create the app's one remote-audio Web Audio mixer. Dependencies are
 * injectable so lifecycle and gain behavior can be exercised in Node.
 *
 * @param {object} [options]
 * @param {Function|null} [options.AudioContextFactory] constructor/factory
 * @param {Document|null} [options.document] visibility-event target
 * @param {object} [options.logger] optional `{ warn() }` client logger; defaults to one `console.warn` for fallback
 * @param {Function} [options.now] monotonic milliseconds clock
 */
export function createAudioMixer({
  AudioContextFactory = defaultAudioContextFactory(),
  document: doc = typeof document === 'undefined' ? null : document,
  logger = defaultLogger,
  now = defaultNow,
} = {}) {
  let context = null;
  let unavailable = false;
  let warned = false;
  let warnedNoPanner = false;
  let outerPx = 100;
  let lastUpdateMs = -Infinity;
  let lifecycleListening = false;
  const gainOptions = { innerPx: 30, outerPx: 100 };
  const obstacleCache = createObstacleCache();
  const peers = new Map();

  const warnUnavailableOnce = () => {
    if (warned) return;
    warned = true;
    logger?.warn?.('Web Audio API unavailable; remote audio is using full-volume element playback.');
  };

  const warnNoPannerOnce = () => {
    if (warnedNoPanner) return;
    warnedNoPanner = true;
    logger?.warn?.('StereoPannerNode unavailable; remote audio is centred (no left/right panning).');
  };

  /** Stereo panner for one peer, or null when this browser has none (chain skips it). */
  const createPanner = (audioContext) => {
    if (typeof audioContext.createStereoPanner !== 'function') {
      warnNoPannerOnce();
      return null;
    }
    return audioContext.createStereoPanner();
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

  const ensureLifecycleListeners = () => {
    if (lifecycleListening || !doc?.addEventListener) return;
    doc.addEventListener('visibilitychange', onVisibilityChange);
    doc.addEventListener('pointerdown', onPageGesture);
    lifecycleListening = true;
  };

  function onVisibilityChange() {
    if (doc?.visibilityState === 'visible'
      && (context?.state === 'suspended' || context?.state === 'interrupted')) {
      void resume();
    }
  }

  function onPageGesture() {
    if (context?.state === 'suspended' || context?.state === 'interrupted') void resume();
  }

  /** Create or resume the shared context; call directly from the Join gesture. */
  const resume = async () => {
    ensureLifecycleListeners();
    const audioContext = ensureContext();
    if (!audioContext) return false;
    if ((audioContext.state === 'suspended' || audioContext.state === 'interrupted')
      && typeof audioContext.resume === 'function') {
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
    try { peer.panner?.disconnect(); } catch { /* already disconnected */ }
    try { peer.gain?.disconnect(); } catch { /* already disconnected */ }
    try { peer.element?.pause?.(); } catch { /* no longer playing */ }
    if (peer.element) {
      try { peer.element.srcObject = null; } catch { /* detached already */ }
      try { peer.element.remove?.(); } catch { /* detached already */ }
    }
    return true;
  };

  const attach = (peerId, stream, element) => {
    remove(peerId);
    ensureLifecycleListeners();
    if (!stream || !element) return null;
    element.muted = true;
    const audioContext = ensureContext();
    if (!audioContext) {
      fallbackElement(element);
      peers.set(peerId, {
        source: null,
        gain: null,
        element,
        destinationConnected: true,
        gainValue: 1,
        transmission: 1,
        distancePx: null,
      });
      return null;
    }

    let source = null;
    let panner = null;
    let gain = null;
    try {
      source = audioContext.createMediaStreamSource(stream);
      // Chain: source -> StereoPannerNode -> GainNode -> destination. Without a
      // panner (very old browsers) the chain is source -> GainNode -> destination.
      panner = createPanner(audioContext);
      gain = audioContext.createGain();
      gain.gain.value = 0;
      if (panner) {
        source.connect(panner);
        panner.connect(gain);
      } else {
        source.connect(gain);
      }
      // Deliberately do not connect gain -> destination until updateGains has
      // applied the first distance-derived value (including unknown = 0).
      peers.set(peerId, {
        source,
        panner,
        gain,
        element,
        destinationConnected: false,
        gainValue: 0,
        transmission: 1,
        distancePx: null,
        pan: 0,
      });
      return { source, gain };
    } catch {
      // A partially built chain is not in `peers` yet, so remove() cannot
      // reach it. Disconnect it here before falling back to element playback.
      try { source?.disconnect(); } catch { /* best-effort setup rollback */ }
      try { panner?.disconnect(); } catch { /* best-effort setup rollback */ }
      try { gain?.disconnect(); } catch { /* best-effort setup rollback */ }
      fallbackElement(element);
      peers.set(peerId, {
        source: null,
        gain: null,
        element,
        destinationConnected: true,
        gainValue: 1,
        transmission: 1,
        distancePx: null,
      });
      return null;
    }
  };

  const applyPeerGain = (peerId, localPos, getRemotePos, prepared) => {
    const peer = peers.get(peerId);
    if (!peer) return;
    let remotePos = null;
    try {
      remotePos = typeof getRemotePos === 'function' ? getRemotePos(peerId) : null;
    } catch {
      remotePos = null;
    }
    const distancePx = distanceBetween(localPos, remotePos);
    const hasDistance = Number.isFinite(distancePx);
    const transmission = hasDistance && prepared.length > 0
      ? transmissionBetween(localPos, remotePos, prepared)
      : 1;
    const rawTarget = hasDistance
      ? gainForDistance(distancePx, gainOptions) * transmission
      : 0;
    const target = rawTarget <= 0 ? 0 : rawTarget >= 1 ? 1 : rawTarget;
    const timeConstant = (transmission !== peer.transmission || transmission < 1)
      ? OCCLUSION_TIME_CONSTANT
      : TARGET_TIME_CONSTANT;
    // Pan depends only on the two positions, never on obstacles: a blocked
    // speaker is quieter but stays on its side.
    const pan = panForPositions(localPos, remotePos);

    peer.distancePx = hasDistance ? distancePx : null;
    if (!peer.gain) {
      peer.gainValue = 1; // plain HTMLMediaElement fallback is intentionally full-volume
      peer.transmission = 1;
      peer.pan = 0;
      return;
    }
    peer.transmission = transmission;
    peer.gainValue = target;
    peer.pan = pan;
    try {
      if (peer.panner) {
        // First connection: jump straight to the pan (no sweep from centre).
        // Afterwards glide with a time constant, never a direct `pan.value` write.
        if (!peer.destinationConnected) {
          peer.panner.pan.setValueAtTime(pan, context.currentTime);
        } else {
          peer.panner.pan.setTargetAtTime(pan, context.currentTime, PAN_TIME_CONSTANT);
        }
      }
      peer.gain.gain.setTargetAtTime(target, context.currentTime, timeConstant);
      if (!peer.destinationConnected) {
        peer.gain.connect(context.destination);
        peer.destinationConnected = true;
      }
    } catch {
      // A peer can be concurrently torn down by a browser connection event.
    }
  };

  const updateGains = (localPos, getRemotePos, peerList, roomOrObstacles = null) => {
    const timestamp = now();
    if (timestamp - lastUpdateMs < UPDATE_INTERVAL_MS) return false;
    lastUpdateMs = timestamp;

    const prepared = obstacleCache.resolve(roomOrObstacles);

    if (peerList == null) {
      for (const peerId of peers.keys()) {
        applyPeerGain(peerId, localPos, getRemotePos, prepared);
      }
    } else if (Array.isArray(peerList)) {
      for (let i = 0; i < peerList.length; i += 1) {
        const entry = peerList[i];
        const peerId = typeof entry === 'string' ? entry : entry?.peerId;
        if (peerId) applyPeerGain(peerId, localPos, getRemotePos, prepared);
      }
    } else if (peerList instanceof Map) {
      for (const peerId of peerList.keys()) {
        if (peerId) applyPeerGain(peerId, localPos, getRemotePos, prepared);
      }
    } else if (typeof peerList[Symbol.iterator] === 'function') {
      for (const entry of peerList) {
        const peerId = typeof entry === 'string' ? entry : entry?.peerId;
        if (peerId) applyPeerGain(peerId, localPos, getRemotePos, prepared);
      }
    } else {
      for (const peerId of peers.keys()) {
        applyPeerGain(peerId, localPos, getRemotePos, prepared);
      }
    }
    return true;
  };

  const closeAll = async () => {
    for (const peerId of [...peers.keys()]) remove(peerId);
    obstacleCache.clear();
    if (lifecycleListening) {
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
      doc?.removeEventListener?.('pointerdown', onPageGesture);
      lifecycleListening = false;
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
      gainOptions.outerPx = outerPx;
    },
    peerMetrics(peerId) {
      const peer = peers.get(peerId);
      return peer ? { distancePx: peer.distancePx, volumePercent: Math.round(peer.gainValue * 100) } : null;
    },
    peerTransmission(peerId) {
      const peer = peers.get(peerId);
      return peer ? peer.transmission : null;
    },
    /** Last applied stereo pan in [-0.85, 0.85], or null when no panner is in the chain. */
    peerPan(peerId) {
      const peer = peers.get(peerId);
      return peer && peer.panner ? peer.pan : null;
    },
    obstacleCacheStats() {
      return obstacleCache.stats();
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
