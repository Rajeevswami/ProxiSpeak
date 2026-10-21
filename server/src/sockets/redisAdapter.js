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
