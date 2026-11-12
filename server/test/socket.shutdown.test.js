import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSocketServer } from '../src/sockets/index.js';
import { createLogger } from '../src/utils/logger.js';

test('shutdown drain waits for in-flight peer graph syncs before backing stores close', async () => {
  const httpServer = http.createServer();
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise((resolve) => { markQueryStarted = resolve; });
  const queryGate = new Promise((resolve) => { releaseQuery = resolve; });
  const io = createSocketServer({
    httpServer,
    logger: createLogger('error'),
    findNearby: async () => {
      markQueryStarted();
      await queryGate;
      return [];
    },
  });

  io.peerGraph.register('lobby', 'alice');
  const syncing = io.peerGraph.sync('lobby', 'alice');
  await queryStarted;

  let drained = false;
  const draining = io.drainSessions().then(() => { drained = true; });
  await Promise.resolve();
  const drainedBeforeQueryFinished = drained;

  releaseQuery();
  await Promise.all([syncing, draining]);
  await new Promise((resolve) => io.close(resolve));

  assert.equal(drainedBeforeQueryFinished, false, 'drainSessions returned while a sync was still using the stores');
});
