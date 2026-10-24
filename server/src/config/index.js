/**
 * Central configuration. Every tunable lives here and is sourced from .env
 * (server/.env wins over the repo-root .env). Nothing else in the server
 * codebase reads process.env directly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseIceServers } from './iceServers.js';
import { createLogger } from '../utils/loggerCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// dotenv never overrides an already-set key, so the more specific file is
// loaded first and therefore has the higher effective priority.
for (const candidate of [path.join(SERVER_ROOT, '.env'), path.join(REPO_ROOT, '.env')]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

const configLog = createLogger('error', 'config');

/** Fatal config errors happen before the app logger can be constructed. Exit
 * after one logger line instead of letting Node print a module stack trace. */
function invalid(key, requirement) {
  configLog.error(`Env ${key} ${requirement}`);
  process.exit(1);
}

const str = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const num = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = process.env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) invalid(key, 'must be a finite number');
  if (value < min || value > max) invalid(key, `must be within [${min}, ${max}]`);
  return value;
};

const integer = (key, fallback, options = {}) => {
  const value = num(key, fallback, options);
  if (!Number.isInteger(value)) invalid(key, 'must be an integer');
  return value;
};

const bool = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return invalid(key, 'must be one of 1, 0, true, false, yes, no');
};

function checkedUrl(key, raw, { protocols, allowEmpty = false, originOnly = false } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (allowEmpty && value === '') return '';
  try {
    if (typeof value !== 'string' || !value) throw new Error('empty');
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error('protocol');
    if (originOnly && (
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    )) throw new Error('origin');
    return originOnly ? parsed.origin : value;
  } catch {
    return invalid(
      key,
      originOnly
        ? 'must contain only http:// or https:// origins (or *)'
        : `must be a valid ${protocols.join(' or ')} URL`,
    );
  }
}

const url = (key, fallback, options) => checkedUrl(key, str(key, fallback), options);

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
  if (typeof value !== 'string' || !pattern.test(value)) invalid(key, 'has an unsupported format');
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

/** CONNECT radius, DROP radius (hysteresis), and the symmetric peer cap. */
function buildProximityConfig() {
  const radiusPx = num('PROXIMITY_RADIUS_PX', 100, { min: 0, max: Math.hypot(world.width, world.height) });
  const maxPeersPerUser = integer('MAX_PEERS_PER_USER', 8, { min: 0, max: 100000 });

  const rawDrop = process.env.PEER_DISCONNECT_RADIUS_PX;
  const peerDisconnectRadiusPx = rawDrop === undefined || rawDrop === ''
    ? (radiusPx === 0 ? 0 : Math.min(radiusPx + 15, radiusPx * 3))
    : Number(rawDrop);
  if (!Number.isFinite(peerDisconnectRadiusPx)) {
    invalid('PEER_DISCONNECT_RADIUS_PX', 'must be a finite number');
  }
  if (peerDisconnectRadiusPx < radiusPx) {
    invalid('PEER_DISCONNECT_RADIUS_PX', `must be >= PROXIMITY_RADIUS_PX (${radiusPx})`);
  }
  if (peerDisconnectRadiusPx > radiusPx * 3) {
    invalid('PEER_DISCONNECT_RADIUS_PX', `must be <= 3 x PROXIMITY_RADIUS_PX (${radiusPx * 3})`);
  }

  return { radiusPx, peerDisconnectRadiusPx, maxPeersPerUser };
}

function scaleUrl(primary, alias, fallback) {
  const primaryRaw = process.env[primary];
  const aliasRaw = process.env[alias];
  const sourceKey = primaryRaw !== undefined && primaryRaw !== ''
    ? primary
    : aliasRaw !== undefined && aliasRaw !== ''
      ? alias
      : primary;
  return checkedUrl(sourceKey, str(primary, str(alias, fallback)), {
    protocols: ['http:', 'https:'],
  });
}

const clientOrigins = list('CLIENT_URL', '').map((origin) => (
  origin === '*' ? origin : checkedUrl('CLIENT_URL', origin, {
    protocols: ['http:', 'https:'], originOnly: true,
  })
));

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  logLevel: str('LOG_LEVEL', 'info'),

  /** ICE servers handed to browsers inside `joined` / `peer:connect`. */
  iceServers: ice.servers,
  /** Non-null only when ICE_SERVERS was malformed; logged once at boot. */
  iceServersWarning: ice.warning,

  server: Object.freeze({
    port: integer('PORT', 4000, { min: 1, max: 65535 }),
    host: str('HOST', '0.0.0.0'),
    /** Empty is same-origin in production and reflect-any in development. */
    clientOrigins,
    /** Random per-process id unless explicitly overridden. */
    instanceId: checkedPattern(
      'INSTANCE_ID',
      str('INSTANCE_ID', `node-${crypto.randomBytes(6).toString('hex')}`),
      INSTANCE_ID_PATTERN,
    ),
  }),

  mongo: Object.freeze({
    // Never logged verbatim — db/mongo.js redacts credentials before output.
    uri: url('MONGO_URI', 'mongodb://127.0.0.1:27017/proxispeak', {
      protocols: ['mongodb:', 'mongodb+srv:'],
    }),
    serverSelectionTimeoutMS: integer('MONGO_TIMEOUT_MS', 8000, { min: 500, max: 2 ** 31 - 1 }),
  }),

  redis: Object.freeze({
    // Empty keeps pure single-instance in-memory behaviour.
    url: url('REDIS_URL', '', { protocols: ['redis:', 'rediss:'], allowEmpty: true }),
    keyPrefix: checkedPattern(
      'REDIS_KEY_PREFIX',
      str('REDIS_KEY_PREFIX', 'proxispeak'),
      REDIS_PREFIX_PATTERN,
    ),
    edgeSweepIntervalMs: integer('EDGE_SWEEP_INTERVAL_MS', 30000, { min: 1, max: 2 ** 31 - 1 }),
    connectTimeoutMs: integer('REDIS_CONNECT_TIMEOUT_MS', 3000, { min: 100, max: 60000 }),
    edgeTtlSeconds: integer('REDIS_EDGE_TTL_SECONDS', 3600, { min: 60, max: 604800 }),
  }),

  proximity: Object.freeze(buildProximityConfig()),

  presence: Object.freeze({
    // Node clamps overflowing intervals to 1 ms; reject them before boot.
    cleanupIntervalMs: integer('PRESENCE_CLEANUP_INTERVAL_MS', 30000, { min: 1, max: 2 ** 31 - 1 }),
    timeoutMs: integer('PRESENCE_TIMEOUT_MS', 60000, { min: 1, max: 2 ** 31 - 1 }),
  }),

  socket: Object.freeze({
    moveEventsPerSec: num('SOCKET_MOVE_EPS', 30, { min: 1, max: 1000 }),
    maxStepPx: num('SOCKET_MAX_STEP_PX', 120, { min: 1, max: 100000 }),
    signalEventsPerSec: num('SOCKET_SIGNAL_EPS', 30, { min: 1, max: 1000 }),
    signalBurst: integer('SOCKET_SIGNAL_BURST', 200, { min: 1, max: 10000 }),
  }),

  audit: Object.freeze({
    enabled: bool('AUDIT_ENABLED', nodeEnv !== 'production'),
    targetMs: num('AUDIT_TARGET_MS', 20, { min: 0.001, max: 60000 }),
  }),

  scaleCheck: Object.freeze({
    url1: scaleUrl('SCALE_CHECK_URL_1', 'SCALE_CHECK_URL_A', 'http://127.0.0.1:4000'),
    url2: scaleUrl('SCALE_CHECK_URL_2', 'SCALE_CHECK_URL_B', 'http://127.0.0.1:4001'),
    urlA: scaleUrl('SCALE_CHECK_URL_A', 'SCALE_CHECK_URL_1', 'http://127.0.0.1:4000'),
    urlB: scaleUrl('SCALE_CHECK_URL_B', 'SCALE_CHECK_URL_2', 'http://127.0.0.1:4001'),
    roomId: str('SCALE_CHECK_ROOM', 'lobby'),
  }),

  world,
});

export default config;
