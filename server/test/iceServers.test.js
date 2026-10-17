/**
 * ICE_SERVERS parsing (Week 2, Day 8).
 *
 * The value is operator input: malformed JSON must never stop the server, it
 * must fall back to the one public STUN server with a loggable reason. TURN is
 * deliberately unsupported on Day 8 (no relay credentials exist yet).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DEFAULT_ICE_SERVERS, parseIceServers } from '../src/config/iceServers.js';

const configUrl = new URL('../src/config/index.js', import.meta.url).href;

test('unset and empty values use the default public STUN server', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const { servers, warning } = parseIceServers(raw);
    assert.deepEqual(servers, DEFAULT_ICE_SERVERS);
    assert.deepEqual(servers, [{ urls: 'stun:stun.l.google.com:19302' }]);
    assert.equal(warning, null);
  }
});

test('a valid JSON array is whitelisted to browser-relevant fields', () => {
  const { servers, warning } = parseIceServers(JSON.stringify([
    { urls: 'stun:stun.example.org:3478', extra: 'ignored' },
    { urls: ['stuns:secure.example.org', 'stun:backup.example.org'], username: 'u', credential: 'c' },
  ]));
  assert.equal(warning, null);
  assert.deepEqual(servers, [
    { urls: 'stun:stun.example.org:3478' },
    { urls: ['stuns:secure.example.org', 'stun:backup.example.org'], username: 'u', credential: 'c' },
  ]);
  assert.equal(Object.isFrozen(servers), true);
  assert.equal(Object.isFrozen(servers[0]), true);
});

test('malformed values fall back to the default with a clear warning', () => {
  const malformed = [
    '{not json',
    '"just a string"',
    '{}',
    '[]',
    '[null]',
    '[{}]',
    '[{"urls":[]}]',
    '[{"urls":"turn:turn.example.org:3478"}]',
    '[{"urls":["stun:ok.example.org","turn:relay.example.org"]}]',
    '[{"urls":"http://example.org"}]',
    '[{"urls":"stun:ok.example.org","username":42}]',
    JSON.stringify(Array.from({ length: 9 }, () => ({ urls: 'stun:a' }))),
    JSON.stringify([{ urls: Array.from({ length: 9 }, (_, i) => `stun:s${i}`) }]),
  ];
  for (const raw of malformed) {
    const { servers, warning } = parseIceServers(raw);
    assert.deepEqual(servers, DEFAULT_ICE_SERVERS, `fallback for ${raw.slice(0, 60)}`);
    assert.match(warning, /^ICE_SERVERS ignored \(/, 'a loggable reason is returned');
    assert.match(warning, /stun:stun\.l\.google\.com:19302/);
  }
});

test('the live config reads ICE_SERVERS, including a malformed fallback, without crashing', () => {
  const source = `import config from ${JSON.stringify(configUrl)};
    console.log(JSON.stringify({ iceServers: config.iceServers, warning: config.iceServersWarning }));`;

  const valid = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, ICE_SERVERS: '[{"urls":"stun:stun.custom.example:3478"}]' },
  });
  assert.equal(valid.status, 0, valid.stderr);
  const parsedValid = JSON.parse(valid.stdout.trim());
  assert.deepEqual(parsedValid.iceServers, [{ urls: 'stun:stun.custom.example:3478' }]);
  assert.equal(parsedValid.warning, null);

  const broken = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, ICE_SERVERS: '[{"urls":"turn:relay.example:3478"}]' },
  });
  assert.equal(broken.status, 0, 'a malformed ICE_SERVERS must not stop the boot');
  const parsedBroken = JSON.parse(broken.stdout.trim());
  assert.deepEqual(parsedBroken.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  assert.match(parsedBroken.warning, /ICE_SERVERS ignored/);
});
