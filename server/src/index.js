/**
 * Boot sequence (Day 3): config -> MongoDB -> HTTP server -> Socket.io on the
 * same server (and therefore the same port). Redis and the client bundle are
 * wired into this boot on their own days.
 */
import http from 'node:http';
import process from 'node:process';
import config from './config/index.js';
import logger from './utils/logger.js';
import { connectMongo, disconnectMongo, ensureIndexes } from './db/mongo.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { listRoomIds } from './services/roomService.js';

const log = logger;

async function main() {
  // Connect before listening: a server without its database must never
  // accept traffic.
  await connectMongo();

  // The geospatial engine is useless without its indexes, so create them on
  // every boot (idempotent) rather than relying on a manual migration.
  await ensureIndexes();
  log.info('MongoDB indexes ready (UserPresence.location: 2dsphere)');

  const httpServer = http.createServer();
  const app = createApp({ config, logger: log });
  httpServer.on('request', app);

  // Rooms are data, not code: a join for a room that was never created is
  // rejected, so say plainly which rooms exist (and what to do when none do).
  const roomIds = await listRoomIds();
  if (roomIds.length) log.info(`Rooms available: ${roomIds.join(', ')}`);
  else log.warn('No rooms in the database yet — run `npm run seed` before clients can join');

  // The websocket shares the HTTP server, so there is exactly one port to open,
  // proxy and firewall.
  const io = createSocketServer({ httpServer, config, logger: log });

  await new Promise((resolve) => httpServer.listen(config.server.port, config.server.host, resolve));
  log.info(`ProxiSpeak server listening on ${config.server.host}:${config.server.port} (${config.nodeEnv})`);
  log.info('Health:  GET /health');
  log.info('Socket:  io() on the same origin');

  // One shutdown routine for every signal: the guard makes a second SIGINT
  // during a slow drain a no-op instead of a second teardown.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
    // Force-exit if keep-alive connections do not drain in time.
    setTimeout(() => process.exit(1), 10000).unref();
    // Close the realtime channel first so clients get a clean disconnect
    // instead of a dropped TCP connection. Sockets disconnect as that happens
    // and their presence cleanup is an asynchronous write, so wait for it
    // before MongoDB goes away — otherwise every connected client would be
    // left behind as a ghost document.
    await new Promise((resolve) => io.close(resolve));
    await io.drainSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnectMongo().catch(() => {});
    log.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
}

main().catch((err) => {
  // Message only. The actionable context is already logged where the
  // failure happened (connectMongo explains a bad MONGO_URI, the listen
  // error names the port); a raw stack plus driver dump is noise for an
  // operator, not help.
  log.error('fatal startup error:', err?.message ?? err);
  process.exit(1);
});
