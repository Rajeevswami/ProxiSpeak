/** Bidirectional config/.env.example drift guard, including comments and
 * placeholders. Test-only URLs and Vite's own env consumer are explicit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function extractServerVars(source) {
  const vars = new Set();
  for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) vars.add(match[1]);
  for (const match of source.matchAll(
    /(?:str|num|integer|bool|url|list|scaleUrl)\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  )) vars.add(match[1]);
  return vars;
}

function extractClientVars(source) {
  return new Set([...source.matchAll(/\benv\??\.\s*(VITE_[A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]));
}

function declaration(line) {
  const trimmed = line.trim().replace(/^#\s*/, '');
  return trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
}

function parseExample(source) {
  const entries = new Map();
  const errors = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const match = declaration(line);
    if (!match) return;
    const [, key, value] = match;
    if (entries.has(key)) errors.push(`${key} is declared more than once`);
    const previous = lines[index - 1]?.trim() ?? '';
    const previousText = previous.replace(/^#\s*/, '').trim();
    const hasComment = previous.startsWith('#')
      && !declaration(previous)
      && previousText.length > 0
      && !/^[-=]{3,}/.test(previousText);
    if (!hasComment) errors.push(`${key} needs its own one-line comment (line ${index + 1})`);
    if (!value.trim() && key !== 'REDIS_URL') {
      errors.push(`${key} needs a placeholder/default; only REDIS_URL is intentionally empty`);
    }
    entries.set(key, { value, line: index + 1 });
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  return new Set(entries.keys());
}

function assertExactKeys(actual, expected, label) {
  const missing = [...actual].filter((key) => !expected.has(key)).sort();
  const stale = [...expected].filter((key) => !actual.has(key)).sort();
  assert.deepEqual(missing, [], `${label}: missing from example: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `${label}: stale example entries: ${stale.join(', ')}`);
}

test('server config and .env.example are exact bidirectional matches with comments', () => {
  const configVars = extractServerVars(read('server/src/config/index.js'));
  const exampleVars = parseExample(read('.env.example'));

  // These are intentionally documented for tests, not read by runtime config.
  // Prove each exception still has a real reader instead of allowing staleness.
  const testOnly = new Set(['MONGO_URI_TEST', 'REDIS_URL_TEST']);
  const testSources = [
    'server/test/proximity.test.js',
    'server/test/edgeStore.contract.test.js',
  ].map(read).join('\n');
  for (const key of testOnly) {
    assert.match(testSources, new RegExp(`process\\.env\\.${key}\\b`), `${key} exception must have a real test reader`);
  }

  const missing = [...configVars].filter((key) => !exampleVars.has(key)).sort();
  const stale = [...exampleVars].filter((key) => !configVars.has(key) && !testOnly.has(key)).sort();
  assert.deepEqual(missing, [], `server variables missing from .env.example: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `stale server .env.example entries: ${stale.join(', ')}`);
  assert.deepEqual(
    [...exampleVars].filter((key) => testOnly.has(key)).sort(),
    [...testOnly].sort(),
    'both documented test-only URLs must remain present',
  );
});

test('client config/Vite env and client/.env.example are exact bidirectional matches', () => {
  const clientVars = new Set([
    ...extractClientVars(read('client/src/config.js')),
    ...extractClientVars(read('client/vite.config.js')),
  ]);
  const exampleVars = parseExample(read('client/.env.example'));
  assertExactKeys(clientVars, exampleVars, 'client VITE_* drift');
  for (const key of exampleVars) assert.match(key, /^VITE_/, `${key} is not a Vite variable`);
});
