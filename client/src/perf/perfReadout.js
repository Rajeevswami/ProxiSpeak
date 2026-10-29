/**
 * Pure URL flag parser and text formatter for the opt-in `?perf=1` readout
 * — Week 3 (Day 18).
 *
 * Read-only and zero-React-state: when `?perf=1` is present in the page URL,
 * `frameLoop` updates a plain DOM element's `textContent` at most once per
 * `PERF_READOUT_INTERVAL_MS` (1,000 ms). Without `?perf=1`, nothing is rendered
 * and no frame timing samples are recorded.
 */

export const PERF_QUERY_PARAM = 'perf';
export const PERF_READOUT_INTERVAL_MS = 1000;

/**
 * True strictly when the query string (or URL) carries `perf=1`.
 *
 * @param {string|null|undefined} searchOrUrl `window.location.search` or full URL
 * @returns {boolean}
 */
export function isPerfEnabled(searchOrUrl) {
  if (typeof searchOrUrl !== 'string' || searchOrUrl.length === 0) return false;
  const hashIndex = searchOrUrl.indexOf('#');
  const withoutHash = hashIndex >= 0 ? searchOrUrl.slice(0, hashIndex) : searchOrUrl;
  const qIndex = withoutHash.indexOf('?');
  const query = qIndex >= 0 ? withoutHash.slice(qIndex + 1) : withoutHash;
  if (!query) return false;
  try {
    return new URLSearchParams(query).get(PERF_QUERY_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * Format a `frameStats.snapshot()` object into the single-line HUD text:
 *   `fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0`
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function formatPerfReadout(snapshot) {
  const fps = Number.isFinite(snapshot?.fps) ? Math.round(snapshot.fps) : 0;
  const frameP95 = Number.isFinite(snapshot?.interval?.p95) ? snapshot.interval.p95 : 0;
  const workP95 = Number.isFinite(snapshot?.work?.p95) ? snapshot.work.p95 : 0;
  const dropped = Number.isFinite(snapshot?.dropped) ? Math.trunc(snapshot.dropped) : 0;
  return `fps ${fps} | frame p95 ${frameP95.toFixed(1)} ms | work p95 ${workP95.toFixed(1)} ms | dropped ${dropped}`;
}
