/**
 * CLI tests for room-layout script (Week 4 - Room Persistence).
 * Validates argument parsing, dry-run mode, exit codes, and credential redaction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../scripts/room-layout.js');
const validOfficeLayout = path.resolve(__dirname, '../layouts/valid-office.json');

test('CLI without command or args exits 1 and displays usage', async () => {
  try {
    await execFileAsync('node', [cliPath]);
    assert.fail('Should have exited 1');
  } catch (err) {
    assert.equal(err.code, 1);
    const combined = (err.stdout || '') + (err.stderr || '');
    assert.match(combined, /Usage: room-layout/);
  }
});

test('CLI show without --room argument exits 1', async () => {
  try {
    await execFileAsync('node', [cliPath, 'show']);
    assert.fail('Should have exited 1');
  } catch (err) {
    assert.equal(err.code, 1);
    const combined = (err.stdout || '') + (err.stderr || '');
    assert.match(combined, /--room/);
  }
});

test('CLI save without --room or --file exits 1', async () => {
  try {
    await execFileAsync('node', [cliPath, 'save', '--room', 'lobby']);
    assert.fail('Should have exited 1');
  } catch (err) {
    assert.equal(err.code, 1);
    const combined = (err.stdout || '') + (err.stderr || '');
    assert.match(combined, /--file/);
  }
});

test('CLI save with missing layout file exits 1', async () => {
  try {
    await execFileAsync('node', [
      cliPath,
      'save',
      '--room',
      'lobby',
      '--file',
      path.resolve(__dirname, 'nonexistent-layout.json'),
    ]);
    assert.fail('Should have exited 1');
  } catch (err) {
    assert.equal(err.code, 1);
    const combined = (err.stdout || '') + (err.stderr || '');
    assert.match(combined, /Cannot read layout file/);
  }
});

test('CLI save --dry-run validates valid-office.json and exits 0 without writing', async () => {
  const { stdout, stderr } = await execFileAsync('node', [
    cliPath,
    'save',
    '--room',
    'lobby',
    '--file',
    validOfficeLayout,
    '--dry-run',
  ]);

  const output = stdout + stderr;
  assert.match(output, /\[dry-run\]/i);
  assert.match(output, /is valid/i);
});

test('CLI save --dry-run with invalid schema fails validation and exits 1', async () => {
  // Pass package.json as an invalid layout
  try {
    await execFileAsync('node', [
      cliPath,
      'save',
      '--room',
      'lobby',
      '--file',
      path.resolve(__dirname, '../package.json'),
      '--dry-run',
    ]);
    assert.fail('Should have exited 1');
  } catch (err) {
    assert.equal(err.code, 1);
    const output = (err.stdout || '') + (err.stderr || '');
    assert.match(output, /Unknown field|validation|not allowed/i);
  }
});

test('CLI output redacts database credentials from log messages', async () => {
  const secretUri = 'mongodb://app_admin:superSecretP@ssword123@127.0.0.1:27017/proxispeak?authSource=admin';
  try {
    await execFileAsync('node', [cliPath, 'show', '--room', 'nonexistent_test_room'], {
      env: { ...process.env, MONGO_URI: secretUri, MONGO_TIMEOUT_MS: '100' },
    });
  } catch (err) {
    const combined = (err.stdout || '') + (err.stderr || '');
    assert.equal(
      combined.includes('superSecretP@ssword123'),
      false,
      'Credentials must never leak into CLI stdout or stderr',
    );
    if (combined.includes('app_admin')) {
      assert.match(combined, /app_admin:\*\*\*/);
    }
  }
});
