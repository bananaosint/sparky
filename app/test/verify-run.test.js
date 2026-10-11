import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks, shellExec } from '../lib/verify-run.js';

const KEY = `ghp_${'a'.repeat(36)}`;

test('each planned check runs in order; pass, fail and time-out are told apart; not-run checks pass through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const ran = [];
  const exec = async (command) => {
    ran.push(command);
    if (command === 'npm test') return { exitCode: 0, output: 'ok 1 adds\n', timedOut: false };
    if (command === 'npm run build') return { exitCode: 2, output: `line\n`.repeat(60) + `token=${KEY}\nerror TS2304\n`, timedOut: false };
    return { exitCode: 1, output: 'slow', timedOut: true };
  };
  let clock = 0;
  const results = await runChecks(
    [
      { name: 'tests', command: 'npm test' },
      { name: 'lint', reason: 'the folder is untrusted; only your own configured commands run' },
      { name: 'build', command: 'npm run build' },
      { name: 'criterion 1', criterion: 0, command: 'npm run bench' },
    ],
    { cwd: dir, logDir: join(dir, 'checks'), exec, now: () => (clock += 1000), tree: async () => 'f'.repeat(40) },
  );
  assert.deepEqual(ran, ['npm test', 'npm run build', 'npm run bench']);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['tests', 'pass'], ['lint', 'not-run'], ['build', 'fail'], ['criterion 1', 'timed-out']]);
  assert.equal(results[0].tree, 'f'.repeat(40));
  assert.equal(results[2].exit, 2);
  assert.ok(results[2].tail.split('\n').length <= 40);
  assert.ok(!results[2].tail.includes(KEY));
  assert.equal(results[3].criterion, 0);
  const log = readFileSync(join(dir, 'checks', results[2].log), 'utf8');
  assert.ok(log.includes('error TS2304') && !log.includes(KEY));
  assert.equal(results[1].log, undefined);
});

test('the real shell runs a quoted command line, keeps stdout and stderr and the exit code, and kills a slow one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const ran = await shellExec(`node -e "console.log('out'); console.error('err'); process.exit(3)"`, { cwd: dir });
  assert.equal(ran.exitCode, 3);
  assert.equal(ran.timedOut, false);
  assert.match(ran.output, /out/);
  assert.match(ran.output, /err/);
  const started = Date.now();
  const slow = await shellExec(`node -e "setTimeout(() => {}, 60000)"`, { cwd: dir, timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 15000);
});

test('a check whose command can not start is a failure with the reason, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const results = await runChecks([{ name: 'tests', command: 'npm test' }], { cwd: dir, logDir: join(dir, 'checks'), exec: async () => Promise.reject(new Error('spawn cmd ENOENT')), now: Date.now });
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].reason, /ENOENT/);
  assert.ok(existsSync(join(dir, 'checks')));
});
