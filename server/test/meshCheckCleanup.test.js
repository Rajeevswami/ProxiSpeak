import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { makeEmbeddedRunner } from '../scripts/mesh-check.js';

const execFileAsync = promisify(execFile);
const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();
const redisOpts = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST and provide redis-server to run the startup cleanup regression' };

test('failed cluster-node startup closes all three Redis clients', redisOpts, async () => {
  const harnessUrl = new URL('./helpers/twoInstanceHarness.js', import.meta.url).href;
  const redisModuleUrl = new URL('../node_modules/ioredis/built/index.js', import.meta.url).href;
  // Run the leak probe in a child so a regression can be killed by execFile's
  // timeout instead of leaving the main test runner alive with reconnecting clients.
  const source = `
    import Redis from ${JSON.stringify(redisModuleUrl)};
    import { getFreePort, spawnEphemeralRedisServer, startClusterNode, createMemoryLogger } from ${JSON.stringify(harnessUrl)};
    const port = await getFreePort();
    const server = await spawnEphemeralRedisServer(port);
    const observer = new Redis('redis://127.0.0.1:' + port, { lazyConnect: true });
    await observer.connect();
    const count = async () => Number((await observer.info('clients')).match(/connected_clients:(\\d+)/)?.[1]);
    let error = null;
    try {
      const before = await count();
      try {
        await startClusterNode({
          instanceId: 'failed-start-' + process.pid,
          redisUrl: 'redis://127.0.0.1:' + port,
          backing: null,
          logger: createMemoryLogger(),
        });
      } catch (err) { error = err?.message ?? String(err); }
      console.log(JSON.stringify({ before, after: await count(), error }));
    } finally {
      await observer.quit().catch(() => observer.disconnect(false));
      await server.killHard();
    }
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.before, 1, 'only the observer is connected initially');
  assert.match(report.error, /presence/);
  assert.equal(report.after, 1, 'startup failure leaves no Redis clients behind');
});

test('embedded mesh runner removes every throwaway room on stop', async () => {
  const keyPrefix = `mesh_rooms_${process.pid}`;
  const runner = await makeEmbeddedRunner({
    redisUrl: null,
    keyPrefix,
    maxPeers: 0,
    dropRadius: 115,
    baseRoom: `${keyPrefix}_base`,
  }).start();
  const expectedRooms = [`${keyPrefix}_10`, `${keyPrefix}_20`, `${keyPrefix}_boundary`];
  try {
    for (const roomId of expectedRooms) runner.ensureRoom(roomId);
    const rooms = await runner.listRooms();
    for (const roomId of expectedRooms) assert.ok(rooms.includes(roomId));
  } finally {
    await runner.stop();
  }
  assert.deepEqual(await runner.listRooms(), []);
});
