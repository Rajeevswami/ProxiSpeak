/**
 * Pure world <-> screen coordinate helpers (no React, no DOM, no canvas).
 *
 * The room is a fixed pixel plane (e.g. 1920x1080 from the server's
 * `joined` payload). The canvas is whatever size the window happens to
 * be. These helpers fit the whole room into the canvas with
 * letterboxing: one uniform scale, centred, empty bands on the sides
 * or top/bottom when the aspect ratios differ — never stretched.
 */

function requirePositiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number, got ${value}`);
  }
}

/** A canvas is never zero-sized: 1 x 1 is the smallest thing we draw on. */
export const MIN_CANVAS_SIZE_PX = 1;

/**
 * Largest canvas backing store we ever ask for, in device pixels (~16M).
 * Browsers silently refuse to draw on a canvas above their per-canvas pixel
 * budget — Safari caps at roughly 16.7M pixels — and a refused canvas stays
 * blank for the whole session. A very large window (a 4K/5K display, an
 * ultrawide, or a maximised window on a high-DPR screen) can reach that budget
 * on its own: 5120 x 1440 CSS px at DPR 2 is already 29.5M device pixels.
 */
export const MAX_BACKING_PIXELS = 16_000_000;

/**
 * Translate the browser's window/DPR numbers into a canvas backing store.
 *
 * `window.innerWidth` / `innerHeight` are not guaranteed to be usable numbers:
 * a minimised window, a `display: none` iframe or a window collapsed by the OS
 * can report 0 (and a broken embed can report NaN). Handing that straight to
 * `computeViewport` would throw inside the animation frame, and a throw inside
 * the frame callback kills the render loop for good — the canvas would stay
 * blank forever. Every value is therefore sanitised here, and the CSS size the
 * rest of the renderer works in is always at least 1 px.
 *
 * When the requested backing store would exceed MAX_BACKING_PIXELS the device
 * pixel ratio is reduced just enough to fit, so the room stays visible (slightly
 * softer) instead of the canvas going blank. Ordinary windows are untouched:
 * 2560x1440 at DPR 2 is 14.7M pixels and keeps its full ratio.
 *
 * @param {number} cssWidth window width in CSS pixels
 * @param {number} cssHeight window height in CSS pixels
 * @param {number} [devicePixelRatio] window.devicePixelRatio
 * @returns {{width:number,height:number,dpr:number,backingWidth:number,backingHeight:number}}
 */
export function computeCanvasSize(cssWidth, cssHeight, devicePixelRatio = 1) {
  const width = sanitizeLength(cssWidth);
  const height = sanitizeLength(cssHeight);
  const requestedDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // sqrt keeps the *area* inside the budget while preserving the aspect ratio.
  const budgetDpr = Math.sqrt(MAX_BACKING_PIXELS / (width * height));
  const dpr = Math.min(requestedDpr, budgetDpr);

  return {
    width,
    height,
    dpr,
    backingWidth: Math.max(MIN_CANVAS_SIZE_PX, Math.round(width * dpr)),
    backingHeight: Math.max(MIN_CANVAS_SIZE_PX, Math.round(height * dpr)),
  };
}

/** A window dimension that is finite and positive, else the 1 px minimum. */
function sanitizeLength(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : MIN_CANVAS_SIZE_PX;
}

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${value}`);
  }
}

/**
 * Fit a room of (roomWidth x roomHeight) into a canvas of
 * (canvasWidth x canvasHeight) CSS pixels.
 *
 * @returns {{ scale: number, offsetX: number, offsetY: number,
 *             drawnWidth: number, drawnHeight: number,
 *             roomWidth: number, roomHeight: number,
 *             canvasWidth: number, canvasHeight: number }}
 */
export function computeViewport(roomWidth, roomHeight, canvasWidth, canvasHeight) {
  requirePositiveFinite(roomWidth, 'roomWidth');
  requirePositiveFinite(roomHeight, 'roomHeight');
  requirePositiveFinite(canvasWidth, 'canvasWidth');
  requirePositiveFinite(canvasHeight, 'canvasHeight');

  const scale = Math.min(canvasWidth / roomWidth, canvasHeight / roomHeight);
  const drawnWidth = roomWidth * scale;
  const drawnHeight = roomHeight * scale;

  return {
    scale,
    offsetX: (canvasWidth - drawnWidth) / 2,
    offsetY: (canvasHeight - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
    roomWidth,
    roomHeight,
    canvasWidth,
    canvasHeight,
  };
}

/** World (room pixel) coordinates -> screen (canvas CSS pixel) coordinates. */
export function worldToScreen(point, viewport) {
  requireFinite(point?.x, 'point.x');
  requireFinite(point?.y, 'point.y');
  return {
    x: viewport.offsetX + point.x * viewport.scale,
    y: viewport.offsetY + point.y * viewport.scale,
  };
}

/** Screen (canvas CSS pixel) coordinates -> world (room pixel) coordinates. Inverse of worldToScreen. */
export function screenToWorld(point, viewport) {
  requireFinite(point?.x, 'point.x');
  requireFinite(point?.y, 'point.y');
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  };
}

export default computeViewport;
