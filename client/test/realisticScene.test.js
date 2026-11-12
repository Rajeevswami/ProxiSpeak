import test from 'node:test';
import assert from 'node:assert/strict';

import { drawDynamic, drawStatic } from '../src/canvas/renderer.js';

function createBrowserMockCtx() {
  const calls = [];
  const gradientStub = {
    addColorStop(offset, color) {
      calls.push({ op: 'colorStop', offset, color });
    },
  };

  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clearRect(x, y, w, h) {
      calls.push({ op: 'clearRect', x, y, w, h });
    },
    fillRect(x, y, w, h) {
      calls.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle });
    },
    strokeRect(x, y, w, h) {
      calls.push({ op: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle });
    },
    beginPath() {
      calls.push({ op: 'beginPath' });
    },
    closePath() {
      calls.push({ op: 'closePath' });
    },
    moveTo(x, y) {
      calls.push({ op: 'moveTo', x, y });
    },
    lineTo(x, y) {
      calls.push({ op: 'lineTo', x, y });
    },
    quadraticCurveTo(cpx, cpy, x, y) {
      calls.push({ op: 'quadraticCurveTo', cpx, cpy, x, y });
    },
    arc(x, y, r, s, e) {
      calls.push({ op: 'arc', x, y, r, s, e });
    },
    ellipse(x, y, rx, ry, rot, s, e) {
      calls.push({ op: 'ellipse', x, y, rx, ry, rot, s, e });
    },
    fill() {
      calls.push({ op: 'fill', fillStyle: this.fillStyle });
    },
    stroke() {
      calls.push({ op: 'stroke', strokeStyle: this.strokeStyle });
    },
    clip() {
      calls.push({ op: 'clip' });
    },
    save() {
      calls.push({ op: 'save' });
    },
    restore() {
      calls.push({ op: 'restore' });
    },
    translate(x, y) {
      calls.push({ op: 'translate', x, y });
    },
    rotate(angle) {
      calls.push({ op: 'rotate', angle });
    },
    setLineDash(segments) {
      calls.push({ op: 'setLineDash', segments });
    },
    createLinearGradient() {
      calls.push({ op: 'createLinearGradient' });
      return gradientStub;
    },
    createRadialGradient() {
      calls.push({ op: 'createRadialGradient' });
      return gradientStub;
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    fillText(text, x, y) {
      calls.push({ op: 'fillText', text, x, y });
    },
  };
}

test('realistic static renderer draws 3D architectural floors, furniture, desks, walls, screens, pillars, and plants', () => {
  const ctx = createBrowserMockCtx();
  const room = {
    id: 'lounge',
    width: 2400,
    height: 1600,
    obstacles: [
      { id: 'w1', x: 500, y: 300, width: 80, height: 420, kind: 'wall' },
      { id: 'd1', x: 850, y: 260, width: 280, height: 140, kind: 'desk' },
      { id: 's1', x: 1400, y: 200, width: 320, height: 60, kind: 'screen' },
      { id: 'p1', x: 600, y: 1100, width: 120, height: 120, kind: 'pillar' },
      { id: 'pl1', x: 1700, y: 1100, width: 120, height: 120, kind: 'plant' },
    ],
  };

  const vp = drawStatic(ctx, { width: 1280, height: 720 }, room);
  assert.ok(vp && vp.scale > 0, 'returns computed viewport');
  assert.ok(ctx.calls.some((c) => c.op === 'createRadialGradient'), 'uses radial lighting gradients');
  assert.ok(ctx.calls.some((c) => c.op === 'createLinearGradient'), 'uses 3D surface linear gradients');
  assert.ok(ctx.calls.some((c) => c.op === 'ellipse'), 'draws 3D chairs, plant leaves, and pillars');
  assert.ok(
    ctx.calls.some((c) => c.op === 'fillText' && /LOUNGE/i.test(c.text)),
    'renders architectural room floor badge',
  );
});

test('realistic dynamic renderer draws animated human avatars and proximity acoustic wave tethers', () => {
  const ctx = createBrowserMockCtx();
  const room = { id: 'lounge', width: 2400, height: 1600, obstacles: [] };
  const vp = drawStatic(ctx, { width: 1280, height: 720 }, room);
  ctx.calls.length = 0;

  const world = {
    room,
    selfId: 'u1',
    users: new Map([
      ['u1', { id: 'u1', name: 'rajeev', x: 1000, y: 800, targetX: 1150, targetY: 820 }],
      ['u2', { id: 'u2', name: 'amit', x: 1220, y: 830, targetX: 1220, targetY: 830 }],
    ]),
  };

  drawDynamic(ctx, vp, world);

  assert.ok(ctx.calls.some((c) => c.op === 'ellipse'), 'draws human avatar torso, shoes, hands, and directional eyes');
  assert.ok(
    ctx.calls.some((c) => c.op === 'fillText' && c.text === 'rajeev (you)'),
    'draws floating glassmorphic nameplate for self',
  );
  assert.ok(
    ctx.calls.some((c) => c.op === 'fillText' && c.text === 'amit'),
    'draws floating glassmorphic nameplate for peer',
  );
});
