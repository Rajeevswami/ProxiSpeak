/**
 * Express surface (Day 1): middleware + health. The room catalogue, live
 * stats and the Spatial Audit endpoint arrive with the MongoDB/Socket.io
 * days and plug in under the same error handler.
 */
import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import logger from './utils/logger.js';
import { runSpatialAudit, validateAuditParams } from './services/spatialAudit.js';

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
    const status = err.status ?? 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} ->`, err.message);
    res.status(status).json({ ok: false, error: err.message });
  });

  return app;
}

export default createApp;
