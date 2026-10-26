/**
 * Seed helper — works against a local OR a remote MONGO_URI (Atlas, managed
 * MongoDB, …). The 2dsphere index is created here too, which is the one thing
 * the geospatial engine cannot work without.
 *
 *   npm run seed                                # indexes + default rooms
 *   MONGO_URI="mongodb+srv://…" npm run seed    # any remote database
 *
 * The connection string is never printed verbatim: credentials are redacted.
 */
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, ensureIndexes } from '../src/db/mongo.js';
import config from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import UserPresence from '../src/models/UserPresence.js';
import { buildDefaultRoom, persistRoom, backfillLegacyRoomRevisions } from '../src/services/roomService.js';

const log = logger.child('seed');

export const ROOMS = ['lobby', 'studio', 'lounge'];
const redact = (uri) => uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');

/**
 * Ensures indexes, runs safe revision backfill, and creates default rooms
 * if they do not already exist. Idempotent.
 */
export async function seedRooms() {
  await ensureIndexes();
  await backfillLegacyRoomRevisions();
  log.info('indexes ensured (UserPresence.location = 2dsphere)');

  for (const roomId of ROOMS) {
    const existing = await mongoose.connection.collection('rooms').findOne({ roomId });
    if (existing) {
      log.info(`room "${roomId}" already present — left untouched`);
      continue;
    }
    await persistRoom(buildDefaultRoom(roomId));
    log.info(`room "${roomId}" created`);
  }
}

async function main() {
  const target = config.mongo.uri;
  log.info(`target: ${redact(target)}`);

  await connectMongo();
  log.info(`connected to ${mongoose.connection.name || 'proxispeak'}`);

  await seedRooms();

  const indexes = await UserPresence.collection.indexes();
  log.info(`UserPresence indexes: ${indexes.map((index) => JSON.stringify(index.key)).join(', ')}`);
  log.info('done');

  await disconnectMongo();
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(async (err) => {
    // Message only, exactly like the server's own startup failure: the
    // actionable part is already logged above (connectMongo names the URI and
    // what to do about it), while `log.error(err)` would dump the whole Mongoose
    // topology — dozens of lines of driver internals between the operator and
    // the one line that says what to fix. The stack stays available at debug.
    log.error(`seed failed: ${err?.message ?? err}`);
    if (err?.stack) log.debug(err.stack);
    if (err?.name === 'MongooseServerSelectionError') {
      log.error('Could not reach MongoDB. Check MONGO_URI (and the network access list for Atlas).');
    }
    await disconnectMongo().catch(() => {});
    process.exit(1);
  });
}
