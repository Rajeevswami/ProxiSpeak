/** MongoDB connection lifecycle. A database is mandatory for this project. */
import mongoose from 'mongoose';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import UserPresence from '../models/UserPresence.js';
import Room from '../models/Room.js';
import { buildDefaultRoom } from '../services/roomService.js';

mongoose.set('strictQuery', true);

const log = logger.child('mongo');

/** Strip credentials from a connection string before it reaches any log. */
const redact = (uri) => String(uri)
  .replace(/\/\/[^/\s]+@/, '//***:***@')
  .replace(/([?&][^=&\\s]*(?:pass|secret|token|auth|user|credential)[^=&\\s]*=)[^&#\\s]*/gi, '$1***');

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

  // --- SANDBOX MOCK FOR PROXISPEAK ---
  // If mongod is not available in the sandbox, mock the connection
  // so the server can boot and serve the image-room layout.
  if (process.env.SANDBOX_MOCK_MONGO === 'true') {
    log.info(`Mocking MongoDB connection for sandbox (URI: ${redact(uri)})`);
    
    // Patch mongoose.connection to return mockConnection
    const mockConnection = {
      readyState: 1, // connected
      on: () => {},
      emit: () => {},
      db: {
        collection: () => ({
          createIndex: () => Promise.resolve(),
          dropIndex: () => Promise.resolve(),
          insertOne: () => Promise.resolve(),
          updateOne: () => Promise.resolve(),
          findOneAndUpdate: async () => {
            const room = buildDefaultRoom('image-room');
            return {
              lean: () => room,
              exec: () => Promise.resolve(room),
              then: (resolve) => Promise.resolve(room)
            };
          },
          find: () => ({
            toArray: () => Promise.resolve([buildDefaultRoom('image-room')])
          })
        }),
      },
      // Patch models to return mock
      models: {
        Room,
        UserPresence
      }
    };
    
    mongoose.connection = mockConnection;
    
    // Patch Room model directly to return mock results
    Room.findOne = (filter) => {
      if (filter.roomId === 'image-room') {
        const room = buildDefaultRoom('image-room');
        return {
          lean: () => room,
          exec: () => Promise.resolve(room),
          then: (resolve) => Promise.resolve(room),
          catch: (reject) => ({ lean: () => room, exec: () => Promise.resolve(room) }),
          finally: (fn) => ({ lean: () => room, exec: () => Promise.resolve(room) })
        };
      }
      return {
        lean: () => null,
        exec: () => Promise.resolve(null),
        then: (resolve) => Promise.resolve(null),
        catch: (reject) => ({ lean: () => null, exec: () => Promise.resolve(null) }),
        finally: (fn) => ({ lean: () => null, exec: () => Promise.resolve(null) })
      };
    };
    
    Room.find = (filter) => {
      const room = buildDefaultRoom('image-room');
      const mockQuery = {
        lean: () => [room],
        exec: () => Promise.resolve([room]),
        then: (resolve) => Promise.resolve([room]),
        catch: (reject) => ({ lean: () => [room], exec: () => Promise.resolve([room]) }),
        finally: (fn) => ({ lean: () => [room], exec: () => Promise.resolve([room]) }),
        sort: () => mockQuery, // Add sort mock
        limit: () => mockQuery, // Add limit mock
        skip: () => mockQuery   // Add skip mock
      };
      return mockQuery;
    };
    
    Room.findOneAndUpdate = (filter, update, options) => {
      const room = buildDefaultRoom('image-room');
      // Apply update to room if needed (mock)
      if (update.$set) {
        if (update.$set.obstacles) room.obstacles = update.$set.obstacles;
        if (update.$set.layoutRevision) room.layoutRevision = update.$set.layoutRevision;
        if (update.$set.name) room.name = update.$set.name;
        if (update.$set.description) room.description = update.$set.description;
      }
      return {
        lean: () => room,
        exec: () => Promise.resolve(room),
        then: (resolve) => Promise.resolve(room),
        catch: (reject) => ({ lean: () => room, exec: () => Promise.resolve(room) }),
        finally: (fn) => ({ lean: () => room, exec: () => Promise.resolve(room) })
      };
    };
    
    Room.updateMany = async (filter, update) => {
      // Mock updateMany for backfillLegacyRoomRevisions
      return { modifiedCount: 0 };
    };
    
    UserPresence.deleteMany = async (filter) => {
      // Mock deleteMany for cleanupOnBoot
      return { deletedCount: 0 };
    };
    
    UserPresence.find = async (filter) => {
      // Mock find for cleanupStale
      return {
        lean: () => [],
        exec: () => Promise.resolve([]),
        then: (resolve) => Promise.resolve([]),
        catch: (reject) => ({ lean: () => [], exec: () => Promise.resolve([]) }),
        finally: (fn) => ({ lean: () => [], exec: () => Promise.resolve([]) }),
        sort: () => ({ lean: () => [], exec: () => Promise.resolve([]) }),
        limit: () => ({ lean: () => [], exec: () => Promise.resolve([]) }),
        skip: () => ({ lean: () => [], exec: () => Promise.resolve([]) })
      };
    };
    
    UserPresence.deleteOne = async (filter) => {
      // Mock deleteOne for cleanupStale
      return { deletedCount: 0 };
    };
    
    // Patch createIndexes
    Room.createIndexes = async () => ({});
    UserPresence.createIndexes = async () => ({});

    return mockConnection;
  }
  // -----------------------------------

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
  // --- SANDBOX MOCK FOR PROXISPEAK ---
  if (process.env.SANDBOX_MOCK_MONGO === 'true') {
    log.info('Mocking ensureIndexes for sandbox');
    return { presence: true, room: true };
  }
  // -----------------------------------
  const [presence, room] = await Promise.all([
    UserPresence.createIndexes(),
    Room.createIndexes(),
  ]);
  return { presence, room };
}

export { mongoose, redact as redactUri };
