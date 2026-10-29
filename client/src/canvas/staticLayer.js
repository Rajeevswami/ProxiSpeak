/**
 * Offscreen static room canvas cache — Week 3 (Day 18).
 *
 * Holds everything that does NOT change from frame to frame (letterbox
 * backdrop, room floor, grid lines, room border, obstacles and their type
 * labels). `ensure(view, room)` compares primitive numbers and the `room.roomId`
 * reference — zero string concatenation and zero object creation per frame —
 * and rebuilds ONLY when backing size, effective device pixel ratio, room id,
 * or `layoutRevision` changes.
 *
 * Why `MAX_BACKING_PIXELS` (16,000,000) caps the effective ratio:
 *  - Memory: 16M RGBA pixels is 64 MB per canvas (128 MB across the visible
 *    canvas plus this static layer). An uncapped 3840x2160 4K viewport at DPR 3
 *    would allocate 74.6M pixels (~298 MB per canvas, ~597 MB combined).
 *  - Browser / GPU texture limits: WebKit/Safari and mobile tile GPUs silently
 *    refuse backing stores above ~16.7M pixels (4096x4096), leaving the canvas
 *    permanently blank. Reducing `effectiveDpr = min(dpr, sqrt(16_000_000 / area))`
 *    keeps 4K and ultrawide displays within texture and memory budgets while
 *    leaving phones (390x844 @ DPR 3 = 2.96M px) and retina laptops
 *    (1440x900 @ DPR 2 = 5.18M px) at their full native ratio.
 */
import { MAX_BACKING_PIXELS, MIN_CANVAS_SIZE_PX } from './coords.js';
import { drawStatic as defaultDrawStatic } from './renderer.js';

export { MAX_BACKING_PIXELS, MIN_CANVAS_SIZE_PX };

function defaultCreateCanvas() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('createStaticLayer requires document.createElement or an injected createCanvas factory');
  }
  return document.createElement('canvas');
}

function sanitizeCssLength(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : MIN_CANVAS_SIZE_PX;
}

/**
 * Compute effective DPR and integer backing-store dimensions under the
 * `MAX_BACKING_PIXELS` cap without allocating when `out` is supplied.
 *
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} [devicePixelRatio]
 * @param {object} [out]
 * @returns {{ width: number, height: number, dpr: number, backingWidth: number, backingHeight: number }}
 */
export function resolveBackingMetrics(cssWidth, cssHeight, devicePixelRatio = 1, out = {}) {
  const width = sanitizeCssLength(cssWidth);
  const height = sanitizeCssLength(cssHeight);
  const requestedDpr = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const budgetDpr = Math.sqrt(MAX_BACKING_PIXELS / (width * height));
  const dpr = requestedDpr <= budgetDpr ? requestedDpr : budgetDpr;

  out.width = width;
  out.height = height;
  out.dpr = dpr;
  out.backingWidth = Math.max(MIN_CANVAS_SIZE_PX, Math.round(width * dpr));
  out.backingHeight = Math.max(MIN_CANVAS_SIZE_PX, Math.round(height * dpr));
  return out;
}

/**
 * Create a cached offscreen canvas controller for the static room layer.
 *
 * @param {object} [options]
 * @param {() => HTMLCanvasElement} [options.createCanvas] injectable canvas factory (fakes in Node tests)
 * @param {(ctx: CanvasRenderingContext2D, view: object, room: object|null) => void} [options.drawStatic]
 */
export function createStaticLayer({
  createCanvas = defaultCreateCanvas,
  drawStatic = defaultDrawStatic,
} = {}) {
  if (typeof createCanvas !== 'function') {
    throw new TypeError('createStaticLayer requires a createCanvas function');
  }
  if (typeof drawStatic !== 'function') {
    throw new TypeError('createStaticLayer requires a drawStatic function');
  }

  let canvas = null;
  let ctx = null;
  let built = false;
  let buildCount = 0;

  let lastCssWidth = 0;
  let lastCssHeight = 0;
  let lastDpr = 0;
  let lastBackingWidth = 0;
  let lastBackingHeight = 0;
  let lastHasRoom = false;
  let lastRoomId = null;
  let lastLayoutRevision = -1;
  let lastRoomWidth = 0;
  let lastRoomHeight = 0;

  // Reused across rebuilds so even a rebuild allocates no view wrapper.
  const renderView = {
    width: MIN_CANVAS_SIZE_PX,
    height: MIN_CANVAS_SIZE_PX,
    dpr: 1,
    backingWidth: MIN_CANVAS_SIZE_PX,
    backingHeight: MIN_CANVAS_SIZE_PX,
  };

  return {
    /**
     * Return the offscreen canvas holding the current static scene, rebuilding
     * it ONLY when backing size, effective DPR, room id, or layoutRevision
     * changed. Allocates nothing on cache hit.
     *
     * @param {{ width?: number, height?: number, canvasWidth?: number, canvasHeight?: number, dpr?: number }} view
     * @param {object|null} room
     * @returns {HTMLCanvasElement}
     */
    ensure(view, room) {
      const rawWidth = view?.width ?? view?.canvasWidth;
      const rawHeight = view?.height ?? view?.canvasHeight;
      const cssWidth = sanitizeCssLength(rawWidth);
      const cssHeight = sanitizeCssLength(rawHeight);
      const rawDpr = view?.dpr;
      const requestedDpr = typeof rawDpr === 'number' && Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
      const budgetDpr = Math.sqrt(MAX_BACKING_PIXELS / (cssWidth * cssHeight));
      const effectiveDpr = requestedDpr <= budgetDpr ? requestedDpr : budgetDpr;
      const backingWidth = Math.max(MIN_CANVAS_SIZE_PX, Math.round(cssWidth * effectiveDpr));
      const backingHeight = Math.max(MIN_CANVAS_SIZE_PX, Math.round(cssHeight * effectiveDpr));

      const hasRoom = room !== null && typeof room === 'object';
      const roomId = hasRoom ? room.roomId : null;
      const layoutRevision = hasRoom ? (room.layoutRevision ?? 1) : 0;
      const roomWidth = hasRoom ? room.width : 0;
      const roomHeight = hasRoom ? room.height : 0;

      if (
        built
        && canvas !== null
        && backingWidth === lastBackingWidth
        && backingHeight === lastBackingHeight
        && effectiveDpr === lastDpr
        && cssWidth === lastCssWidth
        && cssHeight === lastCssHeight
        && hasRoom === lastHasRoom
        && roomId === lastRoomId
        && layoutRevision === lastLayoutRevision
        && roomWidth === lastRoomWidth
        && roomHeight === lastRoomHeight
      ) {
        return canvas;
      }

      if (canvas === null) {
        canvas = createCanvas();
        ctx = canvas.getContext('2d');
        if (!ctx) {
          canvas = null;
          throw new Error('Static offscreen canvas returned a null 2D context');
        }
      }

      canvas.width = backingWidth;
      canvas.height = backingHeight;
      if (typeof ctx.setTransform === 'function') {
        ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);
      }

      renderView.width = cssWidth;
      renderView.height = cssHeight;
      renderView.dpr = effectiveDpr;
      renderView.backingWidth = backingWidth;
      renderView.backingHeight = backingHeight;

      drawStatic(ctx, renderView, hasRoom ? room : null);

      lastCssWidth = cssWidth;
      lastCssHeight = cssHeight;
      lastDpr = effectiveDpr;
      lastBackingWidth = backingWidth;
      lastBackingHeight = backingHeight;
      lastHasRoom = hasRoom;
      lastRoomId = roomId;
      lastLayoutRevision = layoutRevision;
      lastRoomWidth = roomWidth;
      lastRoomHeight = roomHeight;
      built = true;
      buildCount += 1;

      return canvas;
    },

    /** Release the offscreen canvas and shrink its backing store to 0x0. */
    destroy() {
      if (canvas !== null) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas = null;
      ctx = null;
      built = false;
      lastCssWidth = 0;
      lastCssHeight = 0;
      lastDpr = 0;
      lastBackingWidth = 0;
      lastBackingHeight = 0;
      lastHasRoom = false;
      lastRoomId = null;
      lastLayoutRevision = -1;
      lastRoomWidth = 0;
      lastRoomHeight = 0;
    },

    /** Current offscreen canvas, or null before first ensure / after destroy. */
    getCanvas() {
      return canvas;
    },

    /** Total number of static builds performed on this instance. */
    getBuildCount() {
      return buildCount;
    },

    /** Effective DPR of the currently cached backing store (0 if unbuilt). */
    getEffectiveDpr() {
      return lastDpr;
    },

    /** Backing dimensions of the currently cached layer. */
    getBackingSize() {
      return { backingWidth: lastBackingWidth, backingHeight: lastBackingHeight };
    },
  };
}

export default createStaticLayer;
