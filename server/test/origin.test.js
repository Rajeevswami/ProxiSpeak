import test from 'node:test';
import assert from 'node:assert/strict';
import { socketAllowRequest } from '../src/utils/origin.js';
const admit = (allowed, origin, host = 'localhost:4000') => {
  let result;
  socketAllowRequest({ server: { clientOrigins: allowed } })(
    { headers: { origin, host } }, (_, accepted) => { result = accepted; });
  return result;
};
test('WebSocket admission enforces explicit origins and safe defaults', () => {
  assert.equal(admit([], undefined), true);
  assert.equal(admit([], 'http://localhost:4000'), true);
  assert.equal(admit([], 'https://evil.example'), false);
  assert.equal(admit([], 'null'), false);
  assert.equal(admit([], 'file://localhost:4000'), false);
  assert.equal(admit(['https://trusted.example'], 'https://trusted.example'), true);
  assert.equal(admit(['https://trusted.example'], 'http://localhost:4000'), false);
  assert.equal(admit(['*'], 'https://evil.example'), true);
});
