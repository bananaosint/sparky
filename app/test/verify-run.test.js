import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, planTaskCheck, runChecks, shellExec, stopChecks } from '../lib/verify-run.js';
import { gitIn } from '../lib/mission-open.js';

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
  const told = [];
  const results = await runChecks(
    [
      { name: 'tests', command: 'npm test' },
      { name: 'lint', reason: 'the folder is untrusted; only your own configured commands run' },
      { name: 'build', command: 'npm run build' },
      { name: 'criterion 1', criterion: 0, command: 'npm run bench' },
    ],
    { cwd: dir, logDir: join(dir, 'checks'), exec, now: () => (clock += 1000), tree: async () => 'f'.repeat(40), onResult: (r) => told.push(r) },
  );
  assert.deepEqual(told, results);
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

test('stopChecks ends every check still running, as Spark quits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const started = Date.now();
  const running = shellExec(`node -e "setTimeout(() => {}, 60000)"`, { cwd: dir });
  await new Promise((r) => setTimeout(r, 300));
  stopChecks();
  const out = await running;
  assert.notEqual(out.exitCode, 0);
  assert.ok(Date.now() - started < 15000);
});

test("planFor reads the repo, the person's commands for it, and the scripts changed since the start snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const run = gitIn(dir);
  const pkg = (build) => JSON.stringify({ scripts: { test: 'node --test', build } });
  writeFileSync(join(dir, 'package.json'), pkg('tsc'));
  for (const argv of [['git', 'init', '-q'], ['git', 'add', '-A'], ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start']]) await run(argv);
  const startSha = (await run(['git', 'rev-parse', 'HEAD'])).stdout.trim();
  writeFileSync(join(dir, 'package.json'), pkg('echo built'));
  const mission = { criteria: [{ text: 'a', how: 'npm run build -- --prod', by: 'claude' }, { text: 'b', how: 'npm test -- auth', by: 'claude' }], startSha };
  const config = { repos: { [dir.replace(/\\/g, '/').toUpperCase()]: { lint: 'eslint .' }, 'C:/elsewhere': { test: 'nope' } } };
  const plan = await planFor({ cwd: dir, mission, config, trusted: true, run });
  assert.deepEqual(plan.map((p) => [p.name, p.command ?? `not run: ${p.reason}`]), [
    ['tests', 'npm test'],
    ['lint', 'eslint .'],
    ['build', 'not run: the build script changed during the mission'],
    ['criterion 1', 'not run: the build script changed during the mission'],
    ['criterion 2', 'npm test -- auth'],
  ]);
  const noSnapshot = await planFor({ cwd: dir, mission: { ...mission, startSha: undefined }, config: {}, trusted: true, run: undefined });
  assert.match(noSnapshot[0].reason, /can't tell whether the test script changed/);
  const gated = await planFor({ cwd: dir, mission: { criteria: [{ text: 'c', how: 'npm install express', by: 'claude' }], startSha }, config: {}, trusted: true, run });
  assert.match(gated.at(-1).reason, /^the gate would ask/);
});

test('a check whose command can not start is a failure with the reason, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const results = await runChecks([{ name: 'tests', command: 'npm test' }], { cwd: dir, logDir: join(dir, 'checks'), exec: async () => Promise.reject(new Error('spawn cmd ENOENT')), now: Date.now });
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].reason, /ENOENT/);
  assert.ok(existsSync(join(dir, 'checks')));
});

test("a task's check is planned by the same rules as a criterion's, under the task's name", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  const mission = { criteria: [], startSha: undefined };
  assert.deepEqual(await planTaskCheck({ cwd: dir, mission, task: { id: 't2', title: 'Limiter', do: 'x', after: [], check: 'node -e "process.exit(0)"' }, config: {}, trusted: true }), {
    name: 'task t2',
    criterion: 0,
    command: 'node -e "process.exit(0)"',
  });
  const asked = await planTaskCheck({ cwd: dir, mission, task: { id: 't3', title: 'x', do: 'x', after: [], check: 'npm install express' }, config: {}, trusted: true });
  assert.match(asked.reason, /^the gate would ask/);
  const untrusted = await planTaskCheck({ cwd: dir, mission, task: { id: 't4', title: 'x', do: 'x', after: [], check: 'node --test' }, config: {}, trusted: false });
  assert.match(untrusted.reason, /untrusted/);
});

test('a check whose log cannot be written fails with the reason, and the checks after it still run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-verify-'));
  mkdirSync(join(dir, 'checks', '1.log'), { recursive: true });
  const ran = [];
  const results = await runChecks(
    [
      { name: 'tests', command: 'npm test' },
      { name: 'criterion 1', criterion: 0, command: 'npm run bench' },
    ],
    { cwd: dir, logDir: join(dir, 'checks'), exec: async (c) => (ran.push(c), { exitCode: 0, output: 'ok', timedOut: false }), now: Date.now },
  );
  assert.deepEqual(ran, ['npm test', 'npm run bench']);
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].reason, /EISDIR|illegal operation/i);
  assert.equal(results[1].status, 'pass');
});
