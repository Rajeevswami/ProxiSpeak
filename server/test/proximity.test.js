import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import config from '../src/config/index.js';
import UserPresence from '../src/models/UserPresence.js';
import { createGeoTransform, distancePx } from '../src/utils/geo.js';
import { findNearby, countWithin, computeClusters, nearQuery } from '../src/services/proximityService.js';
import { cleanupOnBoot, cleanupStale, startPresenceCleanup } from '../src/services/presenceCleanup.js';
import { refreshLastSeen, upsertPosition } from '../src/services/presenceStore.js';

const geo = createGeoTransform(config.world);
let ready = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI_TEST ?? config.mongo.uri, {
      dbName: `proxispeak_day7_test_${process.pid}_${Date.now()}`, serverSelectionTimeoutMS: 1500,
    });
    await UserPresence.createIndexes();
    ready = true;
  } catch {
    // Do not print connection strings or driver errors (may contain secrets).
    process.stderr.write('Day 7: NOT VERIFIED — MongoDB unavailable; set MONGO_URI_TEST and rerun.\n');
  }
});
after(async () => {
  if (ready) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { if (ready) await UserPresence.deleteMany({}); });
const mongoTest = (name, fn) => test(name, async (t) => {
  if (!ready) return t.skip('NOT VERIFIED — requires real MongoDB');
  await fn(t);
});
function row(id, x, y, extra = {}) {
  return { sessionId: id, instanceId: 'day7', roomId: 'room', name: id, color: '#fff',
    x, y, location: geo.point(x, y), lastSeen: new Date(), ...extra };
}
const brute = (users, center, radius = config.proximity.radiusPx) => users
  .filter((u) => u.sessionId !== center.sessionId && u.roomId === center.roomId)
  .map((u) => ({ id: u.sessionId, distancePx: distancePx(center.x, center.y, u.x, u.y) }))
  .filter((u) => u.distancePx <= radius)
  .sort((a, b) => a.distancePx - b.distancePx || a.id.localeCompare(b.id));
// Reproducible random world positions, not a hand-picked favourable fixture.
let state = 7701;
const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);

mongoTest('200 random users: 20 nearby queries and counts equal pixel brute force', async () => {
  const users = Array.from({ length: 200 }, (_, i) => row(`u${i}`, random() * 1920, random() * 1080));
  await UserPresence.insertMany(users);
  for (let i = 0; i < 20; i++) {
    const center = users[Math.floor(random() * users.length)];
    assert.deepEqual(await findNearby('room', center.sessionId), brute(users, center));
    assert.equal(await countWithin('room', center, 100), brute(users, center).length + 1);
  }
});

mongoTest('99/100/101 px horizontal, vertical, diagonal and room/self isolation', async () => {
  // Origin avoids cancellation when constructing exact diagonal distances.
  const center = row('center', 0, 0);
  const users = [center];
  for (const r of [99, 100, 101]) {
    users.push(row(`h${r}`, r, 0), row(`v${r}`, 0, r), row(`d${r}`, r * 0.6, r * 0.8));
  }
  users.push(row('other-room', 0, 0, { roomId: 'other' }));
  await UserPresence.insertMany(users);
  const result = await findNearby('room', 'center');
  assert.deepEqual(result, brute(users, center));
  assert.equal(result.length, 6);
  assert.equal(await countWithin('room', center, 100), 7);
  assert.deepEqual(await findNearby('empty', 'center'), []);
  assert.equal(await countWithin('empty', center), 0);
  assert.deepEqual(await computeClusters('empty'), []);
  assert.deepEqual(await findNearby('other', 'other-room'), []);
  assert.deepEqual(await computeClusters('other'), [['other-room']]);
});

mongoTest('connected components: chain, separate group, isolated user and movement', async () => {
  await UserPresence.insertMany([
    row('A', 100, 100), row('B', 190, 100), row('C', 280, 100),
    row('D', 700, 700), row('E', 750, 700), row('F', 1500, 900),
  ]);
  assert.deepEqual(await computeClusters('room'), [['A', 'B', 'C'], ['D', 'E'], ['F']]);
  await UserPresence.updateOne({ sessionId: 'B' }, { $set: { x: 500, y: 100, location: geo.point(500, 100) } });
  assert.deepEqual(await computeClusters('room'), [['A'], ['B'], ['C'], ['D', 'E'], ['F']]);
});

mongoTest('live-only queries, room-scoped stale broadcasts, heartbeat and boot ownership', async () => {
  const old = new Date(Date.now() - config.presence.timeoutMs - 10000);
  await UserPresence.insertMany([
    row('fresh', 10, 10), row('stale', 11, 10, { lastSeen: old }),
    row('foreign', 12, 10, { lastSeen: old, instanceId: 'foreign' }),
    row('stale-other', 10, 10, { lastSeen: old, roomId: 'other' }),
    row('heartbeat', 10, 10, { lastSeen: old }),
  ]);
  assert.deepEqual(await findNearby('room', 'fresh'), []);
  assert.deepEqual(await findNearby('room', 'stale'), []);
  assert.equal(await countWithin('room', { x: 10, y: 10 }), 1);
  assert.deepEqual(await computeClusters('room'), [['fresh']]);
  await refreshLastSeen('heartbeat', 'room', 'day7');
  const events = [];
  const io = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, ...payload }) }) };
  await cleanupStale(io, { instanceId: 'day7' });
  assert.deepEqual(events.sort((a,b) => a.id.localeCompare(b.id)), [
    { room: 'room', event: 'user:left', id: 'stale' },
    { room: 'other', event: 'user:left', id: 'stale-other' },
  ]);
  assert.equal(await UserPresence.countDocuments(), 3);
  // Accepted movement refreshes lastSeen and the indexed position together.
  await upsertPosition({ id: 'fresh', roomId: 'room', instanceId: 'day7', name: 'fresh',
    color: '#fff', x: 20, y: 20, lastSeen: Date.now() }, geo);
  assert.equal((await UserPresence.findOne({ sessionId: 'fresh' })).x, 20);
  await cleanupOnBoot('day7', { multiInstance: false });
  assert.deepEqual((await UserPresence.find().lean()).map((u) => u.sessionId), []);
  const stop = startPresenceCleanup(io);
  await stop(); // Clears interval, including pending work, before DB shutdown.
});

mongoTest('$near explain uses the 2dsphere index, never COLLSCAN', async () => {
  const center = row('a', 100, 100);
  await UserPresence.insertMany([center, row('b', 101, 100)]);
  const explain = await UserPresence.find(nearQuery('room', center)).explain('executionStats');
  const plan = JSON.stringify(explain.queryPlanner.winningPlan);
  assert.match(plan, /GEO_NEAR_2DSPHERE/);
  assert.match(plan, /location_2dsphere/);
  assert.doesNotMatch(plan, /COLLSCAN/);
});

mongoTest('50-user query timing: p50/p95, generous 100ms bound', async (t) => {
  await UserPresence.insertMany(Array.from({ length: 50 }, (_, i) => row(`u${i}`, random() * 1920, random() * 1080)));
  await findNearby('room', 'u0'); await computeClusters('room');
  for (const [name, fn] of [['findNearby', () => findNearby('room', 'u0')],
    ['computeClusters', () => computeClusters('room')]]) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); await fn(); samples.push(performance.now() - start);
    }
    samples.sort((a,b) => a-b);
    const p50 = samples[9], p95 = samples[18];
    t.diagnostic(`${name}: 50 users, p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < 100, `${name} p95 ${p95}ms >= 100ms`);
  }
});
