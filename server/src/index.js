/**
 * Boot sequence: config -> MongoDB -> optional Redis -> HTTP server ->
 * Socket.io (with Redis adapter when active) -> sweeps -> listen -> shutdown.
 */
import http from 'node:http';
import process from 'node:process';
import config from './config/index.js';
import logger from './utils/logger.js';
import { connectMongo, disconnectMongo, ensureIndexes } from './db/mongo.js';
import { connectRedis, createScaleState } from './db/redis.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { listenOn } from './utils/httpServer.js';
import { listRoomIds, backfillLegacyRoomRevisions } from './services/roomService.js';
import { cleanupOnBoot, startPresenceCleanup } from './services/presenceCleanup.js';
import { startOrphanEdgeSweep, sweepOrphanEdges } from './services/edgeSweep.js';

const log = logger;

async function main() {
  // Connect before listening: a server without its database must never
  // accept traffic.
  await connectMongo();

  // The geospatial engine is useless without its indexes, so create them on
  // every boot (idempotent) rather than relying on a manual migration.
  await ensureIndexes();
  await backfillLegacyRoomRevisions();
  await cleanupOnBoot();
  log.info('MongoDB indexes ready (UserPresence.location: 2dsphere)');

  // Optional Redis: empty REDIS_URL stays pure single-instance; an unreachable
  // Redis logs one warning and falls back cleanly without crashing or looping.
  const scaleState = createScaleState(config.server.instanceId, 'single');
  const redis = await connectRedis({ config, logger: log, scaleState });

  const httpServer = http.createServer();
  const app = createApp({ config, logger: log, scaleState });
  httpServer.on('request', app);

  const roomIds = await listRoomIds();
  if (roomIds.length) log.info(`Rooms available: ${roomIds.join(', ')}`);
  else log.warn('No rooms in the database yet — run `npm run seed` before clients can join');

  const io = createSocketServer({ httpServer, config, logger: log, redis });

  if (redis.enabled) {
    await sweepOrphanEdges(io).catch((err) =>
      log.warn('boot orphan edge sweep failed:', err?.message ?? err),
    );
  }
  const stopPresenceCleanup = startPresenceCleanup(io);
  const stopEdgeSweep = redis.enabled
    ? startOrphanEdgeSweep(io, { runOnStart: false })
    : async () => {};

  await listenOn(httpServer, { port: config.server.port, host: config.server.host });
  log.info(
    `ProxiSpeak server (${config.server.instanceId}, scaleMode=${scaleState.mode}) `
      + `listening on ${config.server.host}:${config.server.port} (${config.nodeEnv})`,
  );
  log.info('Health:  GET /health');
  log.info('Socket:  io() on the same origin');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
    setTimeout(() => process.exit(1), 10000).unref();
    await stopPresenceCleanup();
    await stopEdgeSweep();
    await new Promise((resolve) => io.close(resolve));
    await io.drainSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await redis.close().catch(() => {});
    await disconnectMongo().catch(() => {});
    log.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
}

main().catch((err) => {
  log.error('fatal startup error:', err?.message ?? err);
  process.exit(1);
});
