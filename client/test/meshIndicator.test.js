/**
 * Day 13 client mesh indicator: pure functions only (no React, no DOM).
 *
 * The overlay counts, from the client's own known avatar positions, how many
 * remote users are inside the connect radius but have no live peer connection
 * ("M nearby, not connected (cap)"). No protocol change: `connected` comes from
 * the existing peer-manager snapshot, positions from the existing world ref.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { countNearbyNotConnected, formatMeshSummary } from '../src/realtime/meshIndicator.js';

const person = (x, y) => ({ x, y });

function world(entries) {
  return new Map(Object.entries(entries));
}

test('counts only remote users inside the radius WITHOUT a live connection', () => {
  const users = world({
    self: person(500, 500),
    near_connected: person(560, 500), // 60 px, connected
    near_capped: person(440, 500), // 60 px, not connected
    near_capped_2: person(500, 590), // 90 px, not connected
    far: person(700, 500), // 200 px, not connected
  });
  const count = countNearbyNotConnected({
    users,
    selfId: 'self',
    connectedIds: new Set(['near_connected']),
    radiusPx: 100,
  });
  assert.equal(count, 2);
});

test('the boundary is inclusive at exactly the connect radius', () => {
  const users = world({ self: person(0, 0), edge: person(100, 0), just_out: person(100.5, 0) });
  assert.equal(countNearbyNotConnected({ users, selfId: 'self', connectedIds: [], radiusPx: 100 }), 1);
});

test('never counts self, unknown self or malformed positions', () => {
  const users = world({ self: person(0, 0), ghost: { x: Number.NaN, y: 10 }, ok: person(10, 0) });
  assert.equal(countNearbyNotConnected({ users, selfId: 'self', connectedIds: [], radiusPx: 100 }), 1);
  assert.equal(countNearbyNotConnected({ users, selfId: 'missing', connectedIds: [], radiusPx: 100 }), 0);
  assert.equal(countNearbyNotConnected({ users: null, selfId: 'self', connectedIds: [], radiusPx: 100 }), 0);
  assert.equal(countNearbyNotConnected({ users, selfId: 'self', connectedIds: [], radiusPx: Number.NaN }), 0);
});

test('connected ids may arrive as an array (plain data, no Set requirement)', () => {
  const users = world({ self: person(0, 0), a: person(10, 0), b: person(20, 0) });
  assert.equal(countNearbyNotConnected({ users, selfId: 'self', connectedIds: ['a', 'b'], radiusPx: 100 }), 0);
  assert.equal(countNearbyNotConnected({ users, selfId: 'self', connectedIds: ['a'], radiusPx: 100 }), 1);
});

test('summary text: connected N / max, and the cap note only when somebody is waiting', () => {
  assert.equal(formatMeshSummary({ connected: 2, maxPeers: 8, nearbyNotConnected: 0 }), 'connected 2 / 8');
  assert.equal(
    formatMeshSummary({ connected: 2, maxPeers: 8, nearbyNotConnected: 3 }),
    'connected 2 / 8 · 3 nearby, not connected (cap)',
  );
});

test('summary text: cap 0 is unlimited, malformed values fall back to safe defaults', () => {
  assert.equal(formatMeshSummary({ connected: 5, maxPeers: 0, nearbyNotConnected: 0 }), 'connected 5 / ∞');
  assert.equal(formatMeshSummary({}), 'connected 0 / 8');
  assert.equal(formatMeshSummary(), 'connected 0 / 8');
  assert.equal(
    formatMeshSummary({ connected: -3, maxPeers: -1, nearbyNotConnected: -2 }),
    'connected 0 / 8',
  );
});
