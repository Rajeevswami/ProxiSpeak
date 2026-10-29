import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FRAME_DT_MS, createCanvasLoop } from '../src/canvas/frameLoop.js';
import { createMovementController } from '../src/movement/controller.js';
import { formatPerfReadout, isPerfEnabled } from '../src/perf/perfReadout.js';

function createFakeEnvironment({
  width = 1280,
  height = 720,
  dpr = 1,
  hidden = false,
} = {}) {
  let nowMs = 1000;
  let nextRafId = 1;
  const pendingRaf = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const canvasListeners = new Map();
  const mediaQueries = [];
  const offscreenCanvases = [];

  function addListener(store, type, fn) {
    let set = store.get(type);
    if (!set) {
      set = new Set();
      store.set(type, set);
    }
    set.add(fn);
  }

  function removeListener(store, type, fn) {
    store.get(type)?.delete(fn);
  }

  function countListeners(store, type) {
    if (type) return store.get(type)?.size ?? 0;
    let total = 0;
    for (const set of store.values()) total += set.size;
    return total;
  }

  function emit(store, type, event = {}) {
    for (const fn of Array.from(store.get(type) ?? [])) {
      fn(event);
    }
  }

  function make2dContext() {
    const ops = [];
    return {
      ops,
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
      beginPath(...args) { ops.push(['beginPath']); },
      moveTo(...args) { ops.push(['moveTo', ...args]); },
      lineTo(...args) { ops.push(['lineTo', ...args]); },
      stroke(...args) { ops.push(['stroke']); },
      arc(...args) { ops.push(['arc', ...args]); },
      fill(...args) { ops.push(['fill']); },
      fillText(...args) { ops.push(['fillText', ...args]); },
      strokeText(...args) { ops.push(['strokeText', ...args]); },
      drawImage(...args) { ops.push(['drawImage', ...args]); },
    };
  }

  const mainCtx = make2dContext();
  let rect = { left: 0, top: 0, width, height };
  let resizeAssignments = 0;
  let backingW = 0;
  let backingH = 0;

  const canvas = {
    style: {},
    get width() { return backingW; },
    set width(v) { backingW = v; resizeAssignments += 1; },
    get height() { return backingH; },
    set height(v) { backingH = v; },
    getContext(type) { return type === '2d' ? mainCtx : null; },
    getBoundingClientRect() { return rect; },
    addEventListener(type, fn) { addListener(canvasListeners, type, fn); },
    removeEventListener(type, fn) { removeListener(canvasListeners, type, fn); },
  };

  function createOffscreenCanvas() {
    const ctx = make2dContext();
    const off = {
      width: 0,
      height: 0,
      ctx,
      getContext(type) { return type === '2d' ? ctx : null; },
    };
    offscreenCanvases.push(off);
    return off;
  }

  const doc = {
    hidden,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return createOffscreenCanvas();
    },
    addEventListener(type, fn) { addListener(docListeners, type, fn); },
    removeEventListener(type, fn) { removeListener(docListeners, type, fn); },
  };

  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    location: { search: '' },
    addEventListener(type, fn) { addListener(winListeners, type, fn); },
    removeEventListener(type, fn) { removeListener(winListeners, type, fn); },
    requestAnimationFrame(cb) {
      const id = nextRafId;
      nextRafId += 1;
      pendingRaf.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      pendingRaf.delete(id);
    },
    matchMedia(query) {
      const listeners = new Set();
      const mql = {
        media: query,
        listeners,
        addEventListener(type, fn) {
          if (type === 'change') listeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'change') listeners.delete(fn);
        },
        triggerChange() {
          for (const fn of Array.from(listeners)) fn({ media: query });
        },
      };
      mediaQueries.push(mql);
      return mql;
    },
  };

  let activeWorkDuration = 0.4;
  let perfReadCounter = null;

  function stepFrame(dtMs = 16.6667, workDurationMs = 0.4) {
    assert.ok(pendingRaf.size <= 1, `at most 1 rAF may be pending, saw ${pendingRaf.size}`);
    const entries = Array.from(pendingRaf.entries());
    if (entries.length === 0) return false;
    const [id, cb] = entries[0];
    pendingRaf.delete(id);
    nowMs += dtMs;
    const frameStamp = nowMs;
    let perfReads = 0;
    activeWorkDuration = workDurationMs;
    perfReadCounter = () => {
      perfReads += 1;
      return perfReads === 1 ? frameStamp : frameStamp + activeWorkDuration;
    };
    cb(frameStamp);
    perfReadCounter = null;
    return true;
  }

  function perfNow() {
    if (perfReadCounter) return perfReadCounter();
    return nowMs;
  }

  return {
    win,
    doc,
    canvas,
    mainCtx,
    perfNow,
    createOffscreenCanvas,
    pendingRaf,
    mediaQueries,
    offscreenCanvases,
    stepFrame,
    setViewportSize(nextWidth, nextHeight) {
      win.innerWidth = nextWidth;
      win.innerHeight = nextHeight;
      rect = { left: 0, top: 0, width: nextWidth, height: nextHeight };
    },
    getResizeAssignments() { return resizeAssignments; },
    resetResizeAssignments() { resizeAssignments = 0; },
    fireResize() { emit(winListeners, 'resize'); },
    fireVisibility(nextHidden) {
      doc.hidden = nextHidden;
      emit(docListeners, 'visibilitychange');
    },
    countWindowListeners: (type) => countListeners(winListeners, type),
    countDocListeners: (type) => countListeners(docListeners, type),
    countCanvasListeners: (type) => countListeners(canvasListeners, type),
    countMediaQueryListeners() {
      let total = 0;
      for (const mql of mediaQueries) total += mql.listeners.size;
      return total;
    },
    countLiveOffscreenCanvases() {
      return offscreenCanvases.filter((c) => c.width > 0 || c.height > 0).length;
    },
  };
}

function makeWorld(obstacles = []) {
  const users = new Map([
    ['self', { id: 'self', name: 'Alice', x: 200, y: 300 }],
    ['peer-1', { id: 'peer-1', name: 'Bob', x: 500, y: 400 }],
  ]);
  return {
    room: {
      roomId: 'lobby',
      name: 'Lobby',
      width: 1920,
      height: 1080,
      layoutRevision: 1,
      obstacles,
    },
    users,
    selfId: 'self',
    epoch: 1,
  };
}

test('schedules a single rAF at a time and cancels cleanly on unmount across 50 mount/unmount cycles', () => {
  const env = createFakeEnvironment({ width: 1440, height: 900, dpr: 2 });
  const worldRef = { current: makeWorld() };

  for (let cycle = 0; cycle < 50; cycle += 1) {
    const loop = createCanvasLoop({
      canvas: env.canvas,
      worldRef,
      window: env.win,
      document: env.doc,
      perfNow: env.perfNow,
      createCanvas: env.createOffscreenCanvas,
      onWorldClick: () => {},
    });

    loop.start();
    // Calling start() idempotently must NOT schedule a second rAF.
    loop.start();
    assert.equal(env.pendingRaf.size, 1, 'exactly 1 pending rAF after start()');

    env.stepFrame(16.67);
    assert.equal(env.pendingRaf.size, 1, 'exactly 1 pending rAF after tick');
    assert.equal(env.countLiveOffscreenCanvases(), 1);

    loop.stop();
    assert.equal(env.pendingRaf.size, 0, '0 pending rAF after stop()');
    assert.equal(loop.getLabelCache().size, 0);
  }

  assert.equal(env.countWindowListeners('resize'), 0, '0 leaked resize listeners');
  assert.equal(env.countWindowListeners(), 0, '0 leaked window listeners');
  assert.equal(env.countDocListeners('visibilitychange'), 0, '0 leaked visibilitychange listeners');
  assert.equal(env.countDocListeners(), 0, '0 leaked document listeners');
  assert.equal(env.countMediaQueryListeners(), 0, '0 leaked matchMedia listeners');
  assert.equal(env.countCanvasListeners('click'), 0, '0 leaked canvas click listeners');
  assert.equal(env.pendingRaf.size, 0, '0 pending rAF callbacks');
  assert.equal(env.countLiveOffscreenCanvases(), 0, '0 unreleased offscreen canvases');
});

test('coalesces a 100-event resize burst into 1 canvas resize and 1 static-layer rebuild on the next frame', () => {
  const env = createFakeEnvironment({ width: 800, height: 600, dpr: 1 });
  const worldRef = { current: makeWorld() };
  const loop = createCanvasLoop({
    canvas: env.canvas,
    worldRef,
    window: env.win,
    document: env.doc,
    perfNow: env.perfNow,
    createCanvas: env.createOffscreenCanvas,
  });

  loop.start();
  env.stepFrame(16.67);
  assert.equal(loop.getStaticLayer().getBuildCount(), 1);
  env.resetResizeAssignments();

  // Burst 100 resize events within a single frame interval.
  for (let i = 1; i <= 100; i += 1) {
    env.setViewportSize(800 + i * 4, 600 + i * 2);
    env.fireResize();
  }

  // Nothing rebuilt synchronously during the 100-event burst.
  assert.equal(env.getResizeAssignments(), 0);
  assert.equal(loop.getStaticLayer().getBuildCount(), 1);

  // Next rAF coalesces all 100 events into 1 canvas resize + 1 static rebuild.
  env.stepFrame(16.67);
  assert.equal(env.getResizeAssignments(), 1);
  assert.equal(loop.getStaticLayer().getBuildCount(), 2);
  assert.equal(env.canvas.width, 1200);
  assert.equal(env.canvas.height, 800);

  loop.stop();
});

test('watches DPR changes via matchMedia, re-arms after each change, and cleans up on unmount', () => {
  const env = createFakeEnvironment({ width: 1000, height: 500, dpr: 1 });
  const worldRef = { current: makeWorld() };
  const loop = createCanvasLoop({
    canvas: env.canvas,
    worldRef,
    window: env.win,
    document: env.doc,
    perfNow: env.perfNow,
    createCanvas: env.createOffscreenCanvas,
  });

  loop.start();
  env.stepFrame(16.67);
  assert.equal(env.mediaQueries.length, 1);
  assert.equal(env.mediaQueries[0].media, '(resolution: 1dppx)');
  assert.equal(env.mediaQueries[0].listeners.size, 1);
  assert.equal(loop.getStaticLayer().getBuildCount(), 1);

  // Drag window to a Retina (DPR 2) display.
  env.win.devicePixelRatio = 2;
  env.mediaQueries[0].triggerChange();

  assert.equal(env.mediaQueries[0].listeners.size, 0, 'old MediaQueryList listener removed');
  assert.equal(env.mediaQueries.length, 2, 're-armed new MediaQueryList');
  assert.equal(env.mediaQueries[1].media, '(resolution: 2dppx)');
  assert.equal(env.mediaQueries[1].listeners.size, 1);

  env.stepFrame(16.67);
  assert.equal(env.canvas.width, 2000);
  assert.equal(env.canvas.height, 1000);
  assert.equal(loop.getStaticLayer().getBuildCount(), 2);

  loop.stop();
  assert.equal(env.countMediaQueryListeners(), 0);
});

test('skips draw work while document.hidden and clamps a 5s gap to <= MAX_FRAME_DT_MS without teleporting', () => {
  assert.equal(MAX_FRAME_DT_MS, 50);

  const env = createFakeEnvironment({ width: 1280, height: 720, dpr: 1 });
  const world = makeWorld();
  const worldRef = { current: world };
  const controller = createMovementController({
    world,
    emitMove: () => {},
    now: env.perfNow,
  });
  controller.pressKey('ArrowRight');

  const perfEl = { textContent: '' };
  const loop = createCanvasLoop({
    canvas: env.canvas,
    worldRef,
    updateFrame: (dtSec) => controller.update(dtSec),
    perfEnabled: true,
    perfElement: perfEl,
    window: env.win,
    document: env.doc,
    perfNow: env.perfNow,
    createCanvas: env.createOffscreenCanvas,
  });

  loop.start();
  env.stepFrame(16.67); // initial frame establishes time base (dt = 0)
  env.stepFrame(16.67); // 1 normal frame at ~60 Hz (~5 px step)
  const xBeforeHide = world.users.get('self').x;
  assert.ok(xBeforeHide > 200 && xBeforeHide < 206);

  // Hide tab: rAF ticks while hidden must skip both updateFrame and canvas drawing.
  env.fireVisibility(true);
  env.mainCtx.ops.length = 0;
  env.stepFrame(1000);
  env.stepFrame(2000);
  assert.equal(env.mainCtx.ops.length, 0, 'zero draw ops while document.hidden is true');
  assert.equal(world.users.get('self').x, xBeforeHide, 'avatar did not move while hidden');

  // Return after a 5-second hidden-tab gap.
  env.fireVisibility(false);
  env.stepFrame(2000); // total 5,000 ms elapsed since last visible frame
  const xAfterReturn = world.users.get('self').x;
  assert.equal(xAfterReturn, xBeforeHide, 'returning frame resets time base without jump');

  // Also simulate an unannounced 5-second main-thread stall while visible:
  // dt MUST be clamped to MAX_FRAME_DT_MS (50 ms -> max 300 * 0.05 = 15 px, never 1,500 px).
  env.stepFrame(5000);
  const stepAfterStall = world.users.get('self').x - xAfterReturn;
  assert.ok(
    stepAfterStall <= (MAX_FRAME_DT_MS / 1000) * 300 + 1e-6,
    `5s stall step (${stepAfterStall} px) must be clamped to <= 15 px`,
  );

  // Verify the 5s hidden/stall gaps were excluded from dropped-frame stats.
  const snap = loop.getFrameStats().snapshot();
  assert.equal(snap.dropped, 0, 'hidden/5s gap must not pollute dropped frame count');

  loop.stop();
});

test('60 Hz and 144 Hz frame rates move the avatar to the same position over 1 simulated second', () => {
  function runAtHz(hz) {
    const env = createFakeEnvironment({ width: 1280, height: 720, dpr: 1 });
    const world = makeWorld();
    const worldRef = { current: world };
    const controller = createMovementController({
      world,
      emitMove: () => {},
      now: env.perfNow,
    });
    controller.pressKey('ArrowRight');

    const loop = createCanvasLoop({
      canvas: env.canvas,
      worldRef,
      updateFrame: (dtSec) => controller.update(dtSec),
      window: env.win,
      document: env.doc,
      perfNow: env.perfNow,
      createCanvas: env.createOffscreenCanvas,
    });
    loop.start();

    const dtMs = 1000 / hz;
    // Frame 0 establishes the rAF timestamp baseline; next `hz` frames span 1.000 s.
    env.stepFrame(dtMs);
    for (let i = 0; i < hz; i += 1) {
      env.stepFrame(dtMs);
    }

    const finalX = world.users.get('self').x;
    loop.stop();
    return finalX;
  }

  const x60 = runAtHz(60);
  const x144 = runAtHz(144);
  assert.ok(Math.abs(x60 - 500) < 0.5, `expected ~500 px after 1s at 300 px/s (got ${x60})`);
  assert.ok(Math.abs(x60 - x144) < 0.01, `60 Hz (${x60}) vs 144 Hz (${x144}) must match`);
});

test('?perf=1 readout is strictly gated and writes textContent at <= 1 Hz without React state', () => {
  assert.equal(isPerfEnabled(''), false);
  assert.equal(isPerfEnabled('?perf=0'), false);
  assert.equal(isPerfEnabled('?perf=false'), false);
  assert.equal(isPerfEnabled('?room=lobby'), false);
  assert.equal(isPerfEnabled('?perf=1'), true);
  assert.equal(isPerfEnabled('?room=lobby&perf=1'), true);
  assert.equal(isPerfEnabled('https://proxispeak.local/?perf=1'), true);

  assert.equal(
    formatPerfReadout({
      fps: 59.94,
      dropped: 0,
      interval: { p95: 16.86 },
      work: { p95: 0.78 },
    }),
    'fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0',
  );

  // Disabled path: zero frameStats sampling and zero DOM writes.
  const disabledEnv = createFakeEnvironment();
  let disabledWrites = 0;
  const disabledEl = {
    set textContent(_v) { disabledWrites += 1; },
  };
  const disabledLoop = createCanvasLoop({
    canvas: disabledEnv.canvas,
    worldRef: { current: makeWorld() },
    perfEnabled: false,
    perfElement: disabledEl,
    window: disabledEnv.win,
    document: disabledEnv.doc,
    perfNow: disabledEnv.perfNow,
    createCanvas: disabledEnv.createOffscreenCanvas,
  });
  disabledLoop.start();
  assert.equal(disabledLoop.getFrameStats(), null);
  for (let i = 0; i < 300; i += 1) disabledEnv.stepFrame(16.6667);
  assert.equal(disabledWrites, 0);
  disabledLoop.stop();

  // Enabled path: 5 simulated seconds (300 frames at 60 Hz) writes textContent <= 6 times (initial + <= 1 Hz).
  const enabledEnv = createFakeEnvironment();
  const writes = [];
  const enabledEl = {
    textValue: '',
    get textContent() { return this.textValue; },
    set textContent(v) {
      this.textValue = v;
      writes.push(v);
    },
  };
  const enabledLoop = createCanvasLoop({
    canvas: enabledEnv.canvas,
    worldRef: { current: makeWorld() },
    perfEnabled: true,
    perfElement: enabledEl,
    window: enabledEnv.win,
    document: enabledEnv.doc,
    perfNow: enabledEnv.perfNow,
    createCanvas: enabledEnv.createOffscreenCanvas,
  });
  enabledLoop.start();

  // 300 frames * 16.6667 ms = 5,000.01 ms -> at most 6 writes (initial frame + 5 seconds at <= 1 Hz).
  for (let i = 0; i < 300; i += 1) {
    enabledEnv.stepFrame(16.6667, 0.42);
  }
  assert.ok(writes.length >= 4 && writes.length <= 6, `expected <= 1 Hz writes over 5s, got ${writes.length}`);
  assert.match(
    writes[writes.length - 1],
    /^fps 60 \| frame p95 16\.7 ms \| work p95 0\.4 ms \| dropped 0$/,
  );

  enabledLoop.stop();
});

test('an exception inside updateFrame or renderFrame never escapes rAF or kills the loop', () => {
  const env = createFakeEnvironment({ width: 1280, height: 720, dpr: 1 });
  const worldRef = { current: makeWorld() };
  const caught = [];
  let frameIndex = 0;
  let successfulRenders = 0;

  const loop = createCanvasLoop({
    canvas: env.canvas,
    worldRef,
    updateFrame: () => {
      frameIndex += 1;
      if (frameIndex === 2) {
        throw new Error('simulated updateFrame failure');
      }
    },
    renderFrame: (ctx) => {
      if (frameIndex === 3) {
        throw new Error('simulated renderFrame failure');
      }
      ctx.fillRect(0, 0, 10, 10);
      successfulRenders += 1;
    },
    onError: (err) => {
      caught.push(err.message);
    },
    window: env.win,
    document: env.doc,
    perfNow: env.perfNow,
    createCanvas: env.createOffscreenCanvas,
  });

  loop.start();
  // Frame 1: normal; Frame 2: updateFrame throws; Frame 3: renderFrame throws; Frame 4: normal recovery.
  for (let i = 0; i < 4; i += 1) {
    assert.doesNotThrow(() => env.stepFrame(16.67));
    assert.equal(env.pendingRaf.size, 1, `loop must keep 1 pending rAF after frame ${i + 1}`);
  }

  assert.equal(loop.getErrorCount(), 2);
  assert.deepEqual(caught, ['simulated updateFrame failure', 'simulated renderFrame failure']);
  assert.equal(successfulRenders, 2);

  loop.stop();
  assert.equal(env.pendingRaf.size, 0);
});
