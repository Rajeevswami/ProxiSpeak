/**
 * Server-URL resolution (Day 6). Three lines of precedence, one module, and the
 * only place in the client that may hardcode a server address — worth pinning
 * down because a wrong value here looks like "the server is down".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SERVER_URL, resolveServerUrl } from '../src/config.js';

test('VITE_SERVER_URL wins over the dev default', () => {
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: 'http://10.0.0.5:4000', DEV: true }), 'http://10.0.0.5:4000');
});

test('a trailing slash is stripped and surrounding spaces ignored', () => {
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: 'http://10.0.0.5:4000/', DEV: true }), 'http://10.0.0.5:4000');
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: ' http://10.0.0.5:4000/// ', DEV: true }), 'http://10.0.0.5:4000');
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: 'https://voice.example.com', DEV: false }), 'https://voice.example.com');
});

test('an empty or non-string override falls through to the default', () => {
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: '', DEV: true }), 'http://localhost:4000');
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: '   ', DEV: true }), 'http://localhost:4000');
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: 42, DEV: true }), 'http://localhost:4000');
  assert.equal(resolveServerUrl({ VITE_SERVER_URL: null, DEV: true }), 'http://localhost:4000');
});

test('dev talks to the local server, a production build to its own origin', () => {
  assert.equal(resolveServerUrl({ DEV: true }), 'http://localhost:4000');
  assert.equal(resolveServerUrl({ DEV: false }), '', 'same origin');
  assert.equal(resolveServerUrl({}), '', 'no env at all (Node, tests) means same origin');
  assert.equal(resolveServerUrl(), '');
});

test('the resolved constant is a string the socket layer can use', () => {
  assert.equal(typeof SERVER_URL, 'string');
  assert.ok(!SERVER_URL.endsWith('/'), `no trailing slash in "${SERVER_URL}"`);
});
