import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeSnapshot, treeNow } from '../plugin/hooks/snapshot.ts';
import { testGate, endsInQuestion } from '../plugin/hooks/testgate.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'spark-gate-'));
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false };
  };
  const io = {
    run,
    list: async (d) => readdirSync(d),
    read: async (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout;
  const write = (name, text) => writeFileSync(join(dir, name), text);
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  write('a.txt', 'one\n');
  write('fail.js', 'console.log("ok 1 adds");\nconsole.log("not ok 2 subtracts: expected 1, got 2");\nprocess.exit(3);\n');
  write('pass.js', 'console.log("all good");\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  // The person's own test command for this repo, as Spark's config would hold it.
  const config = (command) => ({ repos: { [dir.toUpperCase().replace(/\\/g, '/') + '/']: { test: command } } });
  return { dir, io, write, config };
}

test('a turn that changed files runs the tests; a failure blocks with the tail', async () => {
  const { io, write, config } = repo();
  const { sha } = await takeSnapshot(io.run, 'before');
  write('a.txt', 'two\n');
  const failed = await testGate(io, { base: sha, answer: 'Done.' }, config('node fail.js'));
  assert.equal(failed.ok, false);
  assert.equal(failed.exit, 3);
  assert.match(failed.block, /^✦ tests failed \(exit 3\)\n/);
  assert.match(failed.block, /not ok 2 subtracts/);
  // Each run carries the tree it ran on, so a mission report can match it to the final code.
  assert.deepEqual(await testGate(io, { base: sha, answer: 'Done.' }, config('node pass.js')), { ok: true, tree: await treeNow(io.run) });
  assert.equal(failed.tree, await treeNow(io.run));
});

test('no change, a closing question, or no test command means the tests are not run', async () => {
  const { io, write, config } = repo();
  const { sha } = await takeSnapshot(io.run, 'before');
  assert.equal(await testGate(io, { base: sha, answer: 'Done.' }, config('node fail.js')), undefined);
  write('made-by-a-shell-command.txt', 'x\n');
  assert.equal(await testGate(io, { base: sha, answer: 'Export filtered rows or all of them?' }, config('node fail.js')), undefined);
  assert.equal(await testGate(io, { base: sha, answer: 'Done.' }, {}), undefined);
});

test('without a configured command the repo files pick one; npm\'s placeholder script counts as none', async () => {
  const { io, write } = repo();
  write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  const placeholder = await takeSnapshot(io.run, 'before');
  write('a.txt', 'two\n');
  assert.equal(await testGate(io, { base: placeholder.sha, answer: 'Done.' }, {}), undefined);
  write('package.json', JSON.stringify({ scripts: { test: 'node fail.js' } }));
  const real = await takeSnapshot(io.run, 'before');
  write('a.txt', 'three\n');
  assert.equal((await testGate(io, { base: real.sha, answer: 'Done.' }, {})).ok, false);
});

test("test scripts changed during the turn aren't run unasked: Claude could have written anything there", async () => {
  const { io, write } = repo();
  write('package.json', JSON.stringify({ scripts: { test: 'node pass.js' } }));
  const { sha } = await takeSnapshot(io.run, 'before');
  write('package.json', JSON.stringify({ scripts: { test: 'node fail.js' } }));
  await assert.rejects(testGate(io, { base: sha, answer: 'Done.' }, {}), /package\.json's test scripts changed this turn/);
  write('package.json', JSON.stringify({ scripts: { test: 'node pass.js', pretest: 'node fail.js' } }));
  await assert.rejects(testGate(io, { base: sha, answer: 'Done.' }, {}), /test scripts changed/);
  write('package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node pass.js' } }));
  assert.deepEqual(await testGate(io, { base: sha, answer: 'Done.' }, {}), { ok: true, tree: await treeNow(io.run) });
});

test('a question is the last thing said, whatever closes it', () => {
  assert.equal(endsInQuestion('Which columns should it export?'), true);
  assert.equal(endsInQuestion('Two questions:\n1. **Filtered or all?**'), true);
  assert.equal(endsInQuestion('Should I? I did it anyway.'), false);
  assert.equal(endsInQuestion(''), false);
});

test("in a folder Spark knows is untrusted, only the person's own configured command runs", async () => {
  const { io, write, config } = repo();
  const { sha } = await takeSnapshot(io.run, 'before');
  write('package.json', JSON.stringify({ scripts: { test: 'node fail.js' } }));
  assert.equal(await testGate(io, { base: sha, answer: 'Done.' }, {}, { untrusted: true }), undefined);
  assert.equal((await testGate(io, { base: sha, answer: 'Done.' }, config('node fail.js'), { untrusted: true })).ok, false);
});
