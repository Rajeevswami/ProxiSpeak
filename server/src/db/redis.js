/**
 * Optional Redis connection manager (Week 3, Day 12).
 *
 * Principles:
 *  - `REDIS_URL` empty -> zero Redis connections opened, `scaleMode: "single"`.
 *  - `redis://` and `rediss://` (TLS) supported out of the box.
 *  - Unreachable at boot -> tear down clients immediately (no retry loop), log
 *    ONE loud warning with redacted URL, fall back cleanly to `"single"`.
 *  - Dropped mid-run -> never crash, never disconnect users; transition cached
 *    `scaleMode` to `"redis-degraded"`; on `ready` recovery, restore `"redis"`
 *    and trigger local edge reconciliation.
 *  - Credentials in Redis URLs (`user:pass@`, `:pass@`, `?password=...`) are
 *    ALWAYS redacted before any log line.
 */
import Redis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export const VALID_SCALE_MODES = new Set(['single', 'redis', 'redis-degraded']);

/**
 * Redact every credential form from a Redis connection string:
 *   - `redis://alice:secret@host:6379`  -> `redis://alice:***@host:6379`
 *   - `redis://:secret@host:6379`       -> `redis://:***@host:6379`
 *   - `rediss://user@host:6380?password=secret` -> `rediss://***@host:6380?password=***`
 */
export function redactRedisUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '<empty>';
  let sanitized = raw;
  try {
    const parsed = new URL(raw);
    if (parsed.password) {
      parsed.password = '***';
    } else if (parsed.username) {
      parsed.username = '***';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/pass|secret|token|auth/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    sanitized = parsed.toString();
    // Preserve clean host form when original URL carried no trailing slash path.
    if (!raw.slice(raw.indexOf('://') + 3).includes('/') && sanitized.endsWith('/')) {
      sanitized = sanitized.slice(0, -1);
    }
    return sanitized;
  } catch {
    return sanitized
      .replace(/\/\/([^:/@]*):([^@]+)@/g, (_match, user) => `//${user ? `${user}:` : ':'}***@`)
      .replace(/\/\/([^@]+)@/g, '//***@')
      .replace(/([?&](?:password|pass|token|secret|auth)=)[^&#\s]+/gi, '$1***');
  }
}

/** Pure in-memory scale status read by GET /health without any I/O. */
export function createScaleState(instanceId = config.server.instanceId, initialMode = 'single') {
  let mode = VALID_SCALE_MODES.has(initialMode) ? initialMode : 'single';
  return {
    instanceId,
    get mode() {
      return mode;
    },
    setMode(next) {
      if (!VALID_SCALE_MODES.has(next)) {
        throw new RangeError(`invalid scaleMode "${next}"`);
      }
      mode = next;
      return mode;
    },
  };
}

function buildRedisOptions(parsedUrl, { connectTimeoutMs, allowReconnectRef, tls, forStore }) {
  const isTls = parsedUrl.protocol === 'rediss:';
  const options = {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest: forStore ? 1 : null,
    // Fail fast on EdgeStore commands during a mid-run outage instead of queueing forever.
    enableOfflineQueue: !forStore,
    retryStrategy: (attempt) => {
      if (!allowReconnectRef.current) return null;
      return Math.min(attempt * 100, 2000);
    },
  };
  if (isTls) {
    options.tls = tls ? { ...tls } : {};
  }
  return options;
}

async function closeOneClient(client, graceMs = 500) {
  if (!client) return;
  if (client.status === 'end' || client.status === 'wait') {
    client.disconnect(false);
    return;
  }
  let timer = null;
  try {
    await Promise.race([
      client.quit().catch(() => client.disconnect(false)),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          client.disconnect(false);
          resolve();
        }, graceMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Connect optional Redis clients (`storeClient`, `pubClient`, `subClient`).
 * Falls back to single-instance without throwing or looping if unreachable at boot.
 */
export async function connectRedis({
  config: cfg = config,
  url,
  connectTimeoutMs,
  tls,
  clientFactory = (targetUrl, opts) => new Redis(targetUrl, opts),
  logger: baseLogger = logger,
  scaleState,
  onDegraded,
  onRecovered,
} = {}) {
  const effectiveUrl = url ?? cfg.redis.url;
  const effectiveTimeoutMs = connectTimeoutMs ?? cfg.redis.connectTimeoutMs;
  const state = scaleState ?? createScaleState(cfg.server.instanceId, 'single');
  const log = typeof baseLogger.child === 'function' ? baseLogger.child('redis') : baseLogger;
  const trimmed = typeof effectiveUrl === 'string' ? effectiveUrl.trim() : '';

  if (!trimmed) {
    state.setMode('single');
    return {
      enabled: false,
      fallback: false,
      scaleState: state,
      storeClient: null,
      pubClient: null,
      subClient: null,
      isReady: () => false,
      close: async () => {},
    };
  }

  const safeUrl = redactRedisUrl(trimmed);
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
      throw new Error(`unsupported protocol "${parsedUrl.protocol}" (expected redis: or rediss:)`);
    }
  } catch (err) {
    log.warn(
      `Invalid REDIS_URL "${safeUrl}" (${err?.message ?? err}) — falling back to single-instance mode`,
    );
    state.setMode('single');
    return {
      enabled: false,
      fallback: true,
      scaleState: state,
      storeClient: null,
      pubClient: null,
      subClient: null,
      isReady: () => false,
      close: async () => {},
    };
  }

  const allowReconnectRef = { current: false };
  const storeClient = clientFactory(
    trimmed,
    buildRedisOptions(parsedUrl, { connectTimeoutMs: effectiveTimeoutMs, allowReconnectRef, tls, forStore: true }),
  );
  const pubClient = clientFactory(
    trimmed,
    buildRedisOptions(parsedUrl, { connectTimeoutMs: effectiveTimeoutMs, allowReconnectRef, tls, forStore: false }),
  );
  const subClient = clientFactory(
    trimmed,
    buildRedisOptions(parsedUrl, { connectTimeoutMs: effectiveTimeoutMs, allowReconnectRef, tls, forStore: false }),
  );
  const allClients = [storeClient, pubClient, subClient];

  let booted = false;
  let closing = false;
  const readySet = new Set();
  let bootFailureReason = null;

  const markDegraded = (reason) => {
    if (!booted || closing) return;
    if (state.mode !== 'redis-degraded') {
      state.setMode('redis-degraded');
      log.warn(
        `Redis connection lost at ${safeUrl} (${reason}) — scaleMode is now "redis-degraded"; `
          + 'existing WebRTC peers stay connected, new cross-instance edges paused until recovery',
      );
      try {
        onDegraded?.();
      } catch (err) {
        log.error('onDegraded handler failed:', err?.message ?? err);
      }
    }
  };

  for (const client of allClients) {
    client.on('error', (err) => {
      const msg = err?.message ?? String(err);
      if (!booted) {
        bootFailureReason ??= msg;
        return;
      }
      if (closing) return;
      readySet.delete(client);
      markDegraded(msg);
    });

    client.on('close', () => {
      readySet.delete(client);
      if (booted && !closing) markDegraded('connection closed');
    });

    client.on('end', () => {
      readySet.delete(client);
      if (booted && !closing) markDegraded('connection ended');
    });

    client.on('ready', () => {
      readySet.add(client);
      if (!booted || closing) return;
      if (readySet.size === allClients.length && state.mode === 'redis-degraded') {
        state.setMode('redis');
        log.info(`Redis connection restored at ${safeUrl} — reconciling local peer edges`);
        Promise.resolve(onRecovered?.()).catch((err) => {
          log.error('Redis recovery reconcile failed:', err?.message ?? err);
        });
      }
    });
  }

  let timer = null;
  try {
    await Promise.race([
      (async () => {
        await Promise.all(allClients.map((client) => client.connect()));
        await storeClient.ping();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${effectiveTimeoutMs}ms`)),
          effectiveTimeoutMs,
        );
        timer.unref();
      }),
    ]);
  } catch (err) {
    closing = true;
    allowReconnectRef.current = false;
    for (const client of allClients) {
      client.removeAllListeners();
      client.on('error', () => {});
      client.disconnect(false);
    }
    const reason = bootFailureReason ?? err?.message ?? String(err);
    log.warn(
      `WARNING: Cannot reach Redis at "${safeUrl}" (${reason}). `
        + 'Falling back to single-instance in-memory mode — cross-instance scaling is inactive.',
    );
    state.setMode('single');
    return {
      enabled: false,
      fallback: true,
      scaleState: state,
      storeClient: null,
      pubClient: null,
      subClient: null,
      isReady: () => false,
      close: async () => {},
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  for (const client of allClients) readySet.add(client);
  allowReconnectRef.current = true;
  booted = true;
  state.setMode('redis');
  log.info(`Redis connected at ${safeUrl} (scaleMode: "redis")`);

  const handle = {
    enabled: true,
    fallback: false,
    scaleState: state,
    storeClient,
    pubClient,
    subClient,
    setCallbacks({ onDegraded: nextDegraded, onRecovered: nextRecovered } = {}) {
      onDegraded = nextDegraded;
      onRecovered = nextRecovered;
    },
    isReady: () => !closing && state.mode === 'redis' && readySet.size === allClients.length,
    close: async () => {
      if (closing) return;
      closing = true;
      allowReconnectRef.current = false;
      await Promise.all(allClients.map((client) => closeOneClient(client)));
      for (const client of allClients) {
        client.removeAllListeners();
        client.on('error', () => {});
      }
      readySet.clear();
    },
  };

  return handle;
}

export default connectRedis;
