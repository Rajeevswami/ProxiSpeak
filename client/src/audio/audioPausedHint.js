/**
 * Pure helpers for the audio-blocked hint.
 *
 * When the browser's AudioContext is not in the `running` state (treat
 * `suspended` and Safari's `interrupted` identically) and at least one peer
 * connection exists, the overlay shows a single line telling the user to
 * click anywhere so the browser resumes audio. The function is intentionally
 * a pure predicate so it can be unit-tested without React or DOM.
 *
 * @param {string|null|undefined} contextState AudioContext.state or equivalent
 * @param {number} peerCount number of active WebRTC peer connections
 * @returns {boolean} true when the hint should be shown
 */
export function shouldShowAudioPausedHint(contextState, peerCount) {
  if (typeof contextState !== 'string') return false;
  if (!Number.isFinite(peerCount) || peerCount < 1) return false;
  // `running` is the only state where audio flows. `suspended` (most browsers)
  // and `interrupted` (Safari) both mean "blocked by autoplay policy".
  // `closed` means the context was deliberately closed — do not show the hint,
  // because no click can reopen a closed context.
  if (contextState === 'suspended' || contextState === 'interrupted') return true;
  return false;
}

/** The exact hint text shown when shouldShowAudioPausedHint returns true. */
export const AUDIO_PAUSED_HINT = 'Audio is paused by the browser. Click anywhere on the page.';

export default shouldShowAudioPausedHint;
