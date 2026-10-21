/**
 * Attach `@socket.io/redis-adapter` to a Socket.io server when Redis is active.
 *
 * Every socket automatically joins a room named after its own `socket.id`, so
 * once this adapter is attached both room broadcasts (`io.to(roomId).emit(...)`)
 * AND point-to-point deliveries (`io.to(socketId).emit(...)`) transparently
 * traverse Redis Pub/Sub to reach sockets on any running server instance.
 */
import { createAdapter } from '@socket.io/redis-adapter';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { validateKeyPrefix } from '../services/edgeStore.js';

/**
 * In `ioredis` v6, `publish`/`subscribe`/`unsubscribe`/`psubscribe`/`punsubscribe`
 * reject asynchronously when the underlying connection closes mid-run or during
 * shutdown, and `@socket.io/redis-adapter` calls several of those fire-and-forget.
 * Attaching a `.catch()` on returned Promises routes transient outage errors to
 * the adapter logger instead of firing Node's global `unhandledRejection`.
 */
function guardPubSubMethods(client, onRejected) {
  const methods = [
    'publish',
    'subscribe',
    'unsubscribe',
    'psubscribe',
    'punsubscribe',
    'ssubscribe',
    'sunsubscribe',
  ];
  for (const name of methods) {
    if (typeof client[name] !== 'function') continue;
    const original = client[name].bind(client);
    // eslint-disable-next-line no-param-reassign
    client[name] = (...args) => {
      const result = original(...args);
      if (result && typeof result.catch === 'function') {
        result.catch(onRejected);
      }
      return result;
    };
  }
}

export function attachRedisAdapter(
  io,
  {
    pubClient,
    subClient,
    keyPrefix = config.redis.keyPrefix,
    logger: baseLogger = logger,
  } = {},
) {
  if (!io) throw new TypeError('attachRedisAdapter requires a Socket.io Server instance');
  if (!pubClient || !subClient) {
    throw new TypeError('attachRedisAdapter requires both pubClient and subClient');
  }
  const safePrefix = validateKeyPrefix(keyPrefix);
  const log = typeof baseLogger.child === 'function' ? baseLogger.child('redis-adapter') : baseLogger;

  const onPubSubRejected = (err) => {
    log.debug?.(`pub/sub command skipped while disconnected: ${err?.message ?? err}`);
  };
  guardPubSubMethods(pubClient, onPubSubRejected);
  guardPubSubMethods(subClient, onPubSubRejected);

  io.adapter(createAdapter(pubClient, subClient, { key: `${safePrefix}:adapter` }));
  io.multiInstance = true;
  if (io.peerGraph) {
    io.peerGraph.allowRemotePeers = true;
  }

  // @socket.io/redis-adapter emits 'error' on the namespace adapter whenever a
  // PUB/SUB publish fails during a Redis outage; always absorb and log safely.
  io.of('/').adapter.on('error', (err) => {
    log.warn('adapter error:', err?.message ?? err);
  });

  log.info(`Socket.io Redis adapter attached (prefix: "${safePrefix}:adapter")`);
  return io.of('/').adapter;
}

export default attachRedisAdapter;
