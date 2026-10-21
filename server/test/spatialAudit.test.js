import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import config from '../src/config/index.js';
import UserPresence from '../src/models/UserPresence.js';
import { createLogger } from '../src/utils/logger.js';
import { createApp } from '../src/app.js';
import { createGeoTransform } from '../src/utils/geo.js';
import { computeClusters, computeClustersViaNear } from '../src/services/proximityService.js';
import {
  AUDIT_CAPS, buildAuditUsers, bruteClusters, bruteNearby, redactMongoHost,
  runSpatialAudit, seededRandom, summarize, validateAuditParams,
} from '../src/services/spatialAudit.js';

const geo = createGeoTransform(config.world);
const log = createLogger('error');

// ---------- unit: no MongoDB needed ----------
test('parameter validation and caps', () => {
  assert.deepEqual(validateAuditParams({}), { users: 50, samples: 25, seed: 1, warmup: 3 });
  assert.throws(() => validateAuditParams({ users: AUDIT_CAPS.maxUsers + 1 }), /users/);
  assert.throws(() => validateAuditParams({ users: 5 }), /users/);
  assert.throws(() => validateAuditParams({ samples: AUDIT_CAPS.maxSamples + 1 }), /samples/);
  assert.throws(() => validateAuditParams({ samples: 0 }), /samples/);
  assert.throws(() => validateAuditParams({ users: 50.5 }), /integer/);
});

test('redaction of the DB host never exposes credentials', () => {
  assert.equal(redactMongoHost('mongodb://alice:s3cret@db.example.com:27017/proxispeak'), 'db.example.com:27017');
  assert.equal(redactMongoHost('mongodb+srv://alice:s3cret@cluster.example.mongodb.net/proxispeak'), 'cluster.example.mongodb.net');
  assert.equal(redactMongoHost('mongodb://127.0.0.1:27017/proxispeak'), '127.0.0.1:27017');
  assert.ok(!redactMongoHost('mongodb://alice:s3cret@h:1/db').includes('s3cret'));
});

test('seeded dataset is reproducible and plants the edge cases', () => {
  const a = buildAuditUsers(50, 7); const b = buildAuditUsers(50, 7);
  assert.deepEqual(a, b);
  assert.notDeepEqual(buildAuditUsers(50, 8).slice(21), a.slice(21));
  const byId = new Map(a.map((u) => [u.sessionId, u]));
  const center = byId.get('audit-edge-center');
  const dist = (id) => Math.hypot(byId.get(id).x - center.x, byId.get(id).y - center.y);
  assert.ok(Math.abs(dist('audit-edge-h99') - 99) < 1e-9);
  assert.ok(Math.abs(dist('audit-edge-v100') - 100) < 1e-9);
  assert.ok(Math.abs(dist('audit-edge-d101') - 101) < 1e-6);
  assert.equal(byId.get('audit-dup-a').x, byId.get('audit-dup-b').x);
  const clusters = bruteClusters(a, 100).map((c) => c.join(','));
  assert.ok(clusters.some((c) => c.includes('audit-chain-a') && c.includes('audit-chain-c')), 'chain is one cluster');
  assert.ok(clusters.some((c) => c === 'audit-isolated'), 'isolated singleton');
  // 100px included, 101px excluded by brute force around the planted centre.
  const nearIds = bruteNearby(a, center, 100).map((u) => u.id);
  assert.ok(nearIds.includes('audit-edge-h100')); assert.ok(!nearIds.includes('audit-edge-h101'));
});

test('summarize reports measured percentiles without rounding down', () => {
  assert.deepEqual(summarize([10, 20, 30]), { p50: 20, p95: 30, max: 30 });
  assert.equal(summarize(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
  // Nearest-rank: with 25 samples p95 is the 24th smallest, never lower.
  assert.equal(summarize(Array.from({ length: 25 }, (_, i) => i + 1)).p95, 24);
});

// ---------- route: injected runner, no MongoDB needed ----------
async function startApp(cfgOverrides, auditRunner) {
  const cfg = { ...config, ...cfgOverrides };
  const app = createApp({ config: cfg, logger: log, auditRunner });
  const server = http.createServer(); server.on('request', app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('route: caps -> 400, roomId rejected, concurrent run -> 429', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const { base, close } = await startApp({ audit: { enabled: true, targetMs: 20 } },
    async () => { await gate; return { ok: true, status: 'PASS', operations: {} }; });
  t.after(close);
  assert.equal((await fetch(`${base}/api/spatial-audit?users=9999`)).status, 400);
  assert.equal((await fetch(`${base}/api/spatial-audit?roomId=lobby`)).status, 400);
  const first = fetch(`${base}/api/spatial-audit?users=50&samples=25&seed=1`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(`${base}/api/spatial-audit`)).status, 429);
  release();
  const done = await first; assert.equal(done.status, 200);
  assert.equal((await done.json()).ok, true);
});

test('route disabled in production mode -> 404', async (t) => {
  const { base, close } = await startApp({ audit: { enabled: false, targetMs: 20 } }, async () => ({}));
  t.after(close);
  assert.equal((await fetch(`${base}/api/spatial-audit`)).status, 404);
});

// ---------- real MongoDB (skipped only when unavailable) ----------
let ready = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI_TEST ?? config.mongo.uri, {
      dbName: `proxispeak_day10_test_${process.pid}_${Date.now()}`, serverSelectionTimeoutMS: 1500,
    });
    await UserPresence.createIndexes(); ready = true;
  } catch { process.stderr.write('Day 10: NOT VERIFIED — MongoDB unavailable; set MONGO_URI_TEST and rerun.\n'); }
});
after(async () => { if (ready) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
const mongoTest = (name, fn) => test(name, async (t) => { if (!ready) return t.skip('NOT VERIFIED — requires real MongoDB'); await fn(t); });

mongoTest('audit: 0 mismatches on planted + random data, cleanup leaves zero rows', async () => {
  const report = await runSpatialAudit({ users: 50, samples: 25, seed: 1 });
  assert.equal(report.ok, true, JSON.stringify(report.operations));
  assert.equal(report.status, 'PASS');
  assert.equal(report.totalMismatches, 0, JSON.stringify(report.mismatches));
  assert.equal(report.cleanupVerified, true);
  assert.equal(await UserPresence.countDocuments({ roomId: report.roomId }), 0);
  assert.equal(report.index.near.uses2dsphere, true); assert.equal(report.index.near.collscan, false);
  assert.equal(report.index.geoWithin.collscan, false);
  assert.ok(!report.dbHost.includes('@') && !report.dbHost.includes('mongodb'));

  const overBudget = await runSpatialAudit({ users: 30, samples: 5, seed: 2, targetMs: 0.001 });
  assert.equal(overBudget.ok, false, 'exceeding p95 target fails audit');
  assert.equal(overBudget.status, 'FAIL');
});

mongoTest('cleanup leaves zero rows even when a comparison throws', async () => {
  await assert.rejects(runSpatialAudit({
    users: 30, samples: 5, seed: 3,
    deps: { bruteNearby: () => { throw new Error('forced comparison failure'); } },
  }), /forced comparison failure/);
  assert.equal(await UserPresence.countDocuments({ roomId: /^audit-/ }), 0);
});

mongoTest('fast clustering equals computeClustersViaNear on 20 random layouts', async () => {
  const random = seededRandom(42);
  for (let layout = 0; layout < 20; layout++) {
    await UserPresence.deleteMany({});
    const rows = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `u${i}`, instanceId: 'day10', roomId: 'room', name: `u${i}`, color: '#fff',
      x: random() * 1920, y: random() * 1080, lastSeen: new Date(),
    }));
    rows.forEach((r) => { r.location = geo.point(r.x, r.y); });
    await UserPresence.insertMany(rows);
    const norm = (cs) => cs.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(norm(await computeClusters('room')), norm(await computeClustersViaNear('room')), `layout ${layout}`);
  }
});
