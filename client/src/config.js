/**
 * The one place the client learns where the server lives.
 * No other module may hardcode a server URL.
 *
 * Resolution order:
 *   1. VITE_SERVER_URL (client/.env) — explicit override, wins always.
 *   2. Dev (vite dev)                — http://localhost:4000, the server's port.
 *   3. Production build              — '' (same origin: whoever served the
 *      build is expected to serve / proxy the socket too).
 */

/**
 * @param {object} [env] a Vite env object (`import.meta.env`, or a stub in tests)
 * @returns {string} the base URL for the socket, '' meaning same origin
 */
export function resolveServerUrl(env = import.meta.env ?? {}) {
  const override = typeof env?.VITE_SERVER_URL === 'string' ? env.VITE_SERVER_URL.trim() : '';
  if (override) {
    // A trailing slash would produce "http://host//socket.io" once
    // socket.io-client appends its path.
    return override.replace(/\/+$/, '');
  }
  return env?.DEV ? 'http://localhost:4000' : '';
}

export const SERVER_URL = resolveServerUrl();

export default SERVER_URL;
