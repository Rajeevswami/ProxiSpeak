/**
 * Framework-free single-rAF canvas render loop — Week 3 (Day 18).
 *
 * Keeps all DOM/canvas lifecycle rules unit-testable under `node:test` without
 * a browser or DOM library:
 *  - Exactly one pending `requestAnimationFrame` registration at a time.
 *  - Frame delta comes strictly from the rAF timestamp and is clamped to
 *    `MAX_FRAME_DT_MS` (50 ms) so a slow frame or returning hidden tab never
 *    teleports avatars.
 *  - When `document.hidden` is true, drawing and simulation work are skipped
 *    and the time base is reset so returning to the tab starts cleanly.
 *  - `resize` events and `matchMedia('(resolution: Ndppx)')` DPR changes are
 *    coalesced via `needsResize` so the canvas and static layer rebuild at most
 *    once per animation frame; the DPR watcher re-arms after every monitor/zoom
 *    transition and tears down completely on `stop()`.
 *  - Optional `?perf=1` readout: samples intervals and callback work into a
 *    preallocated `frameStats` ring buffer ONLY when enabled, updating
 *    `perfElement.textContent` directly at most once per second (no React state).
 *  - Owns one `staticLayer` and one `labelCache` per mounted canvas and
 *    releases both on `stop()`.
 */
import { MIN_CANVAS_SIZE_PX, screenToWorldInto, updateCanvasSize, updateViewport } from './coords.js';
import { createLabelCache, drawFrame } from './renderer.js';
import { createStaticLayer } from './staticLayer.js';
import { EXCLUDED_INTERVAL_MS, createFrameStats } from '../perf/frameStats.js';
import { PERF_READOUT_INTERVAL_MS, formatPerfReadout, isPerfEnabled } from '../perf/perfReadout.js';

/**
 * Maximum simulation step per animation frame, in milliseconds (50 ms = 0.05 s,
 * ~3 frames at 60 Hz, advancing a 300 px/s avatar at most 15 px). Prevents a
 * slow frame or a returning hidden tab from teleporting avatars.
 */
export const MAX_FRAME_DT_MS = 50;

/**
 * Build the CSS media query string for watching `devicePixelRatio` changes
 * (for example when dragging the window to another monitor or zooming).
 *
 * @param {number} dpr
 * @returns {string}
 */
export function resolutionMediaQuery(dpr) {
  const safeDpr = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return `(resolution: ${safeDpr}dppx)`;
}

const scratchClickPoint = { x: 0, y: 0 };
const scratchClickViewport = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  drawnWidth: 0,
  drawnHeight: 0,
  roomWidth: 0,
  roomHeight: 0,
  canvasWidth: 0,
  canvasHeight: 0,
};

function defaultPerfNow(win) {
  if (typeof win?.performance?.now === 'function') {
    return () => win.performance.now();
  }
  return () => performance.now();
}

/**
 * Create and manage the single `requestAnimationFrame` loop for one `<canvas>`.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {{ current: object }} options.worldRef
 * @param {((deltaSeconds: number) => void)|null} [options.updateFrame]
 * @param {((ctx: CanvasRenderingContext2D, world: object, view: object) => void)|null} [options.renderFrame]
 * @param {((point: { x: number, y: number }) => void)|null} [options.onWorldClick]
 * @param {HTMLElement|null} [options.perfElement] DOM node whose `textContent` receives the <= 1 Hz `?perf=1` line
 * @param {boolean} [options.perfEnabled] override URL detection in tests
 * @param {object|null} [options.frameStats] injectable `createFrameStats()` instance
 * @param {() => number} [options.perfNow] injectable monotonic clock in ms for callback work timing
 * @param {Window} [options.window]
 * @param {Document|null} [options.document]
 * @param {() => HTMLCanvasElement} [options.createCanvas]
 */
export function createCanvasLoop({
  canvas,
  worldRef,
  updateFrame = null,
  renderFrame = null,
  onWorldClick = null,
  perfElement = null,
  perfEnabled,
  frameStats: injectedFrameStats = null,
  perfNow: injectedPerfNow = null,
  window: win = typeof window === 'undefined' ? null : window,
  document: doc = typeof document === 'undefined' ? null : document,
  createCanvas,
} = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createCanvasLoop requires a canvas element');
  }
  if (!win || typeof win.requestAnimationFrame !== 'function' || typeof win.cancelAnimationFrame !== 'function') {
    throw new TypeError('createCanvasLoop requires window requestAnimationFrame/cancelAnimationFrame');
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      start() {},
      stop() {},
      getStaticLayer: () => null,
      getLabelCache: () => null,
      getFrameStats: () => null,
    };
  }

  const staticLayer = createStaticLayer(createCanvas ? { createCanvas } : undefined);
  const labelCache = createLabelCache();

  const samplingEnabled = perfEnabled !== undefined
    ? Boolean(perfEnabled)
    : isPerfEnabled(win.location?.search ?? '');
  const frameStats = samplingEnabled ? (injectedFrameStats ?? createFrameStats()) : null;
  const readWorkClock = samplingEnabled ? (injectedPerfNow ?? defaultPerfNow(win)) : null;

  // Single reused view object for the loop's whole lifetime — zero per-frame allocations.
  const view = {
    width: MIN_CANVAS_SIZE_PX,
    height: MIN_CANVAS_SIZE_PX,
    dpr: 1,
    backingWidth: MIN_CANVAS_SIZE_PX,
    backingHeight: MIN_CANVAS_SIZE_PX,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    drawnWidth: 0,
    drawnHeight: 0,
    roomWidth: 0,
    roomHeight: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  };

  let running = false;
  let hasPendingRaf = false;
  let rafId = 0;
  let hasTimeBase = false;
  let lastFrameTime = 0;
  let hasPerfPublishBase = false;
  let lastPerfPublishTime = 0;
  let needsResize = false;
  let currentMql = null;

  let appliedBackingWidth = 0;
  let appliedBackingHeight = 0;
  let appliedCssWidth = 0;
  let appliedCssHeight = 0;
  let appliedDpr = 0;

  const syncCanvasSize = () => {
    updateCanvasSize(view, win.innerWidth, win.innerHeight, win.devicePixelRatio || 1);
    if (
      view.backingWidth === appliedBackingWidth
      && view.backingHeight === appliedBackingHeight
      && view.width === appliedCssWidth
      && view.height === appliedCssHeight
      && view.dpr === appliedDpr
    ) {
      return false;
    }
    appliedBackingWidth = view.backingWidth;
    appliedBackingHeight = view.backingHeight;
    appliedCssWidth = view.width;
    appliedCssHeight = view.height;
    appliedDpr = view.dpr;

    canvas.width = view.backingWidth;
    canvas.height = view.backingHeight;
    if (canvas.style) {
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
    }
    if (typeof ctx.setTransform === 'function') {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    }
    return true;
  };

  const onResize = () => {
    needsResize = true;
  };

  const disarmDprWatcher = () => {
    if (!currentMql) return;
    if (typeof currentMql.removeEventListener === 'function') {
      currentMql.removeEventListener('change', onDprChange);
    } else if (typeof currentMql.removeListener === 'function') {
      currentMql.removeListener(onDprChange);
    }
    currentMql = null;
  };

  const armDprWatcher = () => {
    disarmDprWatcher();
    if (!running || typeof win.matchMedia !== 'function') return;
    const mql = win.matchMedia(resolutionMediaQuery(win.devicePixelRatio));
    if (!mql) return;
    currentMql = mql;
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onDprChange);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onDprChange);
    }
  };

  function onDprChange() {
    if (!running) return;
    needsResize = true;
    armDprWatcher();
  }

  const resetTimeBase = () => {
    hasTimeBase = false;
    if (frameStats) frameStats.markHidden();
  };

  const onVisibilityChange = () => {
    if (doc?.hidden) {
      resetTimeBase();
    }
  };

  const scheduleNextFrame = () => {
    if (!running || hasPendingRaf) return;
    hasPendingRaf = true;
    rafId = win.requestAnimationFrame(onFrame);
  };

  function onFrame(now) {
    hasPendingRaf = false;
    if (!running) return;

    if (doc?.hidden) {
      resetTimeBase();
      scheduleNextFrame();
      return;
    }

    const workStart = samplingEnabled ? readWorkClock() : 0;

    if (needsResize) {
      needsResize = false;
      syncCanvasSize();
    }

    const hasFiniteNow = typeof now === 'number' && Number.isFinite(now);
    let rawIntervalMs = EXCLUDED_INTERVAL_MS;
    let clampedDtMs = 0;

    if (hasTimeBase && hasFiniteNow) {
      rawIntervalMs = now - lastFrameTime;
      lastFrameTime = now;
      if (rawIntervalMs > 0) {
        clampedDtMs = rawIntervalMs <= MAX_FRAME_DT_MS ? rawIntervalMs : MAX_FRAME_DT_MS;
      }
    } else if (hasFiniteNow) {
      lastFrameTime = now;
      hasTimeBase = true;
    }

    if (updateFrame) {
      updateFrame(clampedDtMs / 1000);
    }

    if (renderFrame) {
      renderFrame(ctx, worldRef?.current ?? null, view);
    } else {
      drawFrame(ctx, staticLayer, view, worldRef?.current ?? null, labelCache);
    }

    if (samplingEnabled) {
      const workMs = Math.max(0, readWorkClock() - workStart);
      frameStats.record(rawIntervalMs, workMs);

      if (perfElement && hasFiniteNow) {
        if (!hasPerfPublishBase) {
          lastPerfPublishTime = now;
          hasPerfPublishBase = true;
        } else if (now - lastPerfPublishTime >= PERF_READOUT_INTERVAL_MS) {
          lastPerfPublishTime = now;
          perfElement.textContent = formatPerfReadout(frameStats.snapshot());
        }
      }
    }

    scheduleNextFrame();
  }

  const handleClick = (event) => {
    if (!onWorldClick || event?.button !== 0) return;
    const room = worldRef?.current?.room;
    if (!room) return;
    if (needsResize) {
      needsResize = false;
      syncCanvasSize();
    }
    const rect = canvas.getBoundingClientRect();
    updateViewport(scratchClickViewport, room.width, room.height, view.width, view.height);
    screenToWorldInto(
      event.clientX - rect.left,
      event.clientY - rect.top,
      scratchClickViewport,
      scratchClickPoint,
    );
    onWorldClick({ x: scratchClickPoint.x, y: scratchClickPoint.y });
  };

  const start = () => {
    if (running) return;
    running = true;
    hasTimeBase = false;
    hasPerfPublishBase = false;
    needsResize = false;
    syncCanvasSize();
    win.addEventListener?.('resize', onResize);
    doc?.addEventListener?.('visibilitychange', onVisibilityChange);
    armDprWatcher();
    canvas.addEventListener?.('click', handleClick);
    scheduleNextFrame();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (hasPendingRaf) {
      hasPendingRaf = false;
      win.cancelAnimationFrame(rafId);
    }
    win.removeEventListener?.('resize', onResize);
    doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    disarmDprWatcher();
    canvas.removeEventListener?.('click', handleClick);
    staticLayer.destroy();
    labelCache.clear();
    if (frameStats) frameStats.reset();
  };

  return {
    start,
    stop,
    getStaticLayer: () => staticLayer,
    getLabelCache: () => labelCache,
    getFrameStats: () => frameStats,
  };
}

export default createCanvasLoop;
