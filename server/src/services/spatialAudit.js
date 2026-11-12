/**
 * Spatial Audit (Mid-Project Review, Day 10). Creates a SYNTHETIC dataset in a
 * dedicated throwaway room, compares findNearby ($near), countWithin
 * ($geoWithin), computeClusters (fast grid) and computeClustersViaNear against
 * an INDEPENDENT brute-force implementation (exact pixel distance), times each
 * operation with performance.now(), and ALWAYS cleans the room up in a finally
 * block. Timings are reported exactly as measured — never padded or rounded down.
 */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import config from '../config/index.js';
import UserPresence from '../models/UserPresence.js';
import { createGeoTransform, distancePx } from '../utils/geo.js';
import { findNearby, countWithin, computeClusters, computeClustersViaNear, nearQuery, geoWithinQuery } from './proximityService.js';

const geo = createGeoTransform(config.world);
export const AUDIT_CAPS = Object.freeze({ maxUsers: 500, maxSamples: 100, minUsers: 21 });

/** Deterministic PRNG (mulberry32) so a seed reproduces the same layout. */
export function seededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function validateAuditParams({ users = 50, samples = 25, seed = 1, warmup = 3 } = {}) {
  const parsed = { users: Number(users), samples: Number(samples), seed: Number(seed), warmup: Number(warmup) };
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isInteger(value)) throw new TypeError(`${key} must be an integer`);
  }
  if (parsed.users < AUDIT_CAPS.minUsers || parsed.users > AUDIT_CAPS.maxUsers) {
    throw new RangeError(`users must be within [${AUDIT_CAPS.minUsers}, ${AUDIT_CAPS.maxUsers}]`);
  }
  if (parsed.samples < 1 || parsed.samples > AUDIT_CAPS.maxSamples) {
    throw new RangeError(`samples must be within [1, ${AUDIT_CAPS.maxSamples}]`);
  }
  if (parsed.warmup < 0 || parsed.warmup > 20) throw new RangeError('warmup must be within [0, 20]');
  return parsed;
}

/** Host (with port) of a MongoDB URI, credentials never included. */
export function redactMongoHost(uri = config.mongo.uri) {
  try {
    const withoutScheme = String(uri).replace(/^mongodb(\+srv)?:\/\//, '');
    const hostPart = withoutScheme.split('@').pop().split('/')[0].split('?')[0];
    return hostPart || 'unknown';
  } catch { return 'unknown'; }
}

/** Planted edge cases + seeded random users. Ids are audit-prefixed. */
export function buildAuditUsers(users, seed) {
  const random = seededRandom(seed);
  const planted = [];
  const add = (id, x, y) => planted.push({ sessionId: id, x, y });
  add('audit-edge-center', 200, 200);
  for (const r of [99, 100, 101]) {
    add(`audit-edge-h${r}`, 200 + r, 200);
    add(`audit-edge-v${r}`, 200, 200 + r);
    add(`audit-edge-d${r}`, 200 + r * 0.6, 200 + r * 0.8);
  }
  add('audit-dup-a', 600, 600); add('audit-dup-b', 600, 600); // identical coordinates
  add('audit-chain-a', 800, 200); add('audit-chain-b', 890, 200); add('audit-chain-c', 980, 200); // A..C = 180px
  add('audit-isolated', 1800, 1000);
  add('audit-trio-a', 1000, 800); add('audit-trio-b', 1050, 800); add('audit-trio-c', 1100, 800);
  add('audit-pair-a', 1400, 300); add('audit-pair-b', 1450, 300);
  const rows = [...planted];
  for (let i = rows.length; i < users; i++) {
    rows.push({ sessionId: `audit-rand-${i}`, x: random() * config.world.width, y: random() * config.world.height });
  }
  return rows;
}

// ---- Independent brute force (exact pixel distance; shares no query code) ----
export const bruteNearby = (users, center, radiusPx) => users
  .filter((u) => u.sessionId !== center.sessionId)
  .map((u) => ({ id: u.sessionId, distancePx: distancePx(center.x, center.y, u.x, u.y) }))
  .filter((u) => u.distancePx <= radiusPx)
  .sort((a, b) => a.distancePx - b.distancePx || a.id.localeCompare(b.id));
const bruteCount = (users, center, radiusPx) =>
  users.filter((u) => distancePx(center.x, center.y, u.x, u.y) <= radiusPx).length;
export function bruteClusters(users, radiusPx) {
  const sorted = [...users].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const visited = new Set(); const clusters = [];
  for (const user of sorted) {
    if (visited.has(user.sessionId)) continue;
    const cluster = []; const queue = [user];
    visited.add(user.sessionId);
    for (let i = 0; i < queue.length; i++) {
      cluster.push(queue[i].sessionId);
      for (const other of sorted) {
        if (!visited.has(other.sessionId) && distancePx(queue[i].x, queue[i].y, other.x, other.y) <= radiusPx) {
          visited.add(other.sessionId); queue.push(other);
        }
      }
    }
    clusters.push(cluster.sort());
  }
  return clusters;
}

const normalizeClusters = (clusters) => clusters.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function summarize(samplesMs) {
  if (!samplesMs.length) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  // Nearest-rank percentile: ceil(q*n)-th smallest. (The previous
  // floor(q*(n-1)) index understated p95 — e.g. n=25 reported the 23rd of 25
  // values — which could flip the 20 ms PASS gate.)
  const at = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function explainUsesIndex(query) {
  const explain = await UserPresence.find(query).explain('executionStats');
  const plan = JSON.stringify(explain.queryPlanner?.winningPlan ?? explain);
  return { uses2dsphere: /2dsphere/.test(plan), collscan: /COLLSCAN/.test(plan), plan: plan.slice(0, 500) };
}

async function cleanupAuditRoom(roomId) {
  await UserPresence.deleteMany({ roomId });
  return UserPresence.countDocuments({ roomId });
}

/**
 * @param {object} [options] users/samples/seed/warmup (validated + capped),
 *   radiusPx, targetMs, and `deps` overrides used only by tests.
 */
export async function runSpatialAudit(options = {}) {
  const { users, samples, seed, warmup } = validateAuditParams(options);
  const radiusPx = options.radiusPx ?? config.proximity.radiusPx;
  const targetMs = options.targetMs ?? config.audit.targetMs;
  const deps = {
    findNearby, countWithin, computeClusters, computeClustersViaNear,
    bruteNearby, bruteCount, bruteClusters, ...(options.deps ?? {}),
  };
  const roomId = `audit-${randomUUID().slice(0, 8)}`;
  const dataset = buildAuditUsers(users, seed);
  const rows = dataset.map((u) => ({
    sessionId: u.sessionId, instanceId: 'spatial-audit', roomId, name: u.sessionId,
    color: '#fff', x: u.x, y: u.y, location: geo.point(u.x, u.y), lastSeen: new Date(),
  }));
  const mismatches = { findNearby: 0, countWithin: 0, computeClusters: 0, computeClustersViaNear: 0 };
  const timings = { findNearby: [], countWithin: [], computeClusters: [], computeClustersViaNear: [] };
  let indexPlans = null; let cleanupVerified = false; let thrown = null;

  const pick = seededRandom(seed + 999);
  const centers = Array.from({ length: samples }, () => dataset[Math.floor(pick() * dataset.length)]);
  const timed = async (name, fn, compare) => {
    const start = performance.now();
    const result = await fn();
    timings[name].push(performance.now() - start);
    if (!compare(result)) mismatches[name]++;
  };

  try {
    await UserPresence.insertMany(rows);
    const centerRow = await UserPresence.findOne({ roomId, sessionId: 'audit-edge-center' }).lean();
    indexPlans = {
      near: await explainUsesIndex(nearQuery(roomId, { ...centerRow, sessionId: 'audit-edge-center' }, radiusPx)),
      geoWithin: await explainUsesIndex(geoWithinQuery(roomId, { x: 200, y: 200 }, radiusPx)),
    };
    // Warm-up runs (excluded from timing, still compared).
    for (let i = 0; i < warmup; i++) {
      const c = centers[i % centers.length];
      if (!same(await deps.findNearby(roomId, c.sessionId, radiusPx), deps.bruteNearby(dataset, c, radiusPx))) mismatches.findNearby++;
      if ((await deps.countWithin(roomId, c, radiusPx)) !== deps.bruteCount(dataset, c, radiusPx)) mismatches.countWithin++;
      if (!same(normalizeClusters(await deps.computeClusters(roomId, radiusPx)), normalizeClusters(deps.bruteClusters(dataset, radiusPx)))) mismatches.computeClusters++;
      if (!same(normalizeClusters(await deps.computeClustersViaNear(roomId, radiusPx)), normalizeClusters(deps.bruteClusters(dataset, radiusPx)))) mismatches.computeClustersViaNear++;
    }
    for (const center of centers) {
      await timed('findNearby', () => deps.findNearby(roomId, center.sessionId, radiusPx),
        (r) => same(r, deps.bruteNearby(dataset, center, radiusPx)));
      await timed('countWithin', () => deps.countWithin(roomId, center, radiusPx),
        (r) => r === deps.bruteCount(dataset, center, radiusPx));
    }
    const expectedClusters = normalizeClusters(deps.bruteClusters(dataset, radiusPx));
    for (let i = 0; i < samples; i++) {
      await timed('computeClusters', () => deps.computeClusters(roomId, radiusPx),
        (r) => same(normalizeClusters(r), expectedClusters));
      await timed('computeClustersViaNear', () => deps.computeClustersViaNear(roomId, radiusPx),
        (r) => same(normalizeClusters(r), expectedClusters));
    }
  } catch (err) {
    thrown = err;
  } finally {
    // ALWAYS clean the throwaway room, also on error; verify nothing remains.
    const remaining = await cleanupAuditRoom(roomId).catch(() => -1);
    cleanupVerified = remaining === 0;
  }
  if (thrown) throw thrown;

  const operations = {};
  for (const name of Object.keys(timings)) {
    operations[name] = { mismatches: mismatches[name], ...summarize(timings[name]) };
  }
  const totalMismatches = Object.values(mismatches).reduce((a, b) => a + b, 0);
  // `computeClustersViaNear` is the deprecated N-query Day 7 baseline kept strictly
  // as an accuracy cross-check (its real timing stays reported alongside `computeClusters`,
  // while the <= 20ms production SLA applies to the live hot/room operations).
  const budgetedOps = ['findNearby', 'countWithin', 'computeClusters'];
  const pass = totalMismatches === 0 && cleanupVerified
    && budgetedOps.every((name) => operations[name].p95 <= targetMs);
  return {
    ok: pass, status: pass ? 'PASS' : 'FAIL',
    roomId, users, samples, warmup, seed, radiusPx,
    targetMs, mismatches, totalMismatches, operations,
    index: indexPlans, dbHost: redactMongoHost(), cleanupVerified,
  };
}

export default runSpatialAudit;
