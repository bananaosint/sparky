import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewArgv } from '../plugin/hooks/gate.ts';

test('a delete preview counts the files under each path, globs expanded, and lists the first ten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-count-'));
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'dist', 'assets', `f${i}.js`), '');
  writeFileSync(join(dir, 'a.log'), '');
  writeFileSync(join(dir, 'b.log'), '');
  const argv = previewArgv({ kind: 'count', paths: ['dist', '*.log', 'missing'] });
  const out = spawnSync(argv[0], argv.slice(1), { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(out[0], '14 files');
  assert.equal(out.length, 11);
  assert.deepEqual(previewArgv({ kind: 'run', argv: ['git', 'clean', '-n'] }), ['git', 'clean', '-n']);
});

test('a path that looks like a node option is counted as a path, never run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-count-'));
  writeFileSync(join(dir, 'pwn.js'), "require('fs').writeFileSync('PWNED', '1')");
  const argv = previewArgv({ kind: 'count', paths: ['--require=./pwn.js'] });
  const out = spawnSync(argv[0], argv.slice(1), { cwd: dir, encoding: 'utf8' });
  assert.equal(existsSync(join(dir, 'PWNED')), false);
  assert.equal(out.stdout.trim(), '0 files');
});
