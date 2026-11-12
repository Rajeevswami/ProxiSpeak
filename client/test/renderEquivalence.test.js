import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { computeViewport, updateCanvasSize, updateViewport } from '../src/canvas/coords.js';
import {
  createLabelCache,
  drawDynamic,
  drawFrame,
  drawStatic,
} from '../src/canvas/renderer.js';
import { createStaticLayer } from '../src/canvas/staticLayer.js';
import {
  SEEDED_LOBBY_OBSTACLES,
  computeOperationCountTable,
  createFakeCanvasFactory,
  legacyDrawAvatars,
  legacyDrawRoom,
  makeObstacles,
  makeUsers,
  runRenderBenchmark,
} from '../scripts/render-report.js';

function createRecordingContext() {
  const ops = [];
  const state = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  };

  function pushOp(method, args) {
    ops.push({
      method,
      args,
      fillStyle: state.fillStyle,
      strokeStyle: state.strokeStyle,
      lineWidth: state.lineWidth,
      font: state.font,
      textAlign: state.textAlign,
      textBaseline: state.textBaseline,
      globalAlpha: state.globalAlpha,
    });
  }

  return {
    ops,
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    get font() { return state.font; },
    set font(v) { state.font = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v) { state.textBaseline = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    setTransform(...args) { pushOp('setTransform', args); },
    clearRect(...args) { pushOp('clearRect', args); },
    fillRect(...args) { pushOp('fillRect', args); },
    strokeRect(...args) { pushOp('strokeRect', args); },
    beginPath(...args) { pushOp('beginPath', args); },
    moveTo(...args) { pushOp('moveTo', args); },
    lineTo(...args) { pushOp('lineTo', args); },
    stroke(...args) { pushOp('stroke', args); },
    arc(...args) { pushOp('arc', args); },
    fill(...args) { pushOp('fill', args); },
    fillText(...args) { pushOp('fillText', args); },
    strokeText(...args) { pushOp('strokeText', args); },
    drawImage(...args) {
      // Replace the offscreen canvas identity with a tag so ops compare structurally.
      const normalized = args.slice();
      if (normalized[0] && typeof normalized[0] === 'object') {
        normalized[0] = '<offscreen-static-canvas>';
      }
      pushOp('drawImage', normalized);
    },
    measureText(text) {
      pushOp('measureText', [text]);
      return { width: String(text).length * 7 };
    },
  };
}

function makeRoom(obstacles) {
  return {
    roomId: 'lobby',
    name: 'Main Lobby',
    width: 1920,
    height: 1080,
    layoutRevision: 1,
    obstacles,
  };
}

test('drawStatic emits the exact same 2D operation list as legacyDrawRoom on seeded lobby and 200 obstacles', () => {
  const sizes = [
    { width: 1440, height: 900 },
    { width: 800, height: 600 },
    { width: 320, height: 180 }, // scale <= 0.25 branch (obstacle type labels omitted)
  ];
  const rooms = [
    makeRoom(SEEDED_LOBBY_OBSTACLES),
    makeRoom(makeObstacles(200, 0x18da7a)),
    null,
  ];

  for (const size of sizes) {
    for (const room of rooms) {
      const legacyCtx = createRecordingContext();
      const modernCtx = createRecordingContext();

      legacyDrawRoom(legacyCtx, { room }, size);
      drawStatic(modernCtx, size, room);

      assert.deepEqual(
        modernCtx.ops,
        legacyCtx.ops,
        `static draw mismatch at ${size.width}x${size.height} (${room?.obstacles?.length ?? 'null'} obstacles)`,
      );
    }
  }
});

test('drawDynamic emits the exact same 2D operation list as legacyDrawAvatars for 1, 10, and 60 avatars', () => {
  const room = makeRoom(SEEDED_LOBBY_OBSTACLES);
  const size = { width: 1440, height: 900 };
  const viewport = computeViewport(room.width, room.height, size.width, size.height);

  for (const avatarCount of [1, 10, 60]) {
    const users = makeUsers(avatarCount);
    // Include edge cases: unnamed fallback user, extra-long truncated name, non-finite coords.
    if (avatarCount >= 10) {
      users.set('unnamed-9999', { id: 'unnamed-9999', name: null, x: 500, y: 300 });
      users.set('long-name-id', {
        id: 'long-name-id',
        name: 'Maximilian Bartholomew III',
        x: 720,
        y: 440,
      });
      users.set('ghost-nan', { id: 'ghost-nan', name: 'Ghost', x: Number.NaN, y: 200 });
    }
    const world = { room, users, selfId: 'user-0' };

    const legacyCtx = createRecordingContext();
    const modernCtx = createRecordingContext();

    legacyDrawAvatars(legacyCtx, world, viewport);
    drawDynamic(modernCtx, viewport, world, createLabelCache());

    assert.deepEqual(
      modernCtx.ops,
      legacyCtx.ops,
      `dynamic avatar draw mismatch for ${avatarCount} avatars`,
    );
  }
});

test('cached drawFrame emits ONE drawImage plus dynamic ops and keeps op count constant across 0..200 obstacles', () => {
  const room = makeRoom(makeObstacles(200));
  const users = makeUsers(10);
  const world = { room, users, selfId: 'user-0' };
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
  updateViewport(view, room.width, room.height, view.width, view.height);

  const staticLayer = createStaticLayer({ createCanvas: createFakeCanvasFactory() });
  const labelCache = createLabelCache();

  // Warm frame 1 builds the static layer; frame 2 must blit with 1 drawImage + exact dynamic ops.
  drawFrame(createRecordingContext(), staticLayer, view, world, labelCache);
  assert.equal(staticLayer.getBuildCount(), 1);

  const frameCtx = createRecordingContext();
  drawFrame(frameCtx, staticLayer, view, world, labelCache);
  assert.equal(staticLayer.getBuildCount(), 1);

  const dynamicOnlyCtx = createRecordingContext();
  drawDynamic(dynamicOnlyCtx, view, world, createLabelCache());

  assert.equal(frameCtx.ops[0].method, 'drawImage');
  assert.deepEqual(frameCtx.ops[0].args, ['<offscreen-static-canvas>', 0, 0, 1440, 900]);
  assert.deepEqual(frameCtx.ops.slice(1), dynamicOnlyCtx.ops);

  // Verify the full {0, 10, 100, 200} x {1, 10, 60} operation-count table.
  const rows = computeOperationCountTable();
  assert.deepEqual(rows.map((r) => r.obstacles), [0, 10, 100, 200]);
  assert.deepEqual(rows.map((r) => r.before), [
    { 1: 62, 10: 125, 60: 475 },
    { 1: 92, 10: 155, 60: 505 },
    { 1: 362, 10: 425, 60: 775 },
    { 1: 662, 10: 725, 60: 1075 },
  ]);
  for (const row of rows) {
    assert.deepEqual(
      row.after,
      { 1: 11, 10: 74, 60: 424 },
      `cached per-frame op count must not depend on obstacle count (${row.obstacles})`,
    );
  }
});

test('50 user join/leave cycles leave the label cache empty and renaming updates the cached label', () => {
  const room = makeRoom(SEEDED_LOBBY_OBSTACLES);
  const view = computeViewport(room.width, room.height, 1440, 900);
  const labelCache = createLabelCache();
  const ctx = createRecordingContext();

  const users = new Map();
  const world = { room, users, selfId: 'self-user' };

  // 50 distinct join/leave cycles across rendered frames.
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const id = `transient-user-${cycle}`;
    users.set(id, { id, name: `Visitor ${cycle} With A Long Name`, x: 200 + cycle * 5, y: 300 });
    drawDynamic(ctx, view, world, labelCache);
    assert.equal(labelCache.size, 1);

    users.delete(id);
    drawDynamic(ctx, view, world, labelCache);
    assert.equal(labelCache.size, 0, `cycle ${cycle} must prune departed user`);
  }

  // Steady user does not recompute across 200 frames, then updates immediately on rename.
  users.set('self-user', { id: 'self-user', name: 'Alice', x: 400, y: 400 });
  drawDynamic(ctx, view, world, labelCache);
  const computesAfterJoin = labelCache.computeCount;

  for (let i = 0; i < 200; i += 1) {
    drawDynamic(ctx, view, world, labelCache);
  }
  assert.equal(labelCache.computeCount, computesAfterJoin, 'unchanged name must not recompute');
  assert.equal(labelCache.get('self-user').text, 'Alice (you)');

  // Cached measureWidth invokes ctx.measureText once for the same font, then reuses it.
  ctx.ops.length = 0;
  const w1 = labelCache.measureWidth(ctx, labelCache.get('self-user'));
  const w2 = labelCache.measureWidth(ctx, labelCache.get('self-user'));
  assert.equal(w1, w2);
  assert.equal(ctx.ops.filter((op) => op.method === 'measureText').length, 1);

  // Rename user -> next frame updates cached text and resets cached text measurement.
  users.set('self-user', { id: 'self-user', name: 'Alexandria Nightingale', x: 410, y: 405 });
  ctx.ops.length = 0;
  drawDynamic(ctx, view, world, labelCache);
  assert.equal(labelCache.computeCount, computesAfterJoin + 1);
  const expectedTruncated = 'Alexandria Nighti…';
  assert.equal(labelCache.get('self-user').text, expectedTruncated);
  const fillTexts = ctx.ops.filter((op) => op.method === 'fillText').map((op) => op.args[0]);
  assert.deepEqual(fillTexts, ['A', expectedTruncated]);

  // Empty room clears remaining entries too.
  users.clear();
  drawDynamic(ctx, view, world, labelCache);
  assert.equal(labelCache.size, 0);
});

test('50,000-frame --expose-gc heap check and 60-avatar x 200-obstacle JS benchmark stay bounded', () => {
  const bench = runRenderBenchmark({ avatars: 60, obstacles: 200, warmup: 300, samples: 1000 });
  assert.equal(bench.staticLayerBuilds, 1);
  assert.ok(
    bench.after.p50Us < bench.before.p50Us,
    `expected cached drawFrame JS p50 (${bench.after.p50Us} us) < legacy (${bench.before.p50Us} us)`,
  );

  const script = `
    import { runHeapChecks } from ${JSON.stringify(new URL('../scripts/render-report.js', import.meta.url).href)};
    const res = runHeapChecks({ recordCount: 100000, frameCount: 50000 });
    process.stdout.write(JSON.stringify(res));
  `;
  const raw = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const heap = JSON.parse(raw);

  assert.equal(heap.measured, true);
  assert.ok(
    heap.perFramePath.retainedDeltaPerFrame < 2,
    `expected near-zero retained bytes/frame over 50k frames, got ${heap.perFramePath.retainedDeltaPerFrame}`,
  );
  assert.ok(
    heap.perFramePath.sampledAllocBytes < 65536,
    `expected < 64 KB sampled allocations across 50k frames, got ${heap.perFramePath.sampledAllocBytes} B`,
  );
  assert.ok(
    heap.perFramePath.burst50NewPerFrame < heap.perFramePath.burst50LegacyPerFrame * 0.2,
    `expected >5x reduction in young-gen burst (${heap.perFramePath.burst50NewPerFrame} vs ${heap.perFramePath.burst50LegacyPerFrame})`,
  );
});
