// Parallel tasks' worktrees: each worker starts from the layer's base snapshot in its own git
// worktree, and its changes come back to the working tree as a patch. A patch that no longer
// applies means another worker changed the same lines first: the task has collided.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkModules } from '../staged/plugin/hooks/agents.ts';
import { numstat } from '../staged/plugin/hooks/snapshot.ts';

// commit needs an identity, and the person's may be unset.
const IDENTITY = { GIT_AUTHOR_NAME: 'spark', GIT_AUTHOR_EMAIL: 'spark@localhost', GIT_COMMITTER_NAME: 'spark', GIT_COMMITTER_EMAIL: 'spark@localhost' };
// Files move as exact bytes, as snapshots hold them: no line-ending conversion, no attribute
// filters. Otherwise a checkout or an add would rewrite every line ending and every patch collide.
const NO_AUTOCRLF = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
const RAW = { ...NO_AUTOCRLF, GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' };

async function git(run, cwd, args, init = {}) {
  const r = await run(['git', ...args], { cwd, ...init });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// `dir`: where worktrees live, outside the repo so its own test runner never finds them.
export async function prepareWorktree(run, root, { missionId, taskId, base, dir }) {
  const path = join(dir, `${missionId}-${taskId}`);
  const branch = `spark/${missionId}/${taskId}`;
  await git(run, root, ['worktree', 'add', '-q', '-b', branch, path, base], { env: RAW });
  await linkModules(run, root, path).catch(() => {});
  return { path, branch, taskId };
}

// Commits what the worker left (node_modules, linked in, stays out) and applies its diff from
// the base to the working tree. git apply is all or nothing, so a collision changes nothing.
export async function bringBack(run, root, wt, base) {
  await git(run, wt.path, ['add', '-A', '--', '.', ':(exclude)node_modules'], { env: RAW });
  const staged = await run(['git', 'diff', '--cached', '--quiet'], { cwd: wt.path, env: RAW });
  if (staged.exitCode === 1) await git(run, wt.path, ['commit', '-q', '-m', `task ${wt.taskId}`], { env: { ...RAW, ...IDENTITY } });
  const head = (await git(run, wt.path, ['rev-parse', 'HEAD'])).trim();
  const files = await numstat(run, base, head);
  if (!files.length) return { ok: true, files };
  const patch = await git(run, root, ['diff', '--binary', base, head], { env: RAW });
  const scratch = mkdtempSync(join(tmpdir(), 'spark-patch-'));
  const file = join(scratch, `${wt.taskId}.patch`);
  writeFileSync(file, patch);
  try {
    // git 2.54's apply crashes when GIT_ATTR_SOURCE is set: autocrlf off is all it gets.
    const applied = await run(['git', 'apply', '--whitespace=nowarn', file], { cwd: root, env: NO_AUTOCRLF });
    if (applied.exitCode !== 0) return { collided: true, reason: applied.stderr.trim().split('\n').slice(0, 3).join(' ') };
    return { ok: true, files };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function removeWorktree(run, root, wt) {
  await run(['git', 'worktree', 'remove', '--force', wt.path], { cwd: root });
  await run(['git', 'branch', '-D', wt.branch], { cwd: root });
}
