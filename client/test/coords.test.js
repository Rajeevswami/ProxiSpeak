import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BACKING_PIXELS,
  computeCanvasSize,
  computeViewport,
  screenToWorld,
  worldToScreen,
} from '../src/canvas/coords.js';

const EPS = 1e-9;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < EPS, `${actual} ~= ${expected}`);

test('computeViewport fits an exactly matching aspect ratio with no letterbox', () => {
  const vp = computeViewport(1920, 1080, 960, 540);
  near(vp.scale, 0.5);
  near(vp.offsetX, 0);
  near(vp.offsetY, 0);
  near(vp.drawnWidth, 960);
  near(vp.drawnHeight, 540);
});

test('computeViewport letterboxes vertically when the canvas is too tall', () => {
  const vp = computeViewport(1920, 1080, 960, 1080);
  near(vp.scale, 0.5); // limited by width
  near(vp.drawnWidth, 960);
  near(vp.drawnHeight, 540);
  near(vp.offsetX, 0);
  near(vp.offsetY, 270); // (1080 - 540) / 2
});

test('computeViewport letterboxes horizontally when the canvas is too wide', () => {
  const vp = computeViewport(1920, 1080, 1920, 540);
  near(vp.scale, 0.5); // limited by height
  near(vp.drawnWidth, 960);
  near(vp.drawnHeight, 540);
  near(vp.offsetX, 480); // (1920 - 960) / 2
  near(vp.offsetY, 0);
});

test('computeViewport scales up a small window and centres the room', () => {
  const vp = computeViewport(1920, 1080, 3840, 2160);
  near(vp.scale, 2);
  near(vp.offsetX, 0);
  near(vp.offsetY, 0);
});

test('worldToScreen maps room corners to the letterboxed floor corners', () => {
  const vp = computeViewport(1920, 1080, 1000, 1000);
  const topLeft = worldToScreen({ x: 0, y: 0 }, vp);
  const bottomRight = worldToScreen({ x: 1920, y: 1080 }, vp);
  near(topLeft.x, vp.offsetX);
  near(topLeft.y, vp.offsetY);
  near(bottomRight.x, vp.offsetX + vp.drawnWidth);
  near(bottomRight.y, vp.offsetY + vp.drawnHeight);
});

test('worldToScreen applies scale and offset', () => {
  const vp = computeViewport(1920, 1080, 1920, 540); // scale 0.5, offsetX 480
  const p = worldToScreen({ x: 200, y: 100 }, vp);
  near(p.x, 580);
  near(p.y, 50);
});

test('screenToWorld is the exact inverse of worldToScreen', () => {
  const vp = computeViewport(1920, 1080, 1366, 768);
  for (const point of [
    { x: 0, y: 0 },
    { x: 1920, y: 1080 },
    { x: 960, y: 540 },
    { x: 123.4, y: 987.6 },
  ]) {
    const roundTripped = screenToWorld(worldToScreen(point, vp), vp);
    near(roundTripped.x, point.x);
    near(roundTripped.y, point.y);
  }
});

test('screenToWorld maps the floor corners back to room corners', () => {
  const vp = computeViewport(800, 600, 400, 400); // scale 0.5, offsetY 50
  assert.deepEqual(screenToWorld({ x: 0, y: 50 }, vp), { x: 0, y: 0 });
  assert.deepEqual(screenToWorld({ x: 400, y: 350 }, vp), { x: 800, y: 600 });
});

test('computeViewport rejects non-positive or non-finite dimensions', () => {
  assert.throws(() => computeViewport(0, 1080, 960, 540), TypeError);
  assert.throws(() => computeViewport(1920, -1, 960, 540), TypeError);
  assert.throws(() => computeViewport(1920, 1080, Number.NaN, 540), TypeError);
  assert.throws(() => computeViewport(1920, 1080, 960, Number.POSITIVE_INFINITY), TypeError);
});

test('worldToScreen / screenToWorld reject non-finite points', () => {
  const vp = computeViewport(1920, 1080, 960, 540);
  assert.throws(() => worldToScreen({ x: Number.NaN, y: 0 }, vp), TypeError);
  assert.throws(() => screenToWorld({ x: 0 }, vp), TypeError);
});

test('computeCanvasSize keeps a broken window size drawable', () => {
  // A minimised window / hidden iframe reports 0 — the render loop must not
  // die on it, and the CSS size the renderer uses is never below 1 px.
  for (const [width, height] of [
    [0, 0],
    [0, 720],
    [-100, 400],
    [Number.NaN, 720],
    [Number.POSITIVE_INFINITY, 720],
    ['1280', null],
  ]) {
    const canvasSize = computeCanvasSize(width, height, 2);
    assert.ok(canvasSize.width >= 1, `width for ${width}`);
    assert.ok(canvasSize.height >= 1, `height for ${height}`);
    assert.ok(Number.isInteger(canvasSize.backingWidth) && canvasSize.backingWidth >= 1);
    assert.ok(Number.isInteger(canvasSize.backingHeight) && canvasSize.backingHeight >= 1);
    // Whatever size comes out of here must still be drawable.
    assert.doesNotThrow(() => computeViewport(1920, 1080, canvasSize.width, canvasSize.height));
  }
});

test('computeCanvasSize uses the device pixel ratio and sanitises it', () => {
  const retina = computeCanvasSize(1280, 720, 2);
  assert.equal(retina.width, 1280);
  assert.equal(retina.height, 720);
  assert.equal(retina.dpr, 2);
  assert.equal(retina.backingWidth, 2560);
  assert.equal(retina.backingHeight, 1440);

  const standard = computeCanvasSize(1280, 720, 1);
  assert.equal(standard.backingWidth, 1280);
  assert.equal(standard.backingHeight, 720);

  // A missing / broken devicePixelRatio falls back to 1, never to 0 or NaN.
  for (const dpr of [undefined, null, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const canvasSize = computeCanvasSize(1000, 500, dpr);
    assert.equal(canvasSize.dpr, 1, `dpr for ${dpr}`);
    assert.equal(canvasSize.backingWidth, 1000);
    assert.equal(canvasSize.backingHeight, 500);
  }
});

test('computeCanvasSize never asks for a backing store the browser refuses', () => {
  // 5120 x 1440 CSS px at DPR 2 is 29.5M device pixels — over Safari's budget,
  // where the canvas would simply stay blank.
  const ultrawide = computeCanvasSize(5120, 1440, 2);
  assert.ok(
    ultrawide.backingWidth * ultrawide.backingHeight <= MAX_BACKING_PIXELS,
    `${ultrawide.backingWidth}x${ultrawide.backingHeight} exceeds the budget`,
  );
  assert.ok(ultrawide.dpr > 1, 'a large window still gets more than one device pixel per CSS pixel');

  const eightK = computeCanvasSize(7680, 4320, 1);
  assert.ok(eightK.backingWidth * eightK.backingHeight <= MAX_BACKING_PIXELS);
  assert.equal(eightK.width, 7680, 'the CSS size the renderer works in is untouched');

  const absurd = computeCanvasSize(20000, 20000, 2);
  assert.ok(absurd.backingWidth * absurd.backingHeight <= MAX_BACKING_PIXELS);
  assert.ok(absurd.backingWidth >= 1 && absurd.backingHeight >= 1);
});

test('computeCanvasSize leaves ordinary windows at their full device pixel ratio', () => {
  for (const [width, height, dpr] of [
    [1920, 1080, 1],
    [1280, 720, 2], // retina laptop
    [1440, 900, 2],
    [2560, 1440, 2], // 14.7M device pixels: still inside the budget
  ]) {
    const canvasSize = computeCanvasSize(width, height, dpr);
    assert.equal(canvasSize.dpr, dpr, `dpr for ${width}x${height}@${dpr}`);
    assert.equal(canvasSize.backingWidth, width * dpr);
    assert.equal(canvasSize.backingHeight, height * dpr);
  }
});
