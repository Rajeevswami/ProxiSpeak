/**
 * Express surface tests (Day 6). No database and no socket server: the app is
 * served on an ephemeral port and exercised over real HTTP (`/health` is a
 * Week 1 review item, and the CORS policy is what makes the browser client
 * work at all, so both deserve a test that does not need MongoDB).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { io as createClient } from 'socket.io-client';

import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createScaleState } from '../src/db/redis.js';
import { createApp } from '../src/app.js';
import { createSocketServer } from '../src/sockets/index.js';

const log = createLogger('error');

/** Start the app on a free port, exactly as server/src/index.js does. */
async function startApp(
  serverOverrides = {},
  { scaleState = null, staticDir = false, logger = log, roomService, withSockets = false } = {},
) {
  const cfg = { ...config, server: { ...config.server, ...serverOverrides } };
  const app = createApp({ config: cfg, logger, scaleState, staticDir, ...(roomService ? { roomService } : {}) });
  const server = http.createServer();
  server.on('request', app);
  const io = withSockets ? createSocketServer({ httpServer: server, config: cfg, logger }) : null;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (io) await new Promise((resolve) => io.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createFixtureDist(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxispeak-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const indexHtml = '<!doctype html><html><head><title>ProxiSpeak</title></head><body><div id="root"></div></body></html>';
  const jsAsset = 'console.log("proxispeak-hashed-bundle");';
  const cssAsset = 'body{background:#05070d;}';
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml, 'utf8');
  fs.writeFileSync(path.join(dir, 'assets', 'index-DuXB0dlR.js'), jsAsset, 'utf8');
  fs.writeFileSync(path.join(dir, 'assets', 'index-D67G7T0U.css'), cssAsset, 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=never_serve', 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, indexHtml, jsAsset, cssAsset };
}

function rawHttpGet(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /health answers with the service status and no server banner', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null, 'x-powered-by is disabled');
  assert.match(response.headers.get('content-type'), /application\/json/);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'proxispeak');
  assert.equal(typeof body.instanceId, 'string');
  assert.ok(body.instanceId.length > 0);
  assert.equal(body.scaleMode, 'single');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(!Number.isNaN(Date.parse(body.time)), `time is a timestamp: ${body.time}`);
});

test('GET /health reports cached instanceId and live scaleMode transitions without backing-service I/O', async (t) => {
  const scaleState = createScaleState('node-west-2', 'redis');
  const app = await startApp({}, { scaleState });
  t.after(app.close);

  const healthy = await (await fetch(`${app.baseUrl}/health`)).json();
  assert.equal(healthy.instanceId, 'node-west-2');
  assert.equal(healthy.scaleMode, 'redis');

  scaleState.setMode('redis-degraded');
  const degraded = await (await fetch(`${app.baseUrl}/health`)).json();
  assert.equal(degraded.status, 'ok');
  assert.equal(degraded.instanceId, 'node-west-2');
  assert.equal(degraded.scaleMode, 'redis-degraded');
});

test('an unknown route is a JSON 404, not an HTML error page', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/no/such/route`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'No route for GET /no/such/route' });
});

test('a malformed JSON body is answered by the error handler', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"unterminated":',
  });
  assert.equal(response.status, 400, 'the parser error keeps its status');
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, 'string');
});

test('CORS grants a listed origin and withholds a wildcard from the rest', async (t) => {
  const app = await startApp({ clientOrigins: ['http://localhost:5173'] });
  t.after(app.close);

  const allowed = await fetch(`${app.baseUrl}/health`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const refused = await fetch(`${app.baseUrl}/health`, { headers: { origin: 'http://evil.example' } });
  assert.equal(refused.status, 200, 'the response is still served — the browser blocks it');
  assert.equal(refused.headers.get('access-control-allow-origin'), null);

  // A browser sends a preflight for anything but a simple GET; it must be
  // answered for the listed origin.
  const preflight = await fetch(`${app.baseUrl}/health`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
  });
  assert.ok([200, 204].includes(preflight.status), `preflight status ${preflight.status}`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('CORS reflects any origin when CLIENT_URL is left unset in non-production', async (t) => {
  const app = await startApp({ clientOrigins: [] });
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/health`, { headers: { origin: 'http://anywhere.example' } });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'http://anywhere.example',
    'the documented Day 1 default with no CLIENT_URL configured',
  );
});

test('CORS is same-origin only in production when CLIENT_URL is empty (aligned with Socket.io)', async (t) => {
  const cfg = { ...config, isProduction: true, server: { ...config.server, clientOrigins: [] } };
  const app = createApp({ config: cfg, logger: log });
  const server = http.createServer();
  server.on('request', app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`${baseUrl}/health`, { headers: { origin: 'http://anywhere.example' } });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    null,
    'production with no CLIENT_URL must not reflect arbitrary origins',
  );

  // Non-browser clients without Origin are still served (CORS is a browser protection).
  const noOrigin = await fetch(`${baseUrl}/health`);
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('a request without an Origin header is served like any other', async (t) => {
  const app = await startApp({ clientOrigins: ['http://localhost:5173'] });
  t.after(app.close);

  // curl, a health probe, a smoke test: no Origin, so no CORS decision to make.
  const response = await fetch(`${app.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('static serving: GET / serves index.html with no-cache and hashed assets with long-lived immutable cache', async (t) => {
  const fixture = createFixtureDist(t);
  const app = await startApp({}, { staticDir: fixture.dir });
  t.after(app.close);

  const indexRes = await fetch(`${app.baseUrl}/`);
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(indexRes.headers.get('cache-control'), 'no-cache');
  assert.equal(await indexRes.text(), fixture.indexHtml);

  const jsRes = await fetch(`${app.baseUrl}/assets/index-DuXB0dlR.js`);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type') ?? '', /javascript/);
  assert.equal(jsRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await jsRes.text(), fixture.jsAsset);

  const cssRes = await fetch(`${app.baseUrl}/assets/index-D67G7T0U.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type') ?? '', /text\/css/);
  assert.equal(cssRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await cssRes.text(), fixture.cssAsset);
});

test('SPA fallback serves index.html with no-cache for GET deep links without swallowing /api/*, /health or non-GET routes', async (t) => {
  const fixture = createFixtureDist(t);
  const app = await startApp({}, { staticDir: fixture.dir });
  t.after(app.close);

  for (const deepLink of ['/rooms/lobby', '/join/studio?perf=1', '/deep/nested/route']) {
    const res = await fetch(`${app.baseUrl}${deepLink}`);
    assert.equal(res.status, 200, `deep link ${deepLink} should return 200`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(await res.text(), fixture.indexHtml);
  }

  // Unknown /api/* paths still return JSON 404
  for (const apiPath of ['/api/unknown', '/api/rooms/lobby/unknown', '/api']) {
    const apiRes = await fetch(`${app.baseUrl}${apiPath}`);
    assert.equal(apiRes.status, 404, `unknown API path ${apiPath} must stay 404`);
    assert.match(apiRes.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await apiRes.json(), { ok: false, error: `No route for GET ${apiPath}` });
  }

  // /health still returns JSON 200
  const healthRes = await fetch(`${app.baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.match(healthRes.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await healthRes.json()).status, 'ok');

  // Non-GET unknown paths still return JSON 404
  const postRes = await fetch(`${app.baseUrl}/rooms/lobby`, { method: 'POST' });
  assert.equal(postRes.status, 404);
  assert.deepEqual(await postRes.json(), { ok: false, error: 'No route for POST /rooms/lobby' });

  // Missing asset files with extensions return JSON 404, not index.html
  const missingAsset = await fetch(`${app.baseUrl}/assets/does-not-exist.js`);
  assert.equal(missingAsset.status, 404);
  assert.match(missingAsset.headers.get('content-type') ?? '', /application\/json/);
});

test('/socket.io handshake still works on the same port when static serving and SPA fallback are active', async (t) => {
  const fixture = createFixtureDist(t);
  const app = await startApp({}, { staticDir: fixture.dir, withSockets: true });
  t.after(app.close);

  // Engine.IO polling handshake on /socket.io
  const handshake = await fetch(`${app.baseUrl}/socket.io/?EIO=4&transport=polling`);
  assert.equal(handshake.status, 200);
  const handshakeText = await handshake.text();
  assert.ok(!handshakeText.includes('<div id="root">'), '/socket.io must never be swallowed by SPA fallback');
  assert.ok(handshakeText.includes('"sid"'), 'Engine.IO handshake payload contains session id');

  // Full socket.io-client connection on the same origin/port
  const socket = createClient(app.baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  t.after(() => socket.close());
  await once(socket, 'connect');
  assert.ok(socket.id, 'socket.io-client connected on the same port as static serving');
});

test('path traversal and dotfile requests are blocked and never leak files or fall back to index.html', async (t) => {
  const fixture = createFixtureDist(t);
  const app = await startApp({}, { staticDir: fixture.dir });
  t.after(app.close);

  const traversalPaths = [
    '/../../package.json',
    '/../../../package.json',
    '/%2e%2e/%2e%2e/package.json',
    '/assets/..%2f..%2fpackage.json',
    '/..%5c..%5cpackage.json',
    '/%00index.html',
    '/.env',
    '/package.json',
  ];

  for (const reqPath of traversalPaths) {
    const raw = await rawHttpGet(app.port, reqPath);
    assert.ok(raw.status === 400 || raw.status === 404, `expected 400/404 for ${reqPath}, got ${raw.status}`);
    assert.ok(!raw.body.includes('"proxispeak"'), `leaked package.json on ${reqPath}`);
    assert.ok(!raw.body.includes('SECRET=never_serve'), `leaked .env on ${reqPath}`);
    assert.ok(!raw.body.includes('<div id="root">'), `fell back to index.html on ${reqPath}`);
  }
});

test('missing client/dist logs one clear warning while API and Socket.io still work', async (t) => {
  const warnings = [];
  const customLogger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args) => warnings.push(args.join(' ')),
    child: () => customLogger,
  };
  const missingDir = path.join(os.tmpdir(), `proxispeak-missing-dist-${process.pid}-${Date.now()}`);
  const mockRoomService = {
    async listRooms() {
      return [{ roomId: 'lobby', name: 'Lobby', layoutRevision: 1 }];
    },
    async getRoom() {
      return null;
    },
    async saveLayout() {
      return null;
    },
  };

  const app = await startApp({}, {
    staticDir: missingDir,
    logger: customLogger,
    roomService: mockRoomService,
    withSockets: true,
  });
  t.after(app.close);

  assert.equal(warnings.length, 1, 'logs exactly one warning when client/dist is missing');
  assert.match(warnings[0], /Client build not found/);
  assert.ok(warnings[0].includes(missingDir));

  // /health and /api/rooms still work
  const healthRes = await fetch(`${app.baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const roomsRes = await fetch(`${app.baseUrl}/api/rooms`);
  assert.equal(roomsRes.status, 200);
  assert.deepEqual(await roomsRes.json(), [{ roomId: 'lobby', name: 'Lobby', layoutRevision: 1 }]);

  // Unknown GET routes return JSON 404 when dist is missing
  const rootRes = await fetch(`${app.baseUrl}/`);
  assert.equal(rootRes.status, 404);
  assert.deepEqual(await rootRes.json(), { ok: false, error: 'No route for GET /' });

  // Socket.io still connects
  const socket = createClient(app.baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  t.after(() => socket.close());
  await once(socket, 'connect');
  assert.ok(socket.id);
});

test('HEAD requests for index, deep links, and hashed assets return matching headers and empty body', async (t) => {
  const fixture = createFixtureDist(t);
  const app = await startApp({}, { staticDir: fixture.dir });
  t.after(app.close);

  const headIndex = await fetch(`${app.baseUrl}/`, { method: 'HEAD' });
  assert.equal(headIndex.status, 200);
  assert.match(headIndex.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(headIndex.headers.get('cache-control'), 'no-cache');
  assert.equal(await headIndex.text(), '');

  const headDeep = await fetch(`${app.baseUrl}/rooms/lobby`, { method: 'HEAD' });
  assert.equal(headDeep.status, 200);
  assert.match(headDeep.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(headDeep.headers.get('cache-control'), 'no-cache');
  assert.equal(await headDeep.text(), '');

  const headAsset = await fetch(`${app.baseUrl}/assets/index-DuXB0dlR.js`, { method: 'HEAD' });
  assert.equal(headAsset.status, 200);
  assert.match(headAsset.headers.get('content-type') ?? '', /javascript/);
  assert.equal(headAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await headAsset.text(), '');
});
