/**
 * Day 13 config validation: MAX_PEERS_PER_USER and PEER_DISCONNECT_RADIUS_PX.
 *
 * Every case is evaluated in a fresh Node process so the cached config module
 * (and any .env file) cannot hide a bad value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createMeshCheckPlan } from '../scripts/mesh-check.js';

const configHref = new URL('../src/config/index.js', import.meta.url).href;

function readProximity(env = {}) {
  const source = `import {config} from ${JSON.stringify(configHref)}; console.log(JSON.stringify(config.proximity));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function proximityOrThrow(env) {
  const result = readProximity(env);
  assert.equal(result.status, 0, `expected a valid config for ${JSON.stringify(env)}, got: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('mesh defaults: cap 8, drop radius 115 for a 100 px connect radius', () => {
  const proximity = proximityOrThrow({ PROXIMITY_RADIUS_PX: '100', PEER_DISCONNECT_RADIUS_PX: '', MAX_PEERS_PER_USER: '' });
  assert.equal(proximity.radiusPx, 100);
  assert.equal(proximity.peerDisconnectRadiusPx, 115);
  assert.equal(proximity.maxPeersPerUser, 8);
});

test('MAX_PEERS_PER_USER accepts 0 (unlimited) and positive integers only', () => {
  for (const valid of ['0', '1', '4', '64']) {
    const proximity = proximityOrThrow({ MAX_PEERS_PER_USER: valid });
    assert.equal(proximity.maxPeersPerUser, Number(valid), `MAX_PEERS_PER_USER=${valid}`);
  }
  for (const invalid of ['-1', '2.5', 'abc', '100001']) {
    const result = readProximity({ MAX_PEERS_PER_USER: invalid });
    assert.notEqual(result.status, 0, `MAX_PEERS_PER_USER=${invalid} must fail`);
    assert.match(result.stderr, /MAX_PEERS_PER_USER/);
  }
});

test('PEER_DISCONNECT_RADIUS_PX must stay between the connect radius and 3x it', () => {
  // equal to the radius is the documented Day 12 behaviour
  assert.equal(
    proximityOrThrow({ PROXIMITY_RADIUS_PX: '100', PEER_DISCONNECT_RADIUS_PX: '100' }).peerDisconnectRadiusPx,
    100,
  );
  // inclusive upper bound
  assert.equal(
    proximityOrThrow({ PROXIMITY_RADIUS_PX: '100', PEER_DISCONNECT_RADIUS_PX: '300' }).peerDisconnectRadiusPx,
    300,
  );
  // custom connect radius moves both bounds
  const custom = proximityOrThrow({ PROXIMITY_RADIUS_PX: '50', PEER_DISCONNECT_RADIUS_PX: '120' });
  assert.equal(custom.radiusPx, 50);
  assert.equal(custom.peerDisconnectRadiusPx, 120);
  assert.equal(
    proximityOrThrow({ PROXIMITY_RADIUS_PX: '50', PEER_DISCONNECT_RADIUS_PX: '' }).peerDisconnectRadiusPx,
    65,
    'default follows the configured radius',
  );

  for (const [radius, drop] of [['100', '99'], ['100', '301'], ['50', '49'], ['50', '151']]) {
    const result = readProximity({ PROXIMITY_RADIUS_PX: radius, PEER_DISCONNECT_RADIUS_PX: drop });
    assert.notEqual(result.status, 0, `radius=${radius} drop=${drop} must fail`);
    assert.match(result.stderr, /PEER_DISCONNECT_RADIUS_PX/);
  }
  for (const invalid of ['abc', 'NaN']) {
    const result = readProximity({ PEER_DISCONNECT_RADIUS_PX: invalid });
    assert.notEqual(result.status, 0, `PEER_DISCONNECT_RADIUS_PX=${invalid} must fail`);
    assert.match(result.stderr, /PEER_DISCONNECT_RADIUS_PX/);
  }
});

test('a radius of 0 keeps a valid (equal) default drop radius', () => {
  const proximity = proximityOrThrow({ PROXIMITY_RADIUS_PX: '0', PEER_DISCONNECT_RADIUS_PX: '' });
  assert.equal(proximity.radiusPx, 0);
  assert.equal(proximity.peerDisconnectRadiusPx, 0);
});

test('external mesh-check uses the exact existing room and never invents a before config', () => {
  const plan = createMeshCheckPlan({ external: true, roomSeed: 'lobby', maxPeers: 8, dropRadius: 115 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].roomId, 'lobby');
  assert.equal(plan[0].maxPeers, 8);
  assert.equal(plan[0].dropRadius, 115);
  assert.match(plan[0].label, /^current /);
});

test('embedded mesh-check retains separate after and before rooms/configurations', () => {
  const plan = createMeshCheckPlan({ external: false, roomSeed: 'mesh-test', maxPeers: 8, dropRadius: 115 });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((suite) => suite.roomId), ['mesh-test-after', 'mesh-test-before']);
  assert.deepEqual(plan.map((suite) => [suite.maxPeers, suite.dropRadius]), [[8, 115], [0, 100]]);
});
