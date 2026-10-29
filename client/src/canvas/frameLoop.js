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
 *  - Owns one `staticLayer` and one `labelCache` per mounted canvas and
 *    releases both on `stop()`.
 */
import { MIN_CANVAS_SIZE_PX, screenToWorldInto, updateCanvasSize, updateViewport } from './coords.js';
import { createLabelCache, drawFrame } from './renderer.js';
import { createStaticLayer } from './staticLayer.js';

/**
 * Maximum simulation step per animation frame, in milliseconds (50 ms = 0.05 s,
 * ~3 frames at 60 Hz, advancing a 300 px/s avatar at most 15 px). Prevents a
 * slow frame or a returning hidden tab from teleporting avatars.
 */
export const MAX_FRAME_DT_MS = 50;

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

/**
 * Create and manage the single `requestAnimationFrame` loop for one `<canvas>`.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {{ current: object }} options.worldRef
 * @param {((deltaSeconds: number) => void)|null} [options.updateFrame]
 * @param {((ctx: CanvasRenderingContext2D, world: object, view: object) => void)|null} [options.renderFrame]
 * @param {((point: { x: number, y: number }) => void)|null} [options.onWorldClick]
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
  if (!ctx) return { start() {}, stop() {}, getStaticLayer: () => null, getLabelCache: () => null };

  const staticLayer = createStaticLayer(createCanvas ? { createCanvas } : undefined);
  const labelCache = createLabelCache();

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

  const resetTimeBase = () => {
    hasTimeBase = false;
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

    let clampedDtMs = 0;
    if (hasTimeBase && typeof now === 'number' && Number.isFinite(now)) {
      const rawDtMs = now - lastFrameTime;
      lastFrameTime = now;
      if (rawDtMs > 0) {
        clampedDtMs = rawDtMs <= MAX_FRAME_DT_MS ? rawDtMs : MAX_FRAME_DT_MS;
      }
    } else if (typeof now === 'number' && Number.isFinite(now)) {
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

    scheduleNextFrame();
  }

  const handleClick = (event) => {
    if (!onWorldClick || event?.button !== 0) return;
    const room = worldRef?.current?.room;
    if (!room) return;
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
    syncCanvasSize();
    win.addEventListener?.('resize', syncCanvasSize);
    doc?.addEventListener?.('visibilitychange', onVisibilityChange);
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
    win.removeEventListener?.('resize', syncCanvasSize);
    doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    canvas.removeEventListener?.('click', handleClick);
    staticLayer.destroy();
    labelCache.clear();
  };

  return {
    start,
    stop,
    getStaticLayer: () => staticLayer,
    getLabelCache: () => labelCache,
  };
}

export default createCanvasLoop;
