/**
 * Express surface tests (Day 6). No database and no socket server: the app is
 * served on an ephemeral port and exercised over real HTTP (`/health` is a
 * Week 1 review item, and the CORS policy is what makes the browser client
 * work at all, so both deserve a test that does not need MongoDB).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createScaleState } from '../src/db/redis.js';
import { createApp } from '../src/app.js';

const log = createLogger('error');

/** Start the app on a free port, exactly as server/src/index.js does. */
async function startApp(serverOverrides = {}, { scaleState = null } = {}) {
  const cfg = { ...config, server: { ...config.server, ...serverOverrides } };
  const app = createApp({ config: cfg, logger: log, scaleState });
  const server = http.createServer();
  server.on('request', app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
