/**
 * Central configuration. Every tunable lives here and is sourced from .env
 * (server/.env wins over the repo-root .env). Nothing else in the codebase
 * reads process.env directly.
 *
 * Day 2 adds the mongo block (connection lifecycle). The world-projection and
 * Redis/socket config blocks are added on the days that actually introduce
 * those dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// dotenv never overrides an already-set key, so the more specific file is
// loaded first and therefore has the higher effective priority.
for (const candidate of [path.join(SERVER_ROOT, '.env'), path.join(REPO_ROOT, '.env')]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

const str = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const num = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = process.env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${key} must be a number, got "${raw}"`);
  if (value < min || value > max) throw new Error(`Env ${key} must be within [${min}, ${max}], got ${value}`);
  return value;
};

const list = (key, fallback) => {
  const raw = str(key, fallback);
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const nodeEnv = str('NODE_ENV', 'development');

const world = Object.freeze({
    // Tangent-plane projection the 2dsphere schema depends on: the pixel
    // plane is mapped onto a tiny globe patch centred on (centerLat,
    // centerLon). 10 pixels per metre === 1 px is exactly 0.1 m to MongoDB.
    width: num('WORLD_WIDTH', 1920, { min: 200 }),
    height: num('WORLD_HEIGHT', 1080, { min: 200 }),
    centerLat: num('WORLD_CENTER_LAT', 37.7749, { min: -90, max: 90 }),
    centerLon: num('WORLD_CENTER_LON', -122.4194, { min: -180, max: 180 }),
    pixelsPerMeter: num('PIXELS_PER_METER', 10, { min: 0.0001, max: 1e6 }),
  });

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  logLevel: str('LOG_LEVEL', 'info'),

  server: Object.freeze({
    // Most PaaS hosts inject PORT; 4000 stays the local default.
    port: num('PORT', 4000, { min: 1, max: 65535 }),
    host: str('HOST', '0.0.0.0'),
    /**
     * Allowed browser origins (CLIENT_URL, comma separated). Empty on Day 1 =
     * any origin may call the API; once the React client exists this locks
     * down to the listed origins.
     */
    clientOrigins: list('CLIENT_URL', ''),
    /**
     * Identifies this process in presence documents. Redis-backed multi-instance
     * scaling arrives on its own day; until then one process owns the rooms it
     * serves, and this string is what a document records as its writer.
     */
    instanceId: str('INSTANCE_ID', 'node-local'),
  }),

  mongo: Object.freeze({
    // Remote-capable connection string (local mongod or Atlas). Never logged
    // verbatim — db/mongo.js redacts credentials before any output.
    uri: str('MONGO_URI', 'mongodb://127.0.0.1:27017/proxispeak'),
    serverSelectionTimeoutMS: num('MONGO_TIMEOUT_MS', 8000, { min: 500 }),
  }),

  proximity: Object.freeze({
    radiusPx: num('PROXIMITY_RADIUS_PX', 100, { min: 0, max: Math.hypot(world.width, world.height) }),
  }),
  presence: Object.freeze({
    cleanupIntervalMs: num('PRESENCE_CLEANUP_INTERVAL_MS', 30000, { min: 1 }),
    timeoutMs: num('PRESENCE_TIMEOUT_MS', 60000, { min: 1 }),
  }),

  socket: Object.freeze({
    /**
     * Accepted `move` events per socket per second (token bucket: bursts up to
     * this many events are allowed, everything above is dropped).
     */
    moveEventsPerSec: num('SOCKET_MOVE_EPS', 30, { min: 1, max: 1000 }),
    /**
     * Largest distance (pixels) an avatar may travel in one accepted `move`.
     * The room is 1920 px wide, so the default is a short hop: a single event
     * can never teleport an avatar across the floor plan.
     */
    maxStepPx: num('SOCKET_MAX_STEP_PX', 120, { min: 1, max: 100000 }),
  }),

  world,
});

export default config;
