/**
 * WebRTC ICE-server configuration (Week 2, Day 8).
 *
 * The server never sees audio and needs no TURN relay of its own on Day 8:
 * a single public STUN server is enough for peers to discover each other on
 * the office LAN / the public internet. Operators may override the list with
 * `ICE_SERVERS` (a JSON array in the exact shape a browser's
 * `RTCPeerConnection({ iceServers })` accepts).
 *
 * A malformed value must never stop the server from booting, so parsing is
 * total: it always returns a usable list plus an optional warning that the
 * boot log prints once. TURN is intentionally rejected — relaying media is a
 * later deployment concern and would require credentials that must never be
 * guessed from a broken env value.
 */

/** Default: one public STUN server, no TURN. */
export const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
]);

const MAX_ENTRIES = 8;
const MAX_URLS_PER_ENTRY = 8;
const ICE_URL = /^stuns?:[^\s]+$/i;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Fall back with a reason that is safe to log (no raw env value echoed). */
function fallback(reason) {
  return {
    servers: DEFAULT_ICE_SERVERS,
    warning: `ICE_SERVERS ignored (${reason}); using the default STUN server stun:stun.l.google.com:19302`,
  };
}

/**
 * @param {string|undefined} raw the raw `ICE_SERVERS` environment value
 * @returns {{servers: ReadonlyArray<object>, warning: string|null}}
 */
export function parseIceServers(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { servers: DEFAULT_ICE_SERVERS, warning: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback('not valid JSON');
  }

  if (!Array.isArray(parsed)) return fallback('expected a JSON array');
  if (parsed.length === 0) return fallback('the array is empty');
  if (parsed.length > MAX_ENTRIES) return fallback(`at most ${MAX_ENTRIES} entries are supported`);

  const servers = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!isPlainObject(entry)) return fallback(`entry ${index} is not an object`);

    const rawUrls = entry.urls;
    const urls = typeof rawUrls === 'string' ? [rawUrls] : rawUrls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return fallback(`entry ${index} needs "urls" (a string or a non-empty array)`);
    }
    if (urls.length > MAX_URLS_PER_ENTRY) {
      return fallback(`entry ${index} has more than ${MAX_URLS_PER_ENTRY} urls`);
    }
    for (const url of urls) {
      if (typeof url !== 'string' || !ICE_URL.test(url)) {
        return fallback(`entry ${index} has an unsupported url (only stun:/stuns: are enabled)`);
      }
    }

    for (const field of ['username', 'credential']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        return fallback(`entry ${index} field "${field}" must be a string`);
      }
    }

    // Whitelist browser-relevant fields; unknown keys never reach clients.
    const server = { urls: Array.isArray(rawUrls) ? [...urls] : rawUrls };
    if (entry.username !== undefined) server.username = entry.username;
    if (entry.credential !== undefined) server.credential = entry.credential;
    servers.push(Object.freeze(server));
  }

  return { servers: Object.freeze(servers), warning: null };
}

export default parseIceServers;
