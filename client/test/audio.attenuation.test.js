import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceBetween, gainForDistance } from '../src/audio/attenuation.js';

test('gainForDistance is full through the inner radius and silent at and beyond the outer radius', () => {
  assert.equal(gainForDistance(0), 1);
  assert.equal(gainForDistance(30), 1);
  assert.equal(gainForDistance(100), 0);
  assert.equal(gainForDistance(150), 0);
  assert.equal(gainForDistance(65), 0.5, 'smoothstep midpoint has half gain');
});

test('gain curve remains bounded, monotonic and continuous in a dense sweep', () => {
  let previous = gainForDistance(0);
  for (let distance = 0.5; distance <= 150; distance += 0.5) {
    const gain = gainForDistance(distance);
    assert.ok(gain >= 0 && gain <= 1, `${distance}px gain ${gain} is bounded`);
    assert.ok(gain <= previous, `${distance}px must not be louder than ${distance - 0.5}px`);
    assert.ok(Math.abs(gain - previous) <= 0.02, `${distance}px has no audible-sized step`);
    previous = gain;
  }
});

test('invalid distances return silence; degenerate radii never produce NaN', () => {
  for (const distance of [NaN, -1, Infinity, -Infinity, '15', null, undefined, {}]) {
    assert.equal(gainForDistance(distance), 0);
  }
  assert.equal(gainForDistance(5, { innerPx: 30, outerPx: 20 }), 1);
  assert.equal(gainForDistance(31, { innerPx: 30, outerPx: 20 }), 0);
  assert.ok(!Number.isNaN(gainForDistance(20, { innerPx: 30, outerPx: 20 })));
  assert.equal(gainForDistance(20, null), 0);
  assert.equal(gainForDistance(20, { innerPx: Infinity, outerPx: 100 }), 0);
});

test('distanceBetween uses symmetric Euclidean world-pixel distance', () => {
  const a = { x: 2, y: -3 };
  const b = { x: 5, y: 1 };
  assert.equal(distanceBetween(a, b), 5);
  assert.equal(distanceBetween(a, b), distanceBetween(b, a));
  assert.ok(Number.isNaN(distanceBetween(a, null)));
});
