import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Import in a fresh process so cached env/config cannot hide a bad value.
test('presence config rejects overflowing intervals and unusable timeouts', () => {
  const source = `import {config} from ${JSON.stringify(new URL('../src/config/index.js', import.meta.url).href)};`;
  for (const key of ['PRESENCE_CLEANUP_INTERVAL_MS', 'PRESENCE_TIMEOUT_MS']) {
    for (const value of ['2147483648', '1e100', 'NaN', '-1', '0']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', env: { ...process.env, [key]: value },
      });
      assert.notEqual(result.status, 0, `${key}=${value} must fail`);
      assert.match(result.stderr, new RegExp(key));
    }
  }
});
