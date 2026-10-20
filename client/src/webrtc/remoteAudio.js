/**
 * Remote audio playback (Week 2, Day 9).
 *
 * Every remote MediaStream gets its own `<audio autoplay playsinline>` element,
 * kept in a hidden container and removed when the peer goes away. That is the
 * whole slice: plain HTMLMediaElement playback only.
 *
 * The element surface stays deliberately small: Day 11's GainNode mixer wraps
 * these streams in the peer manager; StereoPanner positioning and occlusion
 * remain Week 4 work.
 *
 * The `document` is injectable so the module builds (and unit tests) in Node
 * without a DOM; in the browser it defaults to the real one.
 */

/** Hidden, but never `display:none` — some browsers will not play otherwise. */
export const REMOTE_AUDIO_CONTAINER_CLASS = 'remote-audio';

/**
 * @param {object} [options]
 * @param {Document} [options.document] defaults to the browser `document`
 * @param {HTMLElement} [options.container] existing container (a hidden div is
 *   created and appended to `document.body` when omitted)
 */
export function createRemoteAudio({ document: doc, container } = {}) {
  const documentRef =
    doc ?? (typeof document !== 'undefined' ? document : null);
  let root = container ?? null;
  let ownsRoot = false;
  /** peerId -> HTMLAudioElement. Never two elements for one peer. */
  const elements = new Map();

  const ensureContainer = () => {
    if (root || !documentRef) return root;
    root = documentRef.createElement('div');
    ownsRoot = true;
    root.className = REMOTE_AUDIO_CONTAINER_CLASS;
    root.setAttribute('aria-hidden', 'true');
    documentRef.body.appendChild(root);
    return root;
  };

  const remove = (peerId) => {
    const element = elements.get(peerId);
    if (!element) return false;
    elements.delete(peerId);
    try {
      element.pause?.();
    } catch {
      /* not playing anyway */
    }
    try {
      element.srcObject = null;
    } catch {
      /* already detached */
    }
    try {
      element.remove?.();
    } catch {
      element.parentNode?.removeChild(element);
    }
    return true;
  };

  return {
    /**
     * Attach one remote stream to its own audio element (replacing any
     * previous element for the same peer). Returns the element, or null when
     * no DOM is available. `muted` is used when Web Audio owns audible output.
     */
    attach(peerId, stream, { muted = false } = {}) {
      if (!documentRef || !stream) return null;
      remove(peerId);
      const element = documentRef.createElement('audio');
      element.autoplay = true;
      element.playsInline = true;
      element.muted = Boolean(muted);
      element.setAttribute('autoplay', '');
      element.setAttribute('playsinline', '');
      element.srcObject = stream;
      ensureContainer()?.appendChild(element);
      elements.set(peerId, element);
      // Autoplay can still be refused until a gesture; plain playback only,
      // so a refusal is not an error worth surfacing on Day 9.
      try {
        element.play?.()?.catch?.(() => {});
      } catch {
        /* play() not supported on this element */
      }
      return element;
    },

    /** Remove one peer's element (idempotent). */
    remove,

    /** Remove every element — the container itself stays for the next session. */
    removeAll() {
      for (const peerId of [...elements.keys()]) remove(peerId);
    },

    /** Remove owned audio elements and the owned container on full teardown. */
    destroy() {
      for (const peerId of [...elements.keys()]) remove(peerId);
      if (!ownsRoot || !root) return;
      const ownedRoot = root;
      root = null;
      ownsRoot = false;
      try {
        if (typeof ownedRoot.remove === 'function') ownedRoot.remove();
        else ownedRoot.parentNode?.removeChild(ownedRoot);
      } catch {
        try { ownedRoot.parentNode?.removeChild(ownedRoot); } catch { /* already detached */ }
      }
    },

    /** How many elements are live right now (0 after cleanup). */
    count() {
      return elements.size;
    },

    /** The live element for a peer, or null — used by tests and debugging. */
    elementOf(peerId) {
      return elements.get(peerId) ?? null;
    },
  };
}

export default createRemoteAudio;
