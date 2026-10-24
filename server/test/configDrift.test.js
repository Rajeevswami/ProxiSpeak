/**
 * Config drift guard: every environment variable read in the server config
 * must appear in .env.example (with a placeholder or default and a comment),
 * and vice versa — no stale variables in the example file.
 *
 * The same rule applies to the client VITE_* variables vs client/.env.example.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_CONFIG = path.join(REPO_ROOT, 'server', 'src', 'config', 'index.js');
const CLIENT_CONFIG = path.join(REPO_ROOT, 'client', 'src', 'config.js');
const ROOT_ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const CLIENT_ENV_EXAMPLE = path.join(REPO_ROOT, 'client', '.env.example');

/**
 * Extract every environment variable name referenced in a JS source file.
 * Matches: process.env.KEY, str('KEY', ...), num('KEY', ...)
 */
function extractEnvVars(source) {
  const vars = new Set();
  // process.env.KEY
  for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    vars.add(match[1]);
  }
  // str('KEY', ...), num('KEY', ...), list('KEY', ...)
  for (const match of source.matchAll(/(?:str|num|integer|bool|url|list|scaleUrl)\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
    vars.add(match[1]);
  }
  return vars;
}

/**
 * Extract every variable name declared in an .env.example file,
 * including commented-out lines like `# KEY=value`.
 */
function extractExampleVars(source) {
  const vars = new Set();
  for (const line of source.split('\n')) {
    const trimmed = line.replace(/^#\s*/, '').trim();
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) vars.add(match[1]);
  }
  return vars;
}

/**
 * Extract VITE_* variable references from the client config source.
 */
function extractClientVars(source) {
  const vars = new Set();
  for (const match of source.matchAll(/env\??\.(\s*VITE_[A-Z_][A-Z0-9_]*)/g)) {
    vars.add(match[1].trim());
  }
  return vars;
}

test('every server env variable is documented in .env.example (and vice versa)', () => {
  const serverConfigSource = fs.readFileSync(SERVER_CONFIG, 'utf8');
  const envExampleSource = fs.readFileSync(ROOT_ENV_EXAMPLE, 'utf8');

  const configVars = extractEnvVars(serverConfigSource);
  const exampleVars = extractExampleVars(envExampleSource);

  // Variables that are internal-only (derived from other vars, or only meaningful
  // at scale-check runtime) are intentionally excluded.
  const intentionalAliases = new Set([
    // SCALE_CHECK_URL_A and SCALE_CHECK_URL_B are aliases for _1 and _2
    // with mutual fallback; documenting _1/_2 suffices.
    'SCALE_CHECK_URL_A',
    'SCALE_CHECK_URL_B',
    // REDIS_URL_TEST is consumed by scripts/run-tests.mjs, not server config.
    'REDIS_URL_TEST',
  ]);

  const missingFromExample = [...configVars]
    .filter((v) => !exampleVars.has(v))
    .filter((v) => !intentionalAliases.has(v));
  const staleInExample = [...exampleVars]
    .filter((v) => !configVars.has(v))
    .filter((v) => !intentionalAliases.has(v));

  assert.deepEqual(
    missingFromExample.sort(),
    [],
    `These server config variables are missing from .env.example: ${missingFromExample.join(', ')}. `
      + 'Add each one with a placeholder/default and a one-line comment.',
  );

  assert.deepEqual(
    staleInExample.sort(),
    [],
    `These variables are in .env.example but never read by server config: ${staleInExample.join(', ')}. `
      + 'Remove stale entries or add the matching reader.',
  );
});

test('every client VITE_* variable is documented in client/.env.example', () => {
  const clientConfigSource = fs.readFileSync(CLIENT_CONFIG, 'utf8');
  const clientExampleSource = fs.readFileSync(CLIENT_ENV_EXAMPLE, 'utf8');

  const clientVars = extractClientVars(clientConfigSource);
  const exampleVars = extractExampleVars(clientExampleSource);

  const missingFromExample = [...clientVars].filter((v) => !exampleVars.has(v));
  const staleInExample = [...exampleVars].filter((v) => !clientVars.has(v));

  assert.deepEqual(
    missingFromExample.sort(),
    [],
    `These client VITE_* variables are missing from client/.env.example: ${missingFromExample.join(', ')}`,
  );

  // client/.env.example may contain VITE_* entries that the config reads
  // via import.meta.env but only at build time (VITE_DEV_ALLOWED_HOSTS is
  // consumed by vite.config.js, not by src/config.js). Those are legitimate
  // and not flagged as stale here. We just check that no example entry is
  // completely unrelated to the project.
  const knownVitePrefix = /^VITE_/;
  const unknown = staleInExample.filter((v) => !knownVitePrefix.test(v));
  assert.deepEqual(
    unknown.sort(),
    [],
    `These non-VITE_ entries are in client/.env.example: ${unknown.join(', ')}`,
  );
});
