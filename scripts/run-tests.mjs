#!/usr/bin/env node
/**
 * Root test runner: `npm test` at the repo root runs the server suite first,
 * then the client suite, and fails when either of them fails.
 *
 * Why a runner instead of `npm --prefix server test && npm --prefix client
 * test`: with `&&` a red server suite hides the client result completely. This
 * script always runs both — a broken server suite and a broken client suite in
 * one pass — and exits non-zero as soon as one of them failed.
 *
 * Both suites are plain `node --test` (no test framework, per the project
 * constraints); this file only sequences them. Each suite is spawned in its own
 * process, so a suite that skips (for example the MongoDB integration tests on a
 * machine without a database) cannot affect the other one.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SUITES = [
  { name: 'server', args: ['--prefix', 'server', 'test'] },
  { name: 'client', args: ['--prefix', 'client', 'test'] },
];

const results = [];

for (const suite of SUITES) {
  console.log(`\n=== ${suite.name} tests ${'='.repeat(60 - suite.name.length)}\n`);
  const result = spawnSync('npm', suite.args, {
    stdio: 'inherit',
    // npm is a shell script on POSIX and npm.cmd on Windows.
    shell: process.platform === 'win32',
  });
  const passed = !result.error && result.status === 0;
  results.push({
    name: suite.name,
    passed,
    detail: result.error ? result.error.message : `exit code ${result.status}`,
  });
}

console.log('\n=== test summary =========================================================');
for (const result of results) {
  console.log(`  ${result.name.padEnd(6)} ${result.passed ? 'PASS' : 'FAIL'}  (${result.detail})`);
}

const failed = results.filter((result) => !result.passed);
console.log(failed.length ? `\n${failed.length} suite(s) failed: ${failed.map((f) => f.name).join(', ')}` : '\nall suites passed');
process.exit(failed.length ? 1 : 0);
