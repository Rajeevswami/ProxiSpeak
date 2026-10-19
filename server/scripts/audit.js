#!/usr/bin/env node
/** CLI: npm run audit [-- --users=50 --samples=25 --seed=1]. Exit 1 on FAIL. */
import mongoose from 'mongoose';
import config from '../src/config/index.js';
import { connectMongo, disconnectMongo, ensureIndexes } from '../src/db/mongo.js';
import { runSpatialAudit } from '../src/services/spatialAudit.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v];
}));
let exitCode = 1;
try {
  await connectMongo();
  await ensureIndexes();
  const report = await runSpatialAudit({
    users: args.users === undefined ? undefined : Number(args.users),
    samples: args.samples === undefined ? undefined : Number(args.samples),
    seed: args.seed === undefined ? undefined : Number(args.seed),
  });
  console.log(`Spatial Audit — room ${report.roomId} (throwaway), db host ${report.dbHost}`);
  console.log(`users=${report.users} samples=${report.samples} warmup=${report.warmup} seed=${report.seed} radius=${report.radiusPx}px target p95 <= ${report.targetMs}ms`);
  console.log('operation              mismatches      p50ms      p95ms        maxms');
  for (const [name, op] of Object.entries(report.operations)) {
    console.log(`${name.padEnd(22)} ${String(op.mismatches).padStart(8)} ${op.p50.toFixed(3).padStart(10)} ${op.p95.toFixed(3).padStart(10)} ${op.max.toFixed(3).padStart(10)}`);
  }
  console.log(`index: $near 2dsphere=${report.index.near.uses2dsphere} COLLSCAN=${report.index.near.collscan}; $geoWithin 2dsphere=${report.index.geoWithin.uses2dsphere} COLLSCAN=${report.index.geoWithin.collscan}`);
  console.log(`cleanup verified (0 rows left): ${report.cleanupVerified}`);
  console.log(`RESULT: ${report.status}`);
  exitCode = report.ok ? 0 : 1;
} catch (err) {
  console.error(`Spatial Audit ERROR: ${err.message}`);
} finally {
  await disconnectMongo().catch(() => {});
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
}
process.exit(exitCode);
