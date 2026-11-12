/**
 * API tests for Room persistence and layout administration (Week 4 - Room Persistence).
 * Tests token guard, constant-time comparison, public reads, validation formatting,
 * error codes (400, 401, 403, 404, 409, 413, 429), and token redaction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, verifyAdminToken, createIpRateLimiter } from '../src/app.js';
import config from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { RoomNotFoundError, RevisionConflictError, ValidationError } from '../src/utils/errors.js';

const log = createLogger('error');

const SAMPLE_ROOM = {
  roomId: 'lobby',
  name: 'Lobby',
  description: 'Default office blueprint',
  width: 1920,
  height: 1080,
  layoutRevision: 1,
  obstacles: [
    {
      id: 'desk-1',
      type: 'desk',
      x: 100,
      y: 100,
      w: 80,
      h: 40,
      blocksAudio: true,
      attenuation: 0.5,
    },
  ],
  spawnPoints: [{ x: 50, y: 50 }],
};

function createMockRoomService() {
  const rooms = new Map([['lobby', { ...SAMPLE_ROOM }]]);

  return {
    async listRooms() {
      return Array.from(rooms.values()).map((r) => ({
        roomId: r.roomId,
        name: r.name,
        layoutRevision: r.layoutRevision,
      }));
    },
    async getRoom(id) {
      return rooms.get(id) ?? null;
    },
    async saveLayout(id, payload) {
      const room = rooms.get(id);
      if (!room) throw new RoomNotFoundError(id);

      if (payload.expectedRevision !== room.layoutRevision) {
        throw new RevisionConflictError(id, payload.expectedRevision, room.layoutRevision);
      }

      if (!Array.isArray(payload.obstacles)) {
        throw new ValidationError('"obstacles" must be an array', { path: 'obstacles' });
      }

      const updated = {
        ...room,
        layoutRevision: room.layoutRevision + 1,
        obstacles: payload.obstacles,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.description ? { description: payload.description } : {}),
      };
      rooms.set(id, updated);
      return updated;
    },
  };
}

async function startTestServer({
  adminToken = 'test-secret-token-12345',
  roomService = createMockRoomService(),
  rateLimiter = createIpRateLimiter({ capacity: 10, refillPerSec: 10 }),
} = {}) {
  const cfg = {
    ...config,
    room: {
      adminToken,
      maxObstacles: 200,
    },
  };
  const app = createApp({
    config: cfg,
    logger: log,
    roomService,
    layoutRateLimiter: rateLimiter,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('constant-time token verification works correctly and handles edge cases', () => {
  const secret = 'super-secret-token-1234567890';
  assert.equal(verifyAdminToken(secret, secret), true);
  assert.equal(verifyAdminToken('wrong-token', secret), false);
  assert.equal(verifyAdminToken(secret.slice(0, -1), secret), false);
  assert.equal(verifyAdminToken(secret + 'x', secret), false);
  assert.equal(verifyAdminToken('', secret), false);
  assert.equal(verifyAdminToken(secret, ''), false);
  assert.equal(verifyAdminToken(null, secret), false);
  assert.equal(verifyAdminToken(undefined, secret), false);
});

test('GET /api/rooms is public and returns room summaries', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const res = await fetch(`${server.baseUrl}/api/rooms`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 1);
  assert.deepEqual(data[0], {
    roomId: 'lobby',
    name: 'Lobby',
    layoutRevision: 1,
  });
});

test('GET /api/rooms/:roomId is public and returns full layout for valid room', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const res = await fetch(`${server.baseUrl}/api/rooms/lobby`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.roomId, 'lobby');
  assert.equal(data.width, 1920);
  assert.equal(data.layoutRevision, 1);
  assert.ok(Array.isArray(data.obstacles));
});

test('GET /api/rooms/:roomId rejects malformed roomId with 400', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const badIds = ['LOBBY_UPPERCASE', 'has space', 'has$dollar', 'a'.repeat(49)];
  for (const bad of badIds) {
    const res = await fetch(`${server.baseUrl}/api/rooms/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error?.code, 'invalid_room_id');
  }
});

test('GET /api/rooms/:roomId returns 404 for unknown room', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const res = await fetch(`${server.baseUrl}/api/rooms/unknown-room`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error?.code, 'room_not_found');
  assert.match(data.error?.message, /not found/);
});

test('PUT /api/rooms/:roomId/layout returns 403 editing_disabled when ROOM_ADMIN_TOKEN is unset/empty', async (t) => {
  const server = await startTestServer({ adminToken: '' });
  t.after(server.close);

  const res = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': 'any-token',
    },
    body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error?.code, 'editing_disabled');
});

test('PUT /api/rooms/:roomId/layout returns 401 unauthorized when token is missing or wrong', async (t) => {
  const secret = 'valid-room-admin-token-xyz';
  const server = await startTestServer({ adminToken: secret });
  t.after(server.close);

  // Missing header
  const resMissing = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
  });
  assert.equal(resMissing.status, 401);
  const dataMissing = await resMissing.json();
  assert.equal(dataMissing.error?.code, 'unauthorized');

  // Wrong token
  const resWrong = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': 'incorrect-token',
    },
    body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
  });
  assert.equal(resWrong.status, 401);
  const dataWrong = await resWrong.json();
  assert.equal(dataWrong.error?.code, 'unauthorized');
});

test('PUT /api/rooms/:roomId/layout saves successfully with valid token and revision', async (t) => {
  const secret = 'valid-room-admin-token-xyz';
  const server = await startTestServer({ adminToken: secret });
  t.after(server.close);

  const newObstacles = [
    {
      id: 'wall-new',
      type: 'wall',
      x: 10,
      y: 10,
      w: 100,
      h: 20,
      blocksAudio: true,
      attenuation: 0.12,
    },
  ];

  const res = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': secret,
    },
    body: JSON.stringify({
      expectedRevision: 1,
      obstacles: newObstacles,
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.layoutRevision, 2);
  assert.deepEqual(data.obstacles, newObstacles);
});

test('PUT /api/rooms/:roomId/layout returns 409 revision_conflict on stale revision', async (t) => {
  const secret = 'valid-room-admin-token-xyz';
  const server = await startTestServer({ adminToken: secret });
  t.after(server.close);

  const res = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': secret,
    },
    body: JSON.stringify({
      expectedRevision: 999, // Stale! Current is 1
      obstacles: [],
    }),
  });

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error?.code, 'revision_conflict');
  assert.equal(data.error?.details?.currentRevision, 1);
});

test('PUT /api/rooms/:roomId/layout enforces IP rate limit returning 429', async (t) => {
  const secret = 'valid-room-admin-token-xyz';
  // Rate limiter that allows only 2 requests immediately
  const tightLimiter = createIpRateLimiter({ capacity: 2, refillPerSec: 0.01 });
  const server = await startTestServer({ adminToken: secret, rateLimiter: tightLimiter });
  t.after(server.close);

  const reqOpts = {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': secret,
    },
    body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
  };

  const res1 = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, reqOpts);
  assert.equal(res1.status, 200);

  const res2 = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, reqOpts);
  // May be 409 due to revision bump or 200, but not 429 yet
  assert.ok(res2.status === 200 || res2.status === 409);

  // Third request must exceed bucket and hit 429
  const res3 = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, reqOpts);
  assert.equal(res3.status, 429);
  const data = await res3.json();
  assert.equal(data.error?.code, 'rate_limited');
});

test('PUT /api/rooms/:roomId/layout returns 413 when body exceeds 64kb', async (t) => {
  const secret = 'valid-room-admin-token-xyz';
  const server = await startTestServer({ adminToken: secret });
  t.after(server.close);

  // Send a body > 64KB
  const oversized = 'x'.repeat(70 * 1024);
  const res = await fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-room-admin-token': secret,
    },
    body: JSON.stringify({ expectedRevision: 1, padding: oversized }),
  });

  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error?.code, 'payload_too_large');
});

test('admin token never appears in responses or error payloads', async (t) => {
  const secret = 'super-confidential-token-999';
  const server = await startTestServer({ adminToken: secret });
  t.after(server.close);

  // Test across multiple status endpoints: 200, 401, 409
  const checks = [
    fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-room-admin-token': 'wrong' },
      body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
    }),
    fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-room-admin-token': secret },
      body: JSON.stringify({ expectedRevision: 99, obstacles: [] }),
    }),
    fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-room-admin-token': secret },
      body: JSON.stringify({ expectedRevision: 1, obstacles: [] }),
    }),
    fetch(`${server.baseUrl}/api/rooms/lobby/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-room-admin-token': secret },
      body: `{"obstacles": ${secret}}`,
    }),
  ];

  for (const promise of checks) {
    const res = await promise;
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(secret));
  }
});
