/**
 * CORS / origin policy for the realtime channel, driven by `CLIENT_URL`
 * (the same configuration the Express layer uses, so the HTTP API and the
 * websocket can never be configured separately by accident).
 *
 *   CLIENT_URL unset (default) -> same-origin only. No wildcard, no reflection:
 *       a same-origin browser request carries no usable cross-origin grant, so
 *       nothing is added and the handshake simply works. Cross-origin browser
 *       pages are refused, which is what we want while no React client exists.
 *   CLIENT_URL="*"             -> allow every origin (explicit opt-in).
 *   CLIENT_URL=a,b             -> strict allow-list of origins.
 *
 * Non-browser clients (node scripts, health probes, smoke tests) send no
 * `Origin` header and are always accepted — CORS is a browser protection, not
 * an authentication mechanism.
 */
import config from '../config/index.js';

export function socketCorsOrigin(cfg = config) {
  const allowed = cfg.server.clientOrigins ?? [];
  if (allowed.includes('*')) return true;
  // No CLIENT_URL: leave CORS disabled instead of reflecting arbitrary origins.
  if (allowed.length === 0) return false;

  return (origin, callback) => {
    if (!origin || allowed.includes(origin)) return callback(null, true);
    // `false` (not an Error) keeps the handshake from turning into a 500: the
    // browser is simply denied the CORS grant and blocks the response itself.
    return callback(null, false);
  };
}

/** CORS headers do not protect native WebSocket handshakes. Enforce admission
 * too. Non-browser clients without Origin remain supported; this is not auth. */
export function socketAllowRequest(cfg = config) {
  return (req, callback) => {
    const origin = req.headers.origin;
    const allowed = cfg.server.clientOrigins ?? [];
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return callback(null, true);
    let sameOrigin = false;
    if (allowed.length === 0) {
      try {
        const url = new URL(origin);
        sameOrigin = ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
      } catch { /* malformed origins are rejected */ }
    }
    callback(null, sameOrigin);
  };
}

/** Human-readable summary of the policy, for the boot log (never a secret). */
export function describeCorsOrigin(cfg = config) {
  const allowed = cfg.server.clientOrigins ?? [];
  if (allowed.includes('*')) return 'any origin (CLIENT_URL=*)';
  if (allowed.length === 0) return 'same-origin only (CLIENT_URL unset)';
  return allowed.join(', ');
}

export default socketCorsOrigin;
