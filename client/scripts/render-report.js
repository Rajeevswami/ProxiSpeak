#!/usr/bin/env node
/**
 * Week 3 (Day 18) Canvas rendering report:
 *  1. Before/after 2D context operation-count table ({0, 10, 100, 200} obstacles x {1, 10, 60} avatars)
 *  2. MAX_BACKING_PIXELS effective DPR check (3840x2160@3, 390x844@3, 1440x900@2)
 *  3. Per-frame JavaScript work benchmark (60 avatars, 200 obstacles, fake 2D context — JS cost only, not GPU/compositing)
 *  4. Heap & allocation checks under --expose-gc (100,000 frameStats.record calls + 50,000 drawFrame calls)
 *
 * Usage:
 *   node --expose-gc client/scripts/render-report.js
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { SEEDED_LOBBY_OBSTACLES } from './occlusion-bench.js';

export { SEEDED_LOBBY_OBSTACLES };
import { computeViewport, updateCanvasSize } from '../src/canvas/coords.js';
import {
  OBSTACLE_COLORS,
  avatarColor,
  avatarLabel,
  createLabelCache,
  drawFrame,
  truncateLabel,
} from '../src/canvas/renderer.js';
import { createStaticLayer, resolveBackingMetrics } from '../src/canvas/staticLayer.js';
import { createFrameStats, nearestRank } from '../src/perf/frameStats.js';

export const CANVAS_2D_METHODS = Object.freeze([
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'moveTo',
  'lineTo',
  'stroke',
  'arc',
  'fill',
  'fillText',
  'strokeText',
  'drawImage',
]);

export function makePrng(seed = 20261029) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Exact pre-Day-18 static room painter for before/after equivalence & timing. */
export function legacyDrawRoom(ctx, world, size) {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, width, height);

  const room = world?.room;
  if (!room) return null;

  const viewport = computeViewport(room.width, room.height, width, height);
  const { offsetX, offsetY, scale } = viewport;

  ctx.fillStyle = '#151c2e';
  ctx.fillRect(offsetX, offsetY, viewport.drawnWidth, viewport.drawnHeight);

  ctx.strokeStyle = 'rgba(163, 179, 214, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 120; x < room.width; x += 120) {
    const screenX = offsetX + x * scale;
    ctx.moveTo(screenX, offsetY);
    ctx.lineTo(screenX, offsetY + viewport.drawnHeight);
  }
  for (let y = 120; y < room.height; y += 120) {
    const screenY = offsetY + y * scale;
    ctx.moveTo(offsetX, screenY);
    ctx.lineTo(offsetX + viewport.drawnWidth, screenY);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(229, 233, 240, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX, offsetY, viewport.drawnWidth, viewport.drawnHeight);

  for (const obstacle of room.obstacles ?? []) {
    const left = offsetX + obstacle.x * scale;
    const top = offsetY + obstacle.y * scale;
    const w = obstacle.w * scale;
    const h = obstacle.h * scale;
    ctx.fillStyle = OBSTACLE_COLORS[obstacle.type] ?? '#6b7280';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(left, top, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(5, 7, 13, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, w, h);

    if (scale > 0.25) {
      ctx.fillStyle = 'rgba(229, 233, 240, 0.75)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(obstacle.type ?? ''), left + 3, top - 2);
    }
  }

  return viewport;
}

const legacyScratchCentre = { x: 0, y: 0 };

/** Exact pre-Day-18 avatar painter for before/after equivalence & timing. */
export function legacyDrawAvatars(ctx, world, viewport) {
  if (!world || !viewport) return;
  const radius = Math.max(7, 18 * viewport.scale);

  for (const user of world.users.values()) {
    if (!Number.isFinite(user?.x) || !Number.isFinite(user?.y)) continue;
    const centre = legacyScratchCentre;
    centre.x = viewport.offsetX + user.x * viewport.scale;
    centre.y = viewport.offsetY + user.y * viewport.scale;
    const isSelf = user.id === world.selfId;
    const label = avatarLabel(user, world.selfId);

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isSelf ? '#ffd166' : avatarColor(user);
    ctx.fill();

    ctx.lineWidth = isSelf ? 3 : 1.5;
    ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(5, 7, 13, 0.65)';
    ctx.stroke();

    if (isSelf) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = isSelf ? '#1a1405' : '#0b1020';
    ctx.font = `700 ${Math.max(10, radius)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 1).toUpperCase(), centre.x, centre.y + 0.5);

    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const text = truncateLabel(isSelf ? `${label} (you)` : label);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5, 7, 13, 0.8)';
    ctx.strokeText(text, centre.x, centre.y - radius - 6);
    ctx.fillStyle = '#e5e9f0';
    ctx.fillText(text, centre.x, centre.y - radius - 6);
  }
}

export function legacyDrawWorld(ctx, world, size) {
  const vp = legacyDrawRoom(ctx, world, size);
  if (vp) legacyDrawAvatars(ctx, world, vp);
  return vp;
}

export function makeObstacles(count) {
  if (count === 0) return [];
  if (count === 10) return SEEDED_LOBBY_OBSTACLES.map((o) => ({ ...o }));
  const rand = makePrng(20261029 + count);
  const types = ['wall', 'desk', 'screen', 'pillar', 'plant'];
  return Array.from({ length: count }, (_, i) => ({
    id: `obs-${i}`,
    type: types[i % types.length],
    x: Math.floor(rand() * 1800),
    y: Math.floor(rand() * 980),
    w: 20 + Math.floor(rand() * 80),
    h: 20 + Math.floor(rand() * 80),
    blocksAudio: true,
    attenuation: 0.5,
  }));
}

export function makeUsers(count) {
  const rand = makePrng(1000 + count);
  const users = new Map();
  for (let i = 0; i < count; i += 1) {
    const id = `user-${i}`;
    users.set(id, {
      id,
      name: i % 3 === 0 ? `VeryLongParticipantName_${i}` : `User_${i}`,
      x: 50 + rand() * 1820,
      y: 50 + rand() * 980,
      tx: 50 + rand() * 1820,
      ty: 50 + rand() * 980,
    });
  }
  return users;
}

class CountingContext {
  constructor() {
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 1.5; // double representation so 1.5 <-> 3 never boxes in the fake
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1.0;
    this.total = 0;
    this.drawImages = 0;
  }

  setTransform() {}
  clearRect() { this.total += 1; }
  fillRect() { this.total += 1; }
  strokeRect() { this.total += 1; }
  beginPath() { this.total += 1; }
  moveTo() { this.total += 1; }
  lineTo() { this.total += 1; }
  stroke() { this.total += 1; }
  arc() { this.total += 1; }
  fill() { this.total += 1; }
  fillText() { this.total += 1; }
  strokeText() { this.total += 1; }
  drawImage() {
    this.total += 1;
    this.drawImages += 1;
  }

  resetCounts() {
    this.total = 0;
    this.drawImages = 0;
  }
}

/** Allocation-free counting 2D context fake for operation tables & benchmarks. */
export function createCountingContext() {
  return new CountingContext();
}

export function createFakeCanvasFactory() {
  return () => ({
    width: 0,
    height: 0,
    getContext: () => createCountingContext(),
  });
}

export function computeOperationCountTable() {
  const obstacleCounts = [0, 10, 100, 200];
  const avatarCounts = [1, 10, 60];
  const rows = [];

  for (const obstacles of obstacleCounts) {
    const before = {};
    const after = {};
    for (const avatars of avatarCounts) {
      const world = {
        room: {
          roomId: 'lobby',
          name: 'Lobby',
          width: 1920,
          height: 1080,
          layoutRevision: 1,
          obstacles: makeObstacles(obstacles),
        },
        users: makeUsers(avatars),
        selfId: 'user-0',
        epoch: 1,
      };
      const view = updateCanvasSize(
        {
          width: 0, height: 0, dpr: 1, backingWidth: 1, backingHeight: 1,
          scale: 1, offsetX: 0, offsetY: 0, drawnWidth: 0, drawnHeight: 0,
          roomWidth: 0, roomHeight: 0, canvasWidth: 0, canvasHeight: 0,
        },
        1440,
        900,
        2,
      );

      const beforeCtx = createCountingContext();
      legacyDrawWorld(beforeCtx, world, view);
      before[avatars] = beforeCtx.total;

      const afterCtx = createCountingContext();
      const staticLayer = createStaticLayer({ createCanvas: createFakeCanvasFactory() });
      const labelCache = createLabelCache();
      // Frame 1 builds static layer; Frame 2+ is the steady per-frame path ( static already cached ).
      drawFrame(afterCtx, staticLayer, view, world, labelCache);
      afterCtx.resetCounts();
      drawFrame(afterCtx, staticLayer, view, world, labelCache);
      after[avatars] = afterCtx.total;
      staticLayer.destroy();
    }
    rows.push({ obstacles, before, after });
  }
  return rows;
}

function summarizeMs(samplesMs) {
  const sorted = Float64Array.from(samplesMs).sort();
  const p50 = nearestRank(sorted, 0.5);
  const p95 = nearestRank(sorted, 0.95);
  const max = sorted[sorted.length - 1] ?? 0;
  return {
    samples: sorted.length,
    p50Us: Number((p50 * 1000).toFixed(2)),
    p95Us: Number((p95 * 1000).toFixed(2)),
    maxUs: Number((max * 1000).toFixed(2)),
    p50Ms: Number(p50.toFixed(4)),
    p95Ms: Number(p95.toFixed(4)),
    maxMs: Number(max.toFixed(4)),
  };
}

export function runRenderBenchmark({ avatars = 60, obstacles = 200, warmup = 1000, samples = 5000 } = {}) {
  const world = {
    room: {
      roomId: 'lobby',
      name: 'Lobby',
      width: 1920,
      height: 1080,
      layoutRevision: 1,
      obstacles: makeObstacles(obstacles),
    },
    users: makeUsers(avatars),
    selfId: 'user-0',
    epoch: 1,
  };
  const view = updateCanvasSize(
    {
      width: 0, height: 0, dpr: 1, backingWidth: 1, backingHeight: 1,
      scale: 1, offsetX: 0, offsetY: 0, drawnWidth: 0, drawnHeight: 0,
      roomWidth: 0, roomHeight: 0, canvasWidth: 0, canvasHeight: 0,
    },
    1440,
    900,
    2,
  );

  const beforeCtx = createCountingContext();
  const afterCtx = createCountingContext();
  const staticLayer = createStaticLayer({ createCanvas: createFakeCanvasFactory() });
  const labelCache = createLabelCache();

  for (let i = 0; i < warmup; i += 1) {
    legacyDrawWorld(beforeCtx, world, view);
    drawFrame(afterCtx, staticLayer, view, world, labelCache);
  }

  const beforeTimings = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    legacyDrawWorld(beforeCtx, world, view);
    beforeTimings[i] = performance.now() - t0;
  }

  const afterTimings = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    drawFrame(afterCtx, staticLayer, view, world, labelCache);
    afterTimings[i] = performance.now() - t0;
  }

  const staticLayerBuilds = staticLayer.getBuildCount();
  staticLayer.destroy();

  return {
    avatars,
    obstacles,
    staticLayerBuilds,
    before: summarizeMs(beforeTimings),
    after: summarizeMs(afterTimings),
  };
}

function sumSampledProfile(node) {
  let bytes = node?.selfSize ?? 0;
  const children = node?.children ?? [];
  for (let i = 0; i < children.length; i += 1) {
    bytes += sumSampledProfile(children[i]);
  }
  return bytes;
}

function withHeapSampling(fn) {
  const session = new inspector.Session();
  session.connect();
  session.post('HeapProfiler.enable');
  session.post('HeapProfiler.startSampling', { samplingInterval: 32 });
  fn();
  let sampledBytes = 0;
  session.post('HeapProfiler.stopSampling', (err, result) => {
    if (!err && result?.profile?.head) {
      sampledBytes = sumSampledProfile(result.profile.head);
    }
  });
  session.disconnect();
  return sampledBytes;
}

export function runHeapChecks({ recordCount = 100000, frameCount = 50000 } = {}) {
  if (typeof globalThis.gc !== 'function') {
    return { measured: false, reason: 'run with node --expose-gc' };
  }

  // 1. frameStats.record over 100,000 records
  const stats = createFrameStats();
  for (let i = 0; i < 5000; i += 1) stats.record(16.67, 0.42);
  globalThis.gc();
  globalThis.gc();
  const recBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < recordCount; i += 1) stats.record(16.67, 0.42);
  const recPreGc = process.memoryUsage().heapUsed;
  globalThis.gc();
  globalThis.gc();
  const recAfter = process.memoryUsage().heapUsed;
  const recSampledBytes = withHeapSampling(() => {
    for (let i = 0; i < recordCount; i += 1) stats.record(16.67, 0.42);
  });

  // 2. New per-frame path (drawFrame, 60 avatars, 200 obstacles) over 50,000 frames
  const world = {
    room: {
      roomId: 'lobby',
      name: 'Lobby',
      width: 1920,
      height: 1080,
      layoutRevision: 1,
      obstacles: makeObstacles(200),
    },
    users: makeUsers(60),
    selfId: 'user-0',
    epoch: 1,
  };
  const view = updateCanvasSize(
    {
      width: 0, height: 0, dpr: 1, backingWidth: 1, backingHeight: 1,
      scale: 1, offsetX: 0, offsetY: 0, drawnWidth: 0, drawnHeight: 0,
      roomWidth: 0, roomHeight: 0, canvasWidth: 0, canvasHeight: 0,
    },
    1440,
    900,
    2,
  );
  const ctx = createCountingContext();
  const staticLayer = createStaticLayer({ createCanvas: createFakeCanvasFactory() });
  const labelCache = createLabelCache();

  for (let i = 0; i < 6000; i += 1) {
    drawFrame(ctx, staticLayer, view, world, labelCache);
  }

  // Young-gen 50-frame burst comparison (no minor GC inside 50 small frames)
  const legacyCtx = createCountingContext();
  for (let i = 0; i < 6000; i += 1) {
    legacyDrawWorld(legacyCtx, world, view);
  }
  globalThis.gc();
  globalThis.gc();
  const memOverhead0 = process.memoryUsage().heapUsed;
  const memOverhead1 = process.memoryUsage().heapUsed;
  const memCallOverhead = Math.max(0, memOverhead1 - memOverhead0);

  globalThis.gc();
  globalThis.gc();
  const oldBurst0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50; i += 1) legacyDrawWorld(legacyCtx, world, view);
  const oldBurst1 = process.memoryUsage().heapUsed;

  globalThis.gc();
  globalThis.gc();
  const newBurst0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50; i += 1) drawFrame(ctx, staticLayer, view, world, labelCache);
  const newBurst1 = process.memoryUsage().heapUsed;

  // Full 50,000-frame retained heap check
  globalThis.gc();
  globalThis.gc();
  const framesBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < frameCount; i += 1) {
    drawFrame(ctx, staticLayer, view, world, labelCache);
  }
  globalThis.gc();
  globalThis.gc();
  const framesAfter = process.memoryUsage().heapUsed;

  const framesSampledBytes = withHeapSampling(() => {
    for (let i = 0; i < frameCount; i += 1) {
      drawFrame(ctx, staticLayer, view, world, labelCache);
    }
  });

  staticLayer.destroy();

  return {
    measured: true,
    frameStatsRecord: {
      records: recordCount,
      preGcDeltaBytes: recPreGc - recBefore,
      retainedDeltaBytes: recAfter - recBefore,
      sampledAllocBytes: recSampledBytes,
    },
    perFramePath: {
      frames: frameCount,
      retainedBeforeBytes: framesBefore,
      retainedAfterBytes: framesAfter,
      retainedDeltaBytes: framesAfter - framesBefore,
      retainedDeltaPerFrame: Number(((framesAfter - framesBefore) / frameCount).toFixed(4)),
      sampledAllocBytes: framesSampledBytes,
      burst50LegacyBytes: Math.max(0, oldBurst1 - oldBurst0 - memCallOverhead),
      burst50LegacyPerFrame: Number((Math.max(0, oldBurst1 - oldBurst0 - memCallOverhead) / 50).toFixed(2)),
      burst50NewBytes: Math.max(0, newBurst1 - newBurst0 - memCallOverhead),
      burst50NewPerFrame: Number((Math.max(0, newBurst1 - newBurst0 - memCallOverhead) / 50).toFixed(2)),
    },
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`=== Week 3 (Day 18) Canvas Render Report (${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'unknown CPU'}) ===`);
  out('');
  out('--- 1. Per-Frame 2D Context Operation Counts (1440x900 CSS px, 1920x1080 room) ---');
  out('obstacles | before (1 / 10 / 60 avatars) | after (1 / 10 / 60 avatars)');
  for (const row of computeOperationCountTable()) {
    out(
      `${String(row.obstacles).padStart(9)} | ${String(row.before[1]).padStart(6)} / ${String(row.before[10]).padStart(6)} / ${String(row.before[60]).padStart(6)}   | ${String(row.after[1]).padStart(5)} / ${String(row.after[10]).padStart(5)} / ${String(row.after[60]).padStart(5)}`,
    );
  }
  out('');
  out('--- 2. MAX_BACKING_PIXELS (16,000,000) Effective DPR Check ---');
  for (const [label, w, h, dpr] of [
    ['4K monitor 3840x2160 @ DPR 3', 3840, 2160, 3],
    ['Phone 390x844 @ DPR 3', 390, 844, 3],
    ['Laptop 1440x900 @ DPR 2', 1440, 900, 2],
  ]) {
    const m = resolveBackingMetrics(w, h, dpr);
    out(`${label.padEnd(30)} -> effectiveDpr=${m.dpr.toFixed(6)} backing=${m.backingWidth}x${m.backingHeight} (${m.backingWidth * m.backingHeight} px)`);
  }
  out('');
  out('--- 3. Benchmark: 60 Avatars x 200 Obstacles (fake 2D context; JavaScript cost ONLY, not GPU/compositing) ---');
  const bench = runRenderBenchmark();
  out(`Before (legacyDrawWorld, ${bench.before.samples} frames): p50=${bench.before.p50Us} us (${bench.before.p50Ms} ms), p95=${bench.before.p95Us} us (${bench.before.p95Ms} ms), max=${bench.before.maxUs} us (${bench.before.maxMs} ms)`);
  out(`After  (drawFrame cached, ${bench.after.samples} frames): p50=${bench.after.p50Us} us (${bench.after.p50Ms} ms), p95=${bench.after.p95Us} us (${bench.after.p95Ms} ms), max=${bench.after.maxUs} us (${bench.after.maxMs} ms) [static builds=${bench.staticLayerBuilds}]`);
  out('');
  out('--- 4. Heap & Allocation Checks (--expose-gc + V8 HeapProfiler sampling at 32 B interval) ---');
  const heap = runHeapChecks();
  if (!heap.measured) {
    out(`NOT MEASURED: ${heap.reason}`);
  } else {
    out(`frameStats.record (${heap.frameStatsRecord.records} calls): preGcDelta=${heap.frameStatsRecord.preGcDeltaBytes} B, retainedDelta=${heap.frameStatsRecord.retainedDeltaBytes} B, sampledAlloc=${heap.frameStatsRecord.sampledAllocBytes} B`);
    out(`drawFrame (${heap.perFramePath.frames} frames, 60 avatars, 200 obstacles): retainedBefore=${heap.perFramePath.retainedBeforeBytes} B, retainedAfter=${heap.perFramePath.retainedAfterBytes} B, retainedDelta=${heap.perFramePath.retainedDeltaBytes} B (${heap.perFramePath.retainedDeltaPerFrame} B/frame), sampledAlloc=${heap.perFramePath.sampledAllocBytes} B`);
    out(`50-frame pre-scavenge young-gen burst: before=${heap.perFramePath.burst50LegacyBytes} B (${heap.perFramePath.burst50LegacyPerFrame} B/frame) -> after=${heap.perFramePath.burst50NewBytes} B (${heap.perFramePath.burst50NewPerFrame} B/frame)`);
  }
}
