import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const configHref = new URL('../src/config/index.js', import.meta.url).href;

// Import in a fresh process so cached env/config cannot hide a bad value.
test('presence and edge sweep config rejects overflowing intervals and unusable timeouts', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  for (const key of ['PRESENCE_CLEANUP_INTERVAL_MS', 'PRESENCE_TIMEOUT_MS', 'EDGE_SWEEP_INTERVAL_MS']) {
    for (const value of ['2147483648', '1e100', 'NaN', '-1', '0']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', env: { ...process.env, [key]: value },
      });
      assert.notEqual(result.status, 0, `${key}=${value} must fail`);
      assert.match(result.stderr, new RegExp(key));
    }
  }
});

test('INSTANCE_ID defaults to a unique random id per process and honours explicit overrides', () => {
  const printId = `import {config} from ${JSON.stringify(configHref)}; console.log(config.server.instanceId);`;
  const envWithoutId = { ...process.env };
  delete envWithoutId.INSTANCE_ID;

  const first = spawnSync(process.execPath, ['--input-type=module', '-e', printId], {
    encoding: 'utf8', env: envWithoutId,
  });
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', printId], {
    encoding: 'utf8', env: envWithoutId,
  });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.notEqual(first.stdout.trim(), second.stdout.trim(), 'two default boots get distinct random instance ids');

  const explicit = spawnSync(process.execPath, ['--input-type=module', '-e', printId], {
    encoding: 'utf8', env: { ...envWithoutId, INSTANCE_ID: 'office-node-7' },
  });
  assert.equal(explicit.status, 0);
  assert.equal(explicit.stdout.trim(), 'office-node-7');

  for (const badPrefix of ['bad prefix', 'bad*prefix', '../escape', 'app:prod', 'p'.repeat(49)]) {
    const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', printId], {
      encoding: 'utf8', env: { ...envWithoutId, REDIS_KEY_PREFIX: badPrefix },
    });
    assert.notEqual(invalid.status, 0, `REDIS_KEY_PREFIX="${badPrefix}" must fail`);
  }
});

test('scaleCheck config exposes non-empty default URLs for bare npm run scale-check', () => {
  const printScale = `import {config} from ${JSON.stringify(configHref)}; console.log(JSON.stringify(config.scaleCheck));`;
  const envClean = { ...process.env };
  delete envClean.SCALE_CHECK_URL_1;
  delete envClean.SCALE_CHECK_URL_2;
  delete envClean.SCALE_CHECK_URL_A;
  delete envClean.SCALE_CHECK_URL_B;

  const res = spawnSync(process.execPath, ['--input-type=module', '-e', printScale], {
    encoding: 'utf8', env: envClean,
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.urlA, 'http://127.0.0.1:4000');
  assert.equal(parsed.urlB, 'http://127.0.0.1:4001');
  assert.equal(parsed.url1, 'http://127.0.0.1:4000');
  assert.equal(parsed.url2, 'http://127.0.0.1:4001');
});

test('MAX_PEERS_PER_USER rejects non-integer and out-of-range values', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  for (const value of ['1.5', 'abc', '-1', '200000']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, MAX_PEERS_PER_USER: value },
    });
    assert.notEqual(result.status, 0, `MAX_PEERS_PER_USER=${value} must fail`);
    assert.match(result.stderr, /MAX_PEERS_PER_USER/);
  }
});

test('PEER_DISCONNECT_RADIUS_PX rejects values outside the valid hysteresis band', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  // Default PROXIMITY_RADIUS_PX=100, so valid range is [100, 300].
  for (const value of ['50', '301', 'NaN', 'abc']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, PEER_DISCONNECT_RADIUS_PX: value },
    });
    assert.notEqual(result.status, 0, `PEER_DISCONNECT_RADIUS_PX=${value} must fail`);
    assert.match(result.stderr, /PEER_DISCONNECT_RADIUS_PX/);
  }
});

test('socket rate limit settings reject non-numeric and out-of-range values', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  const socketKeys = ['SOCKET_MOVE_EPS', 'SOCKET_MAX_STEP_PX', 'SOCKET_SIGNAL_EPS', 'SOCKET_SIGNAL_BURST'];
  for (const key of socketKeys) {
    for (const value of ['abc', '0', '-5']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', env: { ...process.env, [key]: value },
      });
      assert.notEqual(result.status, 0, `${key}=${value} must fail`);
      assert.match(result.stderr, new RegExp(key));
    }
  }
});

test('AUDIT_TARGET_MS rejects non-numeric and out-of-range values', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  for (const value of ['abc', '0', '-1', '100000']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, AUDIT_TARGET_MS: value },
    });
    assert.notEqual(result.status, 0, `AUDIT_TARGET_MS=${value} must fail`);
    assert.match(result.stderr, /AUDIT_TARGET_MS/);
  }
});

test('Redis config rejects invalid timeouts and TTLs', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  for (const key of ['REDIS_CONNECT_TIMEOUT_MS', 'REDIS_EDGE_TTL_SECONDS']) {
    for (const value of ['abc', '0', '-1']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', env: { ...process.env, [key]: value },
      });
      assert.notEqual(result.status, 0, `${key}=${value} must fail`);
      assert.match(result.stderr, new RegExp(key));
    }
  }
});

test('MONGO_TIMEOUT_MS rejects non-numeric and too-small values', () => {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  for (const value of ['abc', '100', '-1']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, MONGO_TIMEOUT_MS: value },
    });
    assert.notEqual(result.status, 0, `MONGO_TIMEOUT_MS=${value} must fail`);
    assert.match(result.stderr, /MONGO_TIMEOUT_MS/);
  }
});

function assertOneLineConfigError(key, value, { secret = null } = {}) {
  const source = `import {config} from ${JSON.stringify(configHref)};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, [key]: value },
  });
  assert.notEqual(result.status, 0, `${key}=${value} must fail`);
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1, `${key} must print one error line, got:\n${result.stderr}`);
  assert.match(lines[0], new RegExp(key));
  assert.doesNotMatch(result.stderr, /node:internal|Node\.js v|\bat (?:num|integer|checkedUrl|file:)/);
  assert.equal(result.stdout, '');
  if (secret) assert.equal(result.stderr.includes(secret), false, 'credentials must not be echoed');
}

test('AUDIT_ENABLED accepts explicit booleans and rejects every other value in one line', () => {
  const printAudit = `import {config} from ${JSON.stringify(configHref)}; console.log(config.audit.enabled);`;
  for (const [raw, expected] of [['1', true], ['true', true], ['YES', true], ['0', false], ['false', false], ['no', false]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', printAudit], {
      encoding: 'utf8', env: { ...process.env, AUDIT_ENABLED: raw },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(expected));
  }
  for (const value of ['maybe', '2', 'off', 'truthy']) assertOneLineConfigError('AUDIT_ENABLED', value);
});

test('URL settings reject malformed values and wrong protocols without echoing credentials', () => {
  const secret = 'NeverPrintThisCredential_42';
  assertOneLineConfigError('MONGO_URI', `https://alice:${secret}@mongo.example.com/db`, { secret });
  assertOneLineConfigError('MONGO_URI', 'not a mongo url');
  assertOneLineConfigError('REDIS_URL', `https://alice:${secret}@redis.example.com/0`, { secret });
  assertOneLineConfigError('REDIS_URL', 'redis://');
  for (const key of ['SCALE_CHECK_URL_1', 'SCALE_CHECK_URL_2', 'SCALE_CHECK_URL_A', 'SCALE_CHECK_URL_B']) {
    assertOneLineConfigError(key, `ftp://alice:${secret}@node.example.com`, { secret });
  }
  assertOneLineConfigError('CLIENT_URL', `http://alice:${secret}@client.example.com`, { secret });
  assertOneLineConfigError('CLIENT_URL', 'http://client.example.com/a-path');
});

test('CLIENT_URL accepts wildcards and normalizes URL origins', () => {
  const printOrigins = `import {config} from ${JSON.stringify(configHref)}; console.log(JSON.stringify(config.server.clientOrigins));`;
  for (const [raw, expected] of [
    ['*', ['*']],
    ['HTTP://LOCALHOST:5173/', ['http://localhost:5173']],
    ['http://localhost:5173, https://voice.example.com', ['http://localhost:5173', 'https://voice.example.com']],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', printOrigins], {
      encoding: 'utf8', env: { ...process.env, CLIENT_URL: raw },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  }
});

test('integer-valued settings reject fractions and extreme timeouts with one clear line', () => {
  for (const [key, value] of [
    ['PORT', '4000.5'],
    ['MONGO_TIMEOUT_MS', '8000.5'],
    ['MONGO_TIMEOUT_MS', '1e100'],
    ['PRESENCE_CLEANUP_INTERVAL_MS', '1.5'],
    ['PRESENCE_TIMEOUT_MS', '1.5'],
    ['EDGE_SWEEP_INTERVAL_MS', '1.5'],
    ['REDIS_CONNECT_TIMEOUT_MS', '3000.5'],
    ['REDIS_EDGE_TTL_SECONDS', '60.5'],
    ['SOCKET_SIGNAL_BURST', '2.5'],
    ['REDIS_KEY_PREFIX', 'bad prefix'],
    ['ROOM_LAYOUT_MAX_OBSTACLES', '200.5'],
    ['ROOM_LAYOUT_MAX_OBSTACLES', '0'],
  ]) assertOneLineConfigError(key, value);
});
