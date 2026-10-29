import test from 'node:test';
import assert from 'node:assert/strict';

import { updateCanvasSize } from '../src/canvas/coords.js';
import {
  MAX_BACKING_PIXELS,
  createStaticLayer,
  resolveBackingMetrics,
} from '../src/canvas/staticLayer.js';

function createFakeCanvasEnv() {
  const canvases = [];
  function createCanvas() {
    const ops = [];
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1.5,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      globalAlpha: 1,
      setTransform(...args) { ops.push(['setTransform', ...args]); },
      clearRect(...args) { ops.push(['clearRect', ...args]); },
      fillRect(...args) { ops.push(['fillRect', ...args]); },
      strokeRect(...args) { ops.push(['strokeRect', ...args]); },
      beginPath() { ops.push(['beginPath']); },
      moveTo(...args) { ops.push(['moveTo', ...args]); },
      lineTo(...args) { ops.push(['lineTo', ...args]); },
      stroke() { ops.push(['stroke']); },
      fillText(...args) { ops.push(['fillText', ...args]); },
    };
    const canvas = {
      width: 0,
      height: 0,
      ops,
      ctx,
      getContext(type) {
        return type === '2d' ? ctx : null;
      },
    };
    canvases.push(canvas);
    return canvas;
  }
  return { canvases, createCanvas };
}

function makeRoom(overrides = {}) {
  return {
    roomId: 'lobby',
    name: 'Lobby',
    width: 1920,
    height: 1080,
    layoutRevision: 1,
    obstacles: [
      { id: 'desk-1', x: 260, y: 220, w: 220, h: 110, type: 'desk' },
      { id: 'wall-1', x: 940, y: 0, w: 40, h: 400, type: 'wall' },
    ],
    ...overrides,
  };
}

function makeView(width = 1440, height = 900, dpr = 2) {
  return updateCanvasSize(
    {
      width: 0,
      height: 0,
      dpr: 1,
      backingWidth: 1,
      backingHeight: 1,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      drawnWidth: 0,
      drawnHeight: 0,
      roomWidth: 0,
      roomHeight: 0,
      canvasWidth: 0,
      canvasHeight: 0,
    },
    width,
    height,
    dpr,
  );
}

test('1,000 unchanged frames build the static offscreen layer once', () => {
  const env = createFakeCanvasEnv();
  let drawCalls = 0;
  const layer = createStaticLayer({
    createCanvas: env.createCanvas,
    drawStatic(ctx, size, room) {
      drawCalls += 1;
      ctx.fillRect(0, 0, size.width, size.height);
      assert.equal(room.roomId, 'lobby');
    },
  });

  const view = makeView(1440, 900, 2);
  const room = makeRoom({ layoutRevision: 1 });

  for (let i = 0; i < 1000; i += 1) {
    // Even if a fresh room wrapper with identical roomId + layoutRevision is passed,
    // numeric/string input comparison must not rebuild.
    const sameInputsRoom = i === 500 ? { ...room } : room;
    layer.ensure(view, sameInputsRoom);
  }

  assert.equal(layer.getBuildCount(), 1);
  assert.equal(drawCalls, 1);
  assert.equal(env.canvases.length, 1);
  assert.deepEqual(layer.getBackingSize(), { backingWidth: 2880, backingHeight: 1800 });
});

test('rebuilds once for each change to size, DPR, roomId, or layoutRevision', () => {
  const env = createFakeCanvasEnv();
  const layer = createStaticLayer({ createCanvas: env.createCanvas });

  let view = makeView(1280, 720, 1);
  let room = makeRoom({ roomId: 'lobby', layoutRevision: 1 });

  layer.ensure(view, room);
  assert.equal(layer.getBuildCount(), 1);

  // 1. CSS size change -> backing size changes -> +1 rebuild
  view = makeView(1440, 900, 1);
  layer.ensure(view, room);
  layer.ensure(view, room);
  assert.equal(layer.getBuildCount(), 2);

  // 2. DPR change -> +1 rebuild
  view = makeView(1440, 900, 2);
  layer.ensure(view, room);
  layer.ensure(view, room);
  assert.equal(layer.getBuildCount(), 3);

  // 3. roomId change -> +1 rebuild
  room = makeRoom({ roomId: 'focus-north', layoutRevision: 1 });
  layer.ensure(view, room);
  layer.ensure(view, room);
  assert.equal(layer.getBuildCount(), 4);

  // 4. layoutRevision change within same roomId -> +1 rebuild
  room = makeRoom({ roomId: 'focus-north', layoutRevision: 2 });
  layer.ensure(view, room);
  layer.ensure(view, room);
  assert.equal(layer.getBuildCount(), 5);

  // 5. Transition to null room (disconnected / loading backdrop) -> +1 rebuild
  layer.ensure(view, null);
  layer.ensure(view, null);
  assert.equal(layer.getBuildCount(), 6);
});

test('destroy() zeroes backing dimensions and releases the offscreen canvas reference', () => {
  const env = createFakeCanvasEnv();
  const layer = createStaticLayer({ createCanvas: env.createCanvas });
  const view = makeView(1440, 900, 2);
  const room = makeRoom();

  const offscreen = layer.ensure(view, room);
  assert.equal(offscreen.width, 2880);
  assert.equal(offscreen.height, 1800);
  assert.equal(layer.getCanvas(), offscreen);

  layer.destroy();
  assert.equal(offscreen.width, 0);
  assert.equal(offscreen.height, 0);
  assert.equal(layer.getCanvas(), null);
  assert.deepEqual(layer.getBackingSize(), { backingWidth: 0, backingHeight: 0 });
});

test('MAX_BACKING_PIXELS clamps 4K@3x proportionally while keeping phone@3x and laptop@2x exact', () => {
  assert.equal(MAX_BACKING_PIXELS, 16_000_000);

  // 4K monitor: 3840x2160 at DPR 3 -> unclamped 11520x6480 = 74,649,600 px (> 16M)
  const monitor4k = resolveBackingMetrics(3840, 2160, 3);
  assert.ok(monitor4k.dpr < 3, '4K@3x must lower effective DPR below 3');
  assert.ok(monitor4k.dpr > 1.38 && monitor4k.dpr < 1.39);
  assert.equal(monitor4k.backingWidth, 5333);
  assert.equal(monitor4k.backingHeight, 3000);
  assert.ok(
    monitor4k.backingWidth * monitor4k.backingHeight <= MAX_BACKING_PIXELS,
    'backing pixel count must stay within MAX_BACKING_PIXELS',
  );
  const cssAspect = 3840 / 2160;
  const backingAspect = monitor4k.backingWidth / monitor4k.backingHeight;
  assert.ok(Math.abs(backingAspect - cssAspect) < 1e-3, 'aspect ratio must stay proportional');

  // Phone: 390x844 at DPR 3 -> 1170x2532 = 2,962,440 px (<= 16M, unclamped)
  const phone = resolveBackingMetrics(390, 844, 3);
  assert.equal(phone.dpr, 3);
  assert.equal(phone.backingWidth, 1170);
  assert.equal(phone.backingHeight, 2532);
  assert.ok(phone.backingWidth * phone.backingHeight <= MAX_BACKING_PIXELS);

  // Laptop: 1440x900 at DPR 2 -> 2880x1800 = 5,184,000 px (<= 16M, unclamped)
  const laptop = resolveBackingMetrics(1440, 900, 2);
  assert.equal(laptop.dpr, 2);
  assert.equal(laptop.backingWidth, 2880);
  assert.equal(laptop.backingHeight, 1800);
  assert.ok(laptop.backingWidth * laptop.backingHeight <= MAX_BACKING_PIXELS);

  // Full HD desktop: 1920x1080 at DPR 1 -> 1920x1080 = 2,073,600 px (<= 16M, unclamped)
  const fullHd = resolveBackingMetrics(1920, 1080, 1);
  assert.equal(fullHd.dpr, 1);
  assert.equal(fullHd.backingWidth, 1920);
  assert.equal(fullHd.backingHeight, 1080);

  // Off-by-one boundary sweep: neither Math.round nor extreme aspect ratios may exceed MAX_BACKING_PIXELS,
  // and dimensions must always be positive integers (>= 1).
  const trickyCases = [
    [143, 7715, 4], // previously rounded 544.58 -> 545 * 29381 = 16,012,645 (> 16M)
    [4001, 4000, 3],
    [4000, 4000, 3],
    [4096, 4096, 2],
    [25000000, 1, 2],
    [0, 0, 3],
    [0.2, 0.2, 1],
  ];
  let seed = 0x51a71c;
  for (let i = 0; i < 10000; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const w = (seed % 8000) + 1;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const h = (seed % 8000) + 1;
    const dpr = [0.5, 1, 1.25, 1.5, 2, 2.5, 3, 4][i & 7];
    trickyCases.push([w, h, dpr]);
  }
  for (const [w, h, dpr] of trickyCases) {
    const m = resolveBackingMetrics(w, h, dpr);
    assert.ok(Number.isInteger(m.backingWidth) && m.backingWidth >= 1);
    assert.ok(Number.isInteger(m.backingHeight) && m.backingHeight >= 1);
    assert.ok(
      m.backingWidth * m.backingHeight <= MAX_BACKING_PIXELS,
      `off-by-one overflow for ${w}x${h}@${dpr}: ${m.backingWidth}x${m.backingHeight}=${m.backingWidth * m.backingHeight}`,
    );
  }

  // Also verify createStaticLayer sets effective DPR on the offscreen 2D context.
  const env = createFakeCanvasEnv();
  const layer = createStaticLayer({ createCanvas: env.createCanvas });
  layer.ensure({ width: 3840, height: 2160, dpr: 3 }, makeRoom());
  assert.ok(Math.abs(layer.getEffectiveDpr() - monitor4k.dpr) < 1e-9);
  assert.deepEqual(layer.getBackingSize(), { backingWidth: 5333, backingHeight: 3000 });
});
