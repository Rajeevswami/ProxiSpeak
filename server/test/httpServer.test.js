/**
 * Boot-time listen errors (Day 6). A busy port is the most common local
 * mistake, and it used to surface as an unhandled 'error' event with a stack
 * trace from node:net. These tests use real servers on ephemeral ports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { listenOn } from '../src/utils/httpServer.js';

const close = (server) => new Promise((resolve) => server.close(resolve));

test('listenOn resolves once the server accepts connections', async () => {
  const server = http.createServer();
  await listenOn(server, { port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  assert.ok(port > 0, `bound to an ephemeral port (${port})`);
  assert.equal(server.listenerCount('error'), 0, 'the temporary handler is removed again');
  await close(server);
});

test('a busy port is rejected with one actionable line, not a stack trace', async () => {
  const first = http.createServer();
  await listenOn(first, { port: 0, host: '127.0.0.1' });
  const { port } = first.address();

  const second = http.createServer();
  await assert.rejects(
    listenOn(second, { port, host: '127.0.0.1' }),
    (err) => {
      assert.match(err.message, /cannot listen on 127\.0\.0\.1:\d+/);
      assert.match(err.message, /EADDRINUSE/);
      assert.match(err.message, /change PORT/);
      return true;
    },
  );
  await close(first);
});
