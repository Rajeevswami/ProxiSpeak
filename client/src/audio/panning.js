/**
 * Stereo pan law for peer audio (Week 3, Day 17).
 *
 * Pure functions only: no DOM, React or Web Audio. The mixer turns the value
 * returned here into a StereoPannerNode `pan` setting.
 *
 * Axes: the map is a top-down 2D view with fixed screen axes. A speaker with a
 * larger x than the listener (to the RIGHT on screen) is heard in the RIGHT
 * ear; a speaker to the LEFT is heard in the LEFT ear. Avatar facing is not
 * part of the protocol and is deliberately not used. A speaker directly above
 * or below the listener (same x) is centred.
 */

/**
 * Largest pan magnitude. Positions are never hard-panned to one ear, so the
 * far-left and far-right ends of the stereo field stay audible in both ears.
 */
export const MAX_PAN = 0.85;

/**
 * Distance (px) below which the pan slope is held constant. It equals the
 * inner radius used by distance attenuation (30 px), but `attenuation.js` does
 * not export that constant and must stay untouched, so the value is repeated
 * here on purpose. Within this radius the pan is `MAX_PAN * dx / PAN_INNER_PX`,
 * which makes the function continuous at zero distance (pan = 0) and avoids a
 * divide-by-small-number spike when two avatars overlap.
 */
export const PAN_INNER_PX = 30;

/**
 * Seconds for the StereoPannerNode to glide to a new pan target after the
 * first connection. Chosen to match the gain smoothing (`TARGET_TIME_CONSTANT`
 * in audioMixer.js): a fast enough glide to follow a walking avatar, slow
 * enough that a sudden jump cannot be heard as a click.
 */
export const PAN_TIME_CONSTANT = 0.05;

/**
 * Stereo pan for a speaker as heard by a listener, from their 2D positions.
 *
 *   pan = MAX_PAN * dx / max(dist, PAN_INNER_PX)
 *
 * with dx = speaker.x - listener.x, dy = speaker.y - listener.y and
 * dist = hypot(dx, dy). The result is in [-MAX_PAN, MAX_PAN]; negative is left,
 * positive is right, 0 is centre. Invalid input (missing positions, NaN,
 * Infinity, non-numbers) returns 0 and never throws.
 *
 * Allocation-free: plain arithmetic on the two positions.
 *
 * @param {{x: number, y: number}|null|undefined} listener
 * @param {{x: number, y: number}|null|undefined} speaker
 * @returns {number} pan in [-0.85, 0.85]
 */
export function panForPositions(listener, speaker) {
  if (!listener || !speaker) return 0;
  const lx = listener.x;
  const ly = listener.y;
  const sx = speaker.x;
  const sy = speaker.y;
  if (
    typeof lx !== 'number' || !Number.isFinite(lx) ||
    typeof ly !== 'number' || !Number.isFinite(ly) ||
    typeof sx !== 'number' || !Number.isFinite(sx) ||
    typeof sy !== 'number' || !Number.isFinite(sy)
  ) return 0;

  const dx = sx - lx;
  const dy = sy - ly;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;

  const dist = Math.hypot(dx, dy);
  const denominator = dist > PAN_INNER_PX ? dist : PAN_INNER_PX;
  const pan = (MAX_PAN * dx) / denominator;
  // Normalise -0 to 0 so "centred" is always exactly zero.
  return pan === 0 ? 0 : pan;
}
