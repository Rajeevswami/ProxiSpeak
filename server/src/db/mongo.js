/** MongoDB connection lifecycle. A database is mandatory for this project. */
import mongoose from 'mongoose';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import UserPresence from '../models/UserPresence.js';
import Room from '../models/Room.js';

mongoose.set('strictQuery', true);

const log = logger.child('mongo');

/** Strip credentials from a connection string before it reaches any log. */
const redact = (uri) => uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');

/**
 * Connection lifecycle logging, bound once per connection object.
 *
 * Mongoose listeners live for the life of the process, so registering them on
 * every `connectMongo()` call would multiply them: one early call (a failed boot
 * attempt, then a retry, then a `connectMongo` from a seed script in the same
 * process) would log every later event once per call, and keep every closure
 * alive with it.
 *
 * @returns {boolean} whether this call did the binding
 */
const loggedConnections = new WeakSet();
export function bindConnectionLogging(connection = mongoose.connection) {
  if (loggedConnections.has(connection)) return false;
  loggedConnections.add(connection);
  connection.on('connected', () => log.info('connected'));
  connection.on('error', (err) => log.error('connection error:', err.message));
  connection.on('disconnected', () => log.warn('disconnected'));
  return true;
}

export async function connectMongo({ uri = config.mongo.uri } = {}) {
  bindConnectionLogging();

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMS,
      maxPoolSize: 50,
      minPoolSize: 5,
      retryWrites: true,
    });
  } catch (err) {
    log.error(
      `Cannot reach MongoDB at "${redact(uri)}".\n` +
        '  Start a local server (mongod --dbpath ./data) or point MONGO_URI at your\n' +
        '  Atlas cluster. The geospatial engine stores every avatar as a 2dsphere\n' +
        '  GeoJSON point, so MongoDB is required.',
    );
    throw err;
  }

  return mongoose.connection;
}

/** Graceful disconnect — closes the pool so the process can exit cleanly. */
export async function disconnectMongo() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/**
 * Create every index the app depends on — most importantly the 2dsphere index
 * on UserPresence.location that backs $near / $geoWithin. Idempotent, and run
 * on every boot so a fresh (remote) database is usable immediately without a
 * manual migration step.
 */
export async function ensureIndexes() {
  const [presence, room] = await Promise.all([
    UserPresence.createIndexes(),
    Room.createIndexes(),
  ]);
  return { presence, room };
}

export { mongoose, redact as redactUri };
