/**
 * Central configuration. Every tunable lives here and is sourced from .env
 * (server/.env wins over the repo-root .env). Nothing else in the server
 * codebase reads process.env directly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseIceServers } from './iceServers.js';

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

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REDIS_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

function checkedPattern(key, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Env ${key} has an unsupported format`);
  }
  return value;
}

const nodeEnv = str('NODE_ENV', 'development');

// Malformed JSON must never stop the server from booting: the parser always
// returns a usable list and, on failure, the reason for a single warning line.
const ice = parseIceServers(str('ICE_SERVERS', ''));

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

  /**
   * ICE servers handed to browsers inside `joined` / `peer:connect`.
   * Default: one public STUN server (no TURN). See config/iceServers.js.
   */
  iceServers: ice.servers,
  /** Non-null only when ICE_SERVERS was malformed; logged once at boot. */
  iceServersWarning: ice.warning,

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
     * Unique per-process identifier. Defaults to a random id so two processes
     * launched without overrides never collide; override via INSTANCE_ID so a
     * restarted node can reclaim and purge its own stale rows at boot.
     */
    instanceId: checkedPattern(
      'INSTANCE_ID',
      str('INSTANCE_ID', `node-${crypto.randomBytes(6).toString('hex')}`),
      INSTANCE_ID_PATTERN,
    ),
  }),

  mongo: Object.freeze({
    // Remote-capable connection string (local mongod or Atlas). Never logged
    // verbatim — db/mongo.js redacts credentials before any output.
    uri: str('MONGO_URI', 'mongodb://127.0.0.1:27017/proxispeak'),
    serverSelectionTimeoutMS: num('MONGO_TIMEOUT_MS', 8000, { min: 500 }),
  }),

  redis: Object.freeze({
    // Optional: empty string keeps pure single-instance in-memory behaviour.
    // Supports both `redis://` and `rediss://` (TLS). Always redacted in logs.
    url: str('REDIS_URL', ''),
    keyPrefix: checkedPattern(
      'REDIS_KEY_PREFIX',
      str('REDIS_KEY_PREFIX', 'proxispeak'),
      REDIS_PREFIX_PATTERN,
    ),
    edgeSweepIntervalMs: num('EDGE_SWEEP_INTERVAL_MS', 30000, { min: 1, max: 2 ** 31 - 1 }),
    connectTimeoutMs: num('REDIS_CONNECT_TIMEOUT_MS', 3000, { min: 100, max: 60000 }),
    edgeTtlSeconds: num('REDIS_EDGE_TTL_SECONDS', 3600, { min: 60, max: 604800 }),
  }),

  proximity: Object.freeze((() => {
    const radiusPx = num('PROXIMITY_RADIUS_PX', 100, { min: 0, max: Math.hypot(world.width, world.height) });
    // MAX_PEERS_PER_USER: 0 = unlimited (Day-12 behaviour), otherwise cap per user.
    const rawMax = process.env.MAX_PEERS_PER_USER;
    const maxPeersPerUser = rawMax === undefined || rawMax === '' ? 8 : Number(rawMax);
    if (!Number.isInteger(maxPeersPerUser) || !Number.isFinite(maxPeersPerUser)) {
      throw new Error(`Env MAX_PEERS_PER_USER must be an integer, got "${rawMax}"`);
    }
    if (maxPeersPerUser < 0 || maxPeersPerUser > 100000) {
      throw new Error(`Env MAX_PEERS_PER_USER must be within [0, 100000], got ${maxPeersPerUser}`);
    }
    // PEER_DISCONNECT_RADIUS_PX: hysteresis drop radius. Default radius + 15.
    // Validated: >= radiusPx and <= 3 * radiusPx (equal to radius = Day-12 behaviour).
    const rawDrop = process.env.PEER_DISCONNECT_RADIUS_PX;
    let peerDisconnectRadiusPx;
    if (rawDrop === undefined || rawDrop === '') {
      peerDisconnectRadiusPx = radiusPx + 15;
      // Clamp default into valid range for edge cases (e.g. radius 0 where 15 > 0)
      if (peerDisconnectRadiusPx > 3 * radiusPx) peerDisconnectRadiusPx = 3 * radiusPx;
      if (peerDisconnectRadiusPx < radiusPx) peerDisconnectRadiusPx = radiusPx;
    } else {
      peerDisconnectRadiusPx = Number(rawDrop);
      if (!Number.isFinite(peerDisconnectRadiusPx)) {
        throw new Error(`Env PEER_DISCONNECT_RADIUS_PX must be a number, got "${rawDrop}"`);
      }
      if (peerDisconnectRadiusPx < radiusPx) {
        throw new Error(`Env PEER_DISCONNECT_RADIUS_PX must be >= PROXIMITY_RADIUS_PX (${radiusPx}), got ${peerDisconnectRadiusPx}`);
      }
      if (peerDisconnectRadiusPx > 3 * radiusPx) {
        throw new Error(`Env PEER_DISCONNECT_RADIUS_PX must be <= 3 * PROXIMITY_RADIUS_PX (${3 * radiusPx}), got ${peerDisconnectRadiusPx}`);
      }
    }
    return {
      radiusPx,
      maxPeersPerUser,
      peerDisconnectRadiusPx,
    };
  })()),

  presence: Object.freeze({
    // Node clamps overflowing intervals to 1 ms; reject them before boot.
    cleanupIntervalMs: num('PRESENCE_CLEANUP_INTERVAL_MS', 30000, { min: 1, max: 2 ** 31 - 1 }),
    timeoutMs: num('PRESENCE_TIMEOUT_MS', 60000, { min: 1, max: 2 ** 31 - 1 }),
  }),

  socket: Object.freeze({
    moveEventsPerSec: num('SOCKET_MOVE_EPS', 30, { min: 1, max: 1000 }),
    maxStepPx: num('SOCKET_MAX_STEP_PX', 120, { min: 1, max: 100000 }),
    signalEventsPerSec: num('SOCKET_SIGNAL_EPS', 30, { min: 1, max: 1000 }),
    signalBurst: num('SOCKET_SIGNAL_BURST', 200, { min: 1, max: 10000 }),
  }),

  audit: Object.freeze({
    enabled: process.env.AUDIT_ENABLED === undefined || process.env.AUDIT_ENABLED === ''
      ? nodeEnv !== 'production'
      : ['1', 'true', 'yes'].includes(String(process.env.AUDIT_ENABLED).toLowerCase()),
    targetMs: num('AUDIT_TARGET_MS', 20, { min: 0.001, max: 60000 }),
  }),

  scaleCheck: Object.freeze({
    url1: str('SCALE_CHECK_URL_1', str('SCALE_CHECK_URL_A', 'http://127.0.0.1:4000')),
    url2: str('SCALE_CHECK_URL_2', str('SCALE_CHECK_URL_B', 'http://127.0.0.1:4001')),
    urlA: str('SCALE_CHECK_URL_A', str('SCALE_CHECK_URL_1', 'http://127.0.0.1:4000')),
    urlB: str('SCALE_CHECK_URL_B', str('SCALE_CHECK_URL_2', 'http://127.0.0.1:4001')),
    roomId: str('SCALE_CHECK_ROOM', 'lobby'),
  }),

  world,
});

export default config;
