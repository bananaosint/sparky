import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeSnapshot, listSnapshots, restoreSnapshot, fileDiffs, pinSnapshot, treeNow, treeOf, numstat } from '../plugin/hooks/snapshot.ts';

function repo({ commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spark-snap-'));
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false };
  };
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout;
  const write = (name, text) => writeFileSync(join(dir, name), text);
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  write('.gitignore', '*.log\n');
  write('a.txt', 'one\n');
  write('b.txt', 'bee\n');
  if (commit) {
    git('add', '-A');
    git('commit', '-qm', 'base');
  }
  return { dir, run, git, write, read };
}

test('a snapshot holds tracked edits and untracked files and leaves the real index alone', async () => {
  const { run, git, write } = repo();
  write('a.txt', 'two\n');
  write('new.txt', 'fresh\n');
  const before = git('status', '--porcelain');
  const snap = await takeSnapshot(run, 'before: fix login');
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.equal(git('show', `${snap.sha}:a.txt`), 'two\n');
  assert.equal(git('show', `${snap.sha}:new.txt`), 'fresh\n');
  assert.equal(snap.n, 1);
  assert.equal(snap.label, 'before: fix login');
  assert.equal(git('rev-parse', 'refs/spark/turn-1').trim(), snap.sha);
});

test('snapshots are numbered, listed newest first, and only the last 20 are kept', async () => {
  const { run, write } = repo();
  for (let i = 1; i <= 22; i++) {
    write('a.txt', `v${i}\n`);
    await takeSnapshot(run, `turn ${i}`);
  }
  const list = await listSnapshots(run);
  assert.equal(list.length, 20);
  assert.deepEqual([list[0].n, list[19].n], [22, 3]);
  assert.equal(list[0].label, 'turn 22');
});

test('restoring brings content back, removes files made since, keeps ignored files, and can be undone', async () => {
  const { dir, run, git, write, read } = repo();
  const snap = await takeSnapshot(run, 'start');
  write('a.txt', 'changed\n');
  write('later.txt', 'made by a shell command\n');
  write('debug.log', 'ignored\n');
  rmSync(join(dir, 'b.txt'));
  const undo = await restoreSnapshot(run, snap);
  assert.equal(read('a.txt'), 'one\n');
  assert.equal(read('b.txt'), 'bee\n');
  assert.equal(existsSync(join(dir, 'later.txt')), false);
  assert.equal(read('debug.log'), 'ignored\n');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  await restoreSnapshot(run, undo);
  assert.equal(read('a.txt'), 'changed\n');
  assert.equal(read('later.txt'), 'made by a shell command\n');
});

test('a repo without commits can still be snapshotted', async () => {
  const { run, git } = repo({ commit: false });
  const snap = await takeSnapshot(run, 'first');
  assert.equal(git('show', `${snap.sha}:a.txt`), 'one\n');
});

test('outside a git repo, taking a snapshot throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-nogit-'));
  const run = async (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  await assert.rejects(takeSnapshot(run, 'x'));
});

test('file diffs since a snapshot: patches for changed files, line counts for new ones, summaries for lockfiles', async () => {
  const { dir, run, write } = repo();
  write('package-lock.json', '{}\n');
  const snap = await takeSnapshot(run, 'start');
  write('a.txt', 'one\ntwo\n');
  write('new.txt', 'x\ny\nz\n');
  write('package-lock.json', '{"a":1}\n');
  rmSync(join(dir, 'b.txt'));
  const files = ['a.txt', 'new.txt', 'package-lock.json', 'b.txt'].map((f) => join(dir, f));
  const diffs = await fileDiffs(run, snap.sha, files);
  assert.deepEqual(
    diffs.map(({ path, kind, added, removed }) => ({ path, kind, added, removed })),
    [
      { path: 'a.txt', kind: 'modified', added: 1, removed: 0 },
      { path: 'new.txt', kind: 'new', added: 3, removed: 0 },
      { path: 'package-lock.json', kind: 'lockfile', added: 1, removed: 1 },
      { path: 'b.txt', kind: 'deleted', added: 0, removed: 1 },
    ],
  );
  assert.match(diffs[0].patch, /\+two/);
  assert.equal(diffs[2].patch, undefined);
});

test('without a file list, file diffs cover every change since the snapshot, shell-made ones included', async () => {
  const { dir, run, write } = repo();
  const snap = await takeSnapshot(run, 'start');
  write('a.txt', 'one\nmore\n');
  write('generated.txt', 'from a build script\n');
  rmSync(join(dir, 'b.txt'));
  const diffs = await fileDiffs(run, snap.sha);
  assert.deepEqual(diffs.map((d) => `${d.kind} ${d.path}`).sort(), ['deleted b.txt', 'modified a.txt', 'new generated.txt']);
});

test('a pinned snapshot lives under its own ref and is never pruned with the turn snapshots', async () => {
  const { run, git, write } = repo();
  write('a.txt', 'two\n');
  const sha = await pinSnapshot(run, 'refs/spark/missions/m-20261010-180509-beef/start', 'mission start');
  assert.equal(git('rev-parse', 'refs/spark/missions/m-20261010-180509-beef/start').trim(), sha);
  for (let i = 0; i < 21; i++) await takeSnapshot(run, `turn ${i}`);
  assert.equal(git('rev-parse', 'refs/spark/missions/m-20261010-180509-beef/start').trim(), sha);
  assert.equal((await listSnapshots(run)).length, 20);
});

test('treeNow matches the tree of a snapshot of the same files, and numstat counts lines per file', async () => {
  const { run, write } = repo();
  const start = await pinSnapshot(run, 'refs/spark/missions/x/start', 'start');
  write('a.txt', 'one\nmore\n');
  write('new.txt', 'fresh\n');
  const tree = await treeNow(run);
  const end = await pinSnapshot(run, 'refs/spark/missions/x/end', 'end');
  assert.equal(await treeOf(run, end), tree);
  assert.deepEqual(
    (await numstat(run, start, end)).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'a.txt', added: 1, removed: 0 },
      { path: 'new.txt', added: 1, removed: 0 },
    ],
  );
});
