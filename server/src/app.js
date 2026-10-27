/**
 * Express surface (Day 1): middleware + health. The room catalogue, live
 * stats and the Spatial Audit endpoint arrive with the MongoDB/Socket.io
 * days and plug in under the same error handler.
 */
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import config from './config/index.js';
import logger from './utils/logger.js';
import { runSpatialAudit, validateAuditParams } from './services/spatialAudit.js';
import * as defaultRoomService from './services/roomService.js';
import { TokenBucket } from './utils/rateLimiter.js';
import { AppError } from './utils/errors.js';

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Constant-time string comparison preventing timing side-channel attacks on secret tokens.
 */
export function verifyAdminToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  const hashExpected = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

/**
 * Creates an in-memory IP rate limiter reusing TokenBucket.
 */
export function createIpRateLimiter({ capacity = 10, refillPerSec = 2, maxIps = 5000 } = {}) {
  const buckets = new Map();
  return (ip) => {
    const key = String(ip || 'unknown');
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxIps) {
        const toDelete = Array.from(buckets.keys()).slice(0, Math.floor(maxIps / 2));
        for (const k of toDelete) buckets.delete(k);
      }
      bucket = new TokenBucket({ capacity, refillPerSec });
      buckets.set(key, bucket);
    }
    return bucket.take();
  };
}

/**
 * HTTP CORS origin resolver. Mirrors the Socket.io policy in utils/origin.js
 * so the HTTP API and the WebSocket can never drift apart.
 *
 *   CLIENT_URL list      -> strict allow-list
 *   CLIENT_URL="*"       -> `true` (reflect any origin)
 *   CLIENT_URL empty     -> production: `false` (same-origin only);
 *                           non-production: `true` (dev convenience)
 *
 * Non-browser callers (curl, health probes) send no Origin and are always
 * served regardless — CORS is a browser protection, not authentication.
 */
export function httpCorsOrigin(cfg = config) {
  const origins = cfg.server.clientOrigins;
  if (origins.includes('*')) return true;
  if (origins.length > 0) return origins;
  if (cfg.isProduction) return false;
  return true;
}

export function createApp({
  config: cfg = config,
  logger: log = logger,
  auditRunner = runSpatialAudit,
  scaleState = null,
  roomService: roomSvc = defaultRoomService,
  layoutRateLimiter = createIpRateLimiter({ capacity: 10, refillPerSec: 2 }),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Reverse proxies (Nginx, PaaS routers) terminate TLS and forward
  // X-Forwarded-*; trusting one hop keeps req.ip / protocol truthful.
  app.set('trust proxy', 1);
  // CORS rule, aligned with the Socket.io layer (utils/origin.js):
  //   - CLIENT_URL set (list)        -> strict allow-list
  //   - CLIENT_URL="*"               -> reflect any origin (explicit opt-in)
  //   - CLIENT_URL empty, non-prod   -> reflect any origin (Day 1 dev default)
  //   - CLIENT_URL empty, production -> same-origin only (no reflection),
  //     matching the Socket.io `false` policy exactly.
  app.use(cors({ origin: httpCorsOrigin(cfg) }));
  app.use(express.json({ limit: '64kb' }));

  const startedAt = Date.now();

  /**
   * Liveness endpoint. Deliberately dependency-free — it never touches a
   * database or cache, so a blip in a backing service can never mark a
   * healthy process as dead.
   */
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'proxispeak',
      instanceId: scaleState?.instanceId ?? cfg.server.instanceId,
      scaleMode: scaleState?.mode ?? 'single',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    });
  });

  // ----------------------------------------------------------- Room API ---

  /**
   * GET /api/rooms: Public read of available rooms (ids, names, revisions).
   */
  app.get('/api/rooms', async (req, res, next) => {
    try {
      const rooms = await roomSvc.listRooms();
      return res.status(200).json(rooms);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /api/rooms/:roomId: Public read of full room layout.
   */
  app.get('/api/rooms/:roomId', async (req, res, next) => {
    const { roomId } = req.params;
    if (!ROOM_ID_PATTERN.test(roomId)) {
      return res.status(400).json({
        error: {
          code: 'invalid_room_id',
          message: 'Invalid roomId format: must be 1-48 lowercase alphanumeric, hyphen, or underscore characters',
        },
      });
    }

    try {
      const room = await roomSvc.getRoom(roomId);
      if (!room) {
        return res.status(404).json({
          error: {
            code: 'room_not_found',
            message: `Room "${roomId}" not found`,
            details: { roomId },
          },
        });
      }
      return res.status(200).json(room);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * PUT /api/rooms/:roomId/layout: Guarded save of room layout with revision check.
   */
  app.put('/api/rooms/:roomId/layout', async (req, res, next) => {
    const adminToken = cfg.room?.adminToken;
    if (!adminToken || adminToken.trim() === '') {
      return res.status(403).json({
        error: {
          code: 'editing_disabled',
          message: 'Room layout editing is disabled (ROOM_ADMIN_TOKEN is unset)',
        },
      });
    }

    const headerToken = req.headers['x-room-admin-token'];
    if (!headerToken || !verifyAdminToken(headerToken, adminToken)) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Invalid room admin token',
        },
      });
    }

    if (!layoutRateLimiter(req.ip)) {
      return res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'Too many layout update requests; please slow down',
        },
      });
    }

    const { roomId } = req.params;
    if (!ROOM_ID_PATTERN.test(roomId)) {
      return res.status(400).json({
        error: {
          code: 'invalid_room_id',
          message: 'Invalid roomId format: must be 1-48 lowercase alphanumeric, hyphen, or underscore characters',
        },
      });
    }

    try {
      const io = app.get('io');
      const saved = await roomSvc.saveLayout(roomId, req.body, { io });
      return res.status(200).json(saved);
    } catch (err) {
      return next(err);
    }
  });

  // Mid-Review Spatial Audit. Guarded: disabled unless config.audit.enabled
  // (default off in production), params validated/capped, one run at a time,
  // and the caller can never choose the room (always a throwaway audit room).
  let auditRunning = false;
  app.get('/api/spatial-audit', async (req, res, next) => {
    if (!cfg.audit?.enabled) return res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
    if (req.query.roomId !== undefined) {
      return res.status(400).json({ ok: false, error: 'roomId is not accepted; the audit always uses its own throwaway room' });
    }
    let params;
    try {
      params = validateAuditParams({ users: req.query.users ?? 50, samples: req.query.samples ?? 25, seed: req.query.seed ?? 1 });
    } catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    if (auditRunning) return res.status(429).json({ ok: false, error: 'a spatial audit is already running' });
    auditRunning = true;
    try {
      const report = await auditRunner(params);
      return res.status(200).json({ ok: report.ok, audit: report });
    } catch (err) { return next(err); } finally { auditRunning = false; }
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: {
          code: 'payload_too_large',
          message: 'Payload too large',
        },
      });
    }

    const isApiRoomRoute = req.originalUrl?.startsWith('/api/rooms');
    if (err?.type === 'entity.parse.failed') {
      if (isApiRoomRoute) {
        return res.status(400).json({
          error: {
            code: 'invalid_payload',
            message: 'Invalid JSON payload',
          },
        });
      }
      return res.status(400).json({ ok: false, error: 'Malformed JSON body' });
    }

    const isAppError = err instanceof AppError;

    if (isApiRoomRoute || isAppError) {
      const status = err.status ?? 500;
      if (status >= 500) log.error(`${req.method} ${req.originalUrl} ->`, err.message);
      const errBody = {
        code: err.code ?? (status === 400 ? 'invalid_payload' : 'server_error'),
        message: err.message,
      };
      if (err.details !== undefined) errBody.details = err.details;
      return res.status(status).json({ error: errBody });
    }

    const status = err.status ?? 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} ->`, err.message);
    return res.status(status).json({ ok: false, error: err.message });
  });

  return app;
}

export default createApp;
