/**
 * Renderer tests (Day 6). `client/src/canvas/renderer.js` is the one Week 1
 * module that is pure canvas drawing, so it is tested against a recording 2D
 * context instead of a real canvas: no DOM, no headless browser, no new
 * dependency. The assertions are about *what* gets drawn where — the geometry
 * is the part that silently breaks when the viewport maths changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OBSTACLE_COLORS,
  avatarColor,
  avatarLabel,
  drawAvatars,
  drawRoom,
  drawWorld,
  obstacleColor,
  truncateLabel,
} from '../src/canvas/renderer.js';
import { computeViewport } from '../src/canvas/coords.js';

/** Minimal recording 2D context: only the API the renderer actually uses. */
function createRecordingContext() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  };
  const record =
    (name) =>
    (...args) =>
      calls.push({ name, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha });

  for (const name of ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'fillText', 'strokeText']) {
    ctx[name] = record(name);
  }
  ctx.countOf = (name) => calls.filter((call) => call.name === name).length;
  ctx.callsOf = (name) => calls.filter((call) => call.name === name);
  return ctx;
}

const room = {
  roomId: 'lobby',
  name: 'Lobby',
  width: 1920,
  height: 1080,
  obstacles: [
    { id: 'wall-core', type: 'wall', x: 940, y: 390, w: 40, h: 300, blocksAudio: true, attenuation: 0.12 },
    { id: 'plant-1', type: 'plant', x: 1600, y: 700, w: 26, h: 26, blocksAudio: true, attenuation: 0.65 },
  ],
};

const world = (users = [], selfId = null) => ({ room, users: new Map(users.map((u) => [u.id, u])), selfId, epoch: 1 });

test('an empty world paints the backdrop and nothing else', () => {
  const ctx = createRecordingContext();
  assert.equal(drawWorld(ctx, { room: null, users: new Map(), selfId: null }, { width: 800, height: 600 }), null);
  assert.equal(ctx.countOf('clearRect'), 1);
  assert.equal(ctx.countOf('fillRect'), 1, 'only the letterbox backdrop');
  assert.equal(ctx.countOf('arc'), 0);
});

test('the room is drawn letterboxed, floor first and obstacles inside it', () => {
  const ctx = createRecordingContext();
  const size = { width: 800, height: 600 };
  const viewport = drawRoom(ctx, { room }, size);

  assert.deepEqual(viewport, computeViewport(1920, 1080, 800, 600));
  const [backdrop, floor] = ctx.callsOf('fillRect');
  assert.deepEqual(backdrop.args, [0, 0, size.width, size.height], 'the letterbox bands are painted first');
  assert.deepEqual(floor.args, [viewport.offsetX, viewport.offsetY, viewport.drawnWidth, viewport.drawnHeight]);

  // Grid lines stay inside the floor.
  for (const line of [...ctx.callsOf('moveTo'), ...ctx.callsOf('lineTo')]) {
    assert.ok(line.args[0] >= viewport.offsetX - 0.001 && line.args[0] <= viewport.offsetX + viewport.drawnWidth + 0.001);
    assert.ok(line.args[1] >= viewport.offsetY - 0.001 && line.args[1] <= viewport.offsetY + viewport.drawnHeight + 0.001);
  }

  // One filled + stroked rectangle per obstacle, in the room's own order.
  const obstacleFills = ctx.callsOf('fillRect').slice(2);
  assert.equal(obstacleFills.length, room.obstacles.length);
  assert.equal(obstacleFills[0].fillStyle, OBSTACLE_COLORS.wall);
  assert.equal(obstacleFills[1].fillStyle, OBSTACLE_COLORS.plant);
  assert.deepEqual(obstacleFills[0].args.map(Math.round), [
    Math.round(viewport.offsetX + 940 * viewport.scale),
    Math.round(viewport.offsetY + 390 * viewport.scale),
    Math.round(40 * viewport.scale),
    Math.round(300 * viewport.scale),
  ]);
  assert.equal(ctx.countOf('strokeRect'), 1 + room.obstacles.length, 'floor border + obstacle outlines');
});

test('a tiny window keeps the room visible and skips unreadable obstacle labels', () => {
  const ctx = createRecordingContext();
  const viewport = drawRoom(ctx, { room }, { width: 200, height: 120 });

  assert.ok(viewport.scale > 0 && viewport.scale <= 0.25, `scale ${viewport.scale}`);
  assert.equal(ctx.countOf('strokeRect'), 1 + room.obstacles.length);
  assert.equal(ctx.countOf('fillText'), 0, 'obstacle labels are unreadable at this scale');
});

test('an unknown obstacle type falls back to the neutral colour', () => {
  assert.equal(obstacleColor('wall'), OBSTACLE_COLORS.wall);
  assert.equal(obstacleColor('sofa'), '#6b7280');
  assert.equal(obstacleColor(undefined), '#6b7280');
});

test('avatars are drawn as labelled circles and non-finite ones are skipped', () => {
  const ctx = createRecordingContext();
  const viewport = computeViewport(1920, 1080, 800, 600);
  const users = [
    { id: 'conn-1', name: 'Ada', x: 100, y: 100 },
    { id: 'conn-2', name: 'Bob', x: 900, y: 500 },
    { id: 'conn-3', name: 'Broken', x: Number.NaN, y: 10 },
  ];

  drawAvatars(ctx, world(users, 'conn-1'), viewport);

  assert.equal(ctx.countOf('arc'), 3, 'both avatars, plus the highlight ring around the local one');
  // Per avatar: the initial inside the circle, then the label above it (which
  // is stroked first so it stays readable over the floor and other avatars).
  assert.deepEqual(
    ctx.callsOf('fillText').map((call) => call.args[0]),
    ['A', 'Ada (you)', 'B', 'Bob'],
  );
  assert.deepEqual(
    ctx.callsOf('strokeText').map((call) => call.args[0]),
    ['Ada (you)', 'Bob'],
  );
});

test('each avatar is centred on its own position (no shared scratch point)', () => {
  const ctx = createRecordingContext();
  const viewport = computeViewport(1920, 1080, 800, 600);
  drawAvatars(ctx, world([{ id: 'a', name: 'Ada', x: 0, y: 0 }, { id: 'b', name: 'Bob', x: 1920, y: 1080 }], null), viewport);

  const centres = ctx.callsOf('arc').map((call) => [call.args[0], call.args[1]]);
  const distinct = new Set(centres.map(([x, y]) => `${x.toFixed(1)}:${y.toFixed(1)}`));
  assert.equal(distinct.size, 2, `distinct avatar centres, got ${[...distinct]}`);
  assert.deepEqual(centres[0], [viewport.offsetX, viewport.offsetY], 'the first avatar sits on the room origin');
});

test('the renderer survives a world without a room and a null viewport', () => {
  const ctx = createRecordingContext();
  assert.doesNotThrow(() => drawAvatars(ctx, world([{ id: 'a', name: 'Ada', x: 1, y: 1 }]), null));
  assert.equal(ctx.countOf('arc'), 0);
  assert.doesNotThrow(() => drawRoom(ctx, {}, { width: 100, height: 100 }));
  assert.doesNotThrow(() => drawRoom(ctx, null, { width: 100, height: 100 }));
});

test('avatar colours are stable per identity and well spread', () => {
  const colors = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => avatarColor({ id, name: id }));
  assert.equal(avatarColor({ id: 'a', name: 'Ada' }), avatarColor({ id: 'a', name: 'Ada' }));
  assert.ok(new Set(colors).size >= 4, `expected a spread of colours, got ${[...new Set(colors)]}`);
  assert.match(avatarColor({}), /^#[0-9a-f]{6}$/i, 'a user without an id or name still gets a colour');
});

test('labels fall back to a short id tag and are truncated', () => {
  assert.equal(avatarLabel({ id: 'abcdef', name: 'Ada' }, 'abcdef'), 'Ada');
  assert.equal(avatarLabel({ id: 'abcdef' }, 'abcdef'), 'you');
  assert.equal(avatarLabel({ id: 'abcdef' }, 'other'), 'user-abcd');
  assert.equal(avatarLabel({}, null), 'guest');

  assert.equal(truncateLabel('Ada'), 'Ada');
  assert.equal(truncateLabel('x'.repeat(18)), 'x'.repeat(18));
  assert.equal(truncateLabel('x'.repeat(19)), `${'x'.repeat(17)}…`);
  assert.equal(truncateLabel(''), '');
  assert.equal(truncateLabel(undefined), '');
});
