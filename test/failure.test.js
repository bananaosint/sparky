import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryCommand, failurePath, shellLine } from '../src/failure.js';

const sink = () => {
  let text = '';
  return { write: (c) => (text += c), get text() { return text; } };
};

test('a failing command is shown as usual and recorded inside .git; a passing one clears the record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-try-'));
  spawnSync('git', ['init', '-q', dir]);
  const out = sink();
  const err = sink();
  const command = `node -e "console.log('checking'); console.error('boom'); process.exit(3)"`;
  const failed = await tryCommand({ command, cwd: dir, out, err, now: () => 42 });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.recorded, true);
  assert.match(out.text, /checking/);
  assert.match(err.text, /boom/);
  const path = failurePath(dir);
  assert.ok(path.replace(/\\/g, '/').includes('/.git/'));
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.command, command);
  assert.equal(record.exitCode, 3);
  assert.equal(record.at, 42);
  assert.equal(record.cwd, dir);
  assert.match(record.output, /checking/);
  assert.match(record.output, /boom/);

  const passed = await tryCommand({ command: 'node -e "0"', cwd: dir, out, err });
  assert.equal(passed.exitCode, 0);
  assert.equal(existsSync(path), false);
});

test('outside a git repo the command still runs but nothing is recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-try-nogit-'));
  const result = await tryCommand({
    command: 'node -e "process.exit(2)"',
    cwd: dir,
    out: sink(),
    err: sink(),
    env: { GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.deepEqual(result, { exitCode: 2, recorded: false });
});

test('arguments with spaces are quoted for the shell', () => {
  assert.equal(shellLine(['npm', 'test', '--', '-t', 'login form']), 'npm test -- -t "login form"');
});
