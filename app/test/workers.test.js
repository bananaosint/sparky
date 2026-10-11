import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { bringBack, prepareWorktree, removeWorktree, startWorker } from '../lib/workers.js';
import { gitIn } from '../lib/mission-open.js';
import { pinSnapshot } from '../staged/plugin/hooks/snapshot.ts';

const ID = 'm-20261010-220000-beef';

async function repo() {
  const root = mkdtempSync(join(tmpdir(), 'spark-workers-'));
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t']]) spawnSync('git', args, { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.spark/\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.js'), 'export const b = 1;\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: root });
  // An earlier task's change, still uncommitted: the workers must see it and keep it.
  writeFileSync(join(root, 'a.js'), 'export const a = 2;\n');
  const run = gitIn(root);
  const base = await pinSnapshot(run, `refs/spark/missions/${ID}/layer-1`, 'layer 1');
  return { root, run, base, dir: mkdtempSync(join(tmpdir(), 'spark-wt-')) };
}

test('workers start from the base, uncommitted work included; their changes come back to the working tree one by one', async () => {
  const { root, run, base, dir } = await repo();
  const t2 = await prepareWorktree(run, root, { missionId: ID, taskId: 't2', base, dir });
  const t3 = await prepareWorktree(run, root, { missionId: ID, taskId: 't3', base, dir });
  assert.equal(readFileSync(join(t2.path, 'a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(t2.branch, `spark/${ID}/t2`);
  writeFileSync(join(t2.path, 'b.js'), 'export const b = 2;\n');
  writeFileSync(join(t3.path, 'c.js'), 'export const c = 3;\n');
  assert.deepEqual(await bringBack(run, root, t2, base), { ok: true, files: [{ path: 'b.js', added: 1, removed: 1 }] });
  assert.deepEqual(await bringBack(run, root, t3, base), { ok: true, files: [{ path: 'c.js', added: 1, removed: 0 }] });
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), 'export const b = 2;\n');
  assert.equal(readFileSync(join(root, 'c.js'), 'utf8'), 'export const c = 3;\n');
  assert.equal(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout, '');
});

test('a worker whose change no longer applies has collided, and the working tree is left as it was', async () => {
  const { root, run, base, dir } = await repo();
  const t2 = await prepareWorktree(run, root, { missionId: ID, taskId: 't2', base, dir });
  const t3 = await prepareWorktree(run, root, { missionId: ID, taskId: 't3', base, dir });
  writeFileSync(join(t2.path, 'b.js'), 'export const b = 2;\n');
  writeFileSync(join(t3.path, 'b.js'), 'export const b = 3;\n');
  assert.equal((await bringBack(run, root, t2, base)).ok, true);
  const second = await bringBack(run, root, t3, base);
  assert.equal(second.collided, true);
  assert.match(second.reason, /b\.js/);
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), 'export const b = 2;\n');
});

test('a worker with no changes comes back with none; removing a worktree removes its folder and branch', async () => {
  const { root, run, base, dir } = await repo();
  const t2 = await prepareWorktree(run, root, { missionId: ID, taskId: 't2', base, dir });
  assert.deepEqual(await bringBack(run, root, t2, base), { ok: true, files: [] });
  await removeWorktree(run, root, t2);
  assert.equal(existsSync(t2.path), false);
  assert.equal(spawnSync('git', ['branch', '--list', t2.branch], { cwd: root, encoding: 'utf8' }).stdout.trim(), '');
});

// A stand-in for a worker's Claude Code process: answers each message with a result line.
function fakeClaude(answers) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.written = [];
  child.killed = false;
  child.stdin = {
    write(line) {
      child.written.push(JSON.parse(line));
      const answer = answers.shift();
      if (answer === 'exit') setTimeout(() => child.emit('exit', 1), 5);
      else if (answer) setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, duration_ms: 1000, total_cost_usd: 0.01 })}\n`), 5);
    },
  };
  child.kill = () => ((child.killed = true), child.emit('exit', null));
  return child;
}

test("a worker's process takes one turn per message and hands back its result; its events are its own", async () => {
  const child = fakeClaude(['Added the limiter.', 'Fixed it.']);
  const seen = [];
  const w = startWorker({ child, onEvent: (e) => seen.push(e.kind) });
  const first = await w.turn('Do only task t2 now');
  assert.deepEqual([first.ok, first.text], [true, 'Added the limiter.']);
  const second = await w.turn("Task t2's check failed");
  assert.equal(second.text, 'Fixed it.');
  assert.deepEqual(child.written.map((m) => m.message.content.at(-1).text), ['Do only task t2 now', "Task t2's check failed"]);
  assert.deepEqual(seen, ['result', 'result']);
  w.stop();
  assert.equal(child.killed, true);
});

test("a worker whose process dies mid-turn fails that turn with the reason, and takes no more", async () => {
  const w = startWorker({ child: fakeClaude(['exit']), onEvent: () => {} });
  await assert.rejects(w.turn('Do only task t2 now'), /the worker's Claude Code stopped \(code 1\)/);
  await assert.rejects(w.turn('again'), /the worker's Claude Code stopped/);
});
