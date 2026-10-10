import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeStamp, mergeWorktree, linkModules } from '../plugin/hooks/agents.ts';

// Merges check files out with the person's line-ending settings, so compare text, not bytes.
const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function repoWithWorktree() {
  const dir = mkdtempSync(join(tmpdir(), 'spark-agents-'));
  const main = join(dir, 'main');
  const wt = join(dir, 'wt');
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@t');
  writeFileSync(join(main, 'a.txt'), 'one\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'agent-1', wt);
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? main, env: { ...process.env, ...init.env }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { main, wt, git, run };
}

test('merging a worktree commits its uncommitted work and merges its branch into the main tree', async () => {
  const { main, wt, git, run } = repoWithWorktree();
  writeFileSync(join(wt, 'feature.txt'), 'done by agent\n');
  const before = await worktreeStamp(run, wt);
  writeFileSync(join(wt, 'feature.txt'), 'done by agent, edited\n');
  assert.notEqual(await worktreeStamp(run, wt), before);
  await mergeWorktree(run, main, { path: wt, head: '', branch: 'agent-1' }, 'agent: add feature');
  assert.equal(text(join(main, 'feature.txt')), 'done by agent, edited\n');
  assert.match(git(main, 'log', '-1', '--format=%s').stdout, /Merge branch 'agent-1'/);
});

test('a conflicting merge throws with the reason and leaves the main tree as it was', async () => {
  const { main, wt, git, run } = repoWithWorktree();
  writeFileSync(join(wt, 'a.txt'), 'agent\n');
  writeFileSync(join(main, 'a.txt'), 'person\n');
  git(main, 'commit', '-qam', 'person edit');
  await assert.rejects(mergeWorktree(run, main, { path: wt, head: '', branch: 'agent-1' }, 'agent: edit a'), /conflict/i);
  assert.equal(text(join(main, 'a.txt')), 'person\n');
  assert.equal(git(main, 'status', '--porcelain').stdout, '');
});

test('linkModules points a worktree at the main tree node_modules when it has none', async () => {
  const { main, wt, run } = repoWithWorktree();
  mkdirSync(join(main, 'node_modules', 'left-pad'), { recursive: true });
  await linkModules(run, main, wt);
  assert.equal(existsSync(join(wt, 'node_modules', 'left-pad')), true);
  await linkModules(run, main, wt);
});
