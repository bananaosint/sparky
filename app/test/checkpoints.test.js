import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoints, restoreRefusal } from '../lib/checkpoints.js';
import { gitIn } from '../lib/mission-open.js';
import { pinSnapshot, takeSnapshot, treeOf } from '../staged/plugin/hooks/snapshot.ts';

const ID = 'm-20261010-210000-beef';

async function repo() {
  const root = mkdtempSync(join(tmpdir(), 'spark-checkpoints-'));
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t']]) spawnSync('git', args, { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.spark/\n');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const run = gitIn(root);
  return { root, run };
}

test('the list holds turn snapshots and mission pins, with their test marks, newest first', async () => {
  const { root, run } = await repo();
  const turn = await takeSnapshot(run, 'before: fix the login');
  await new Promise((r) => setTimeout(r, 1100));
  writeFileSync(join(root, 'a.txt'), 'two\n');
  await pinSnapshot(run, `refs/spark/missions/${ID}/start`, 'mission start');
  mkdirSync(join(root, '.spark'), { recursive: true });
  writeFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: 1, check: 'tests', ok: true, tree: await treeOf(run, turn.sha) })}\n`);
  const cps = createCheckpoints({ root, run, missions: () => [{ id: ID, title: 'Rate-limit login' }] });
  const list = await cps.list();
  assert.deepEqual(
    list.map((c) => [c.kind, c.label, c.tests]),
    [
      ['mission-start', 'Mission "Rate-limit login" started', undefined],
      ['turn', 'before: fix the login', 'passed'],
    ],
  );
});

test('changes since a checkpoint come with what a restore would do; restore brings it back and can be undone', async () => {
  const { root, run } = await repo();
  const turn = await takeSnapshot(run, 'before: fix the login');
  writeFileSync(join(root, 'a.txt'), 'two\n');
  writeFileSync(join(root, 'new.txt'), 'made later\n');
  const cps = createCheckpoints({ root, run, missions: () => [] });
  const changes = await cps.changes(turn.sha);
  assert.deepEqual(
    changes.diffs.map((d) => [d.path, d.kind]),
    [
      ['a.txt', 'modified'],
      ['new.txt', 'new'],
    ],
  );
  assert.match(changes.diffs[0].patch, /-one\n\+two/);
  assert.deepEqual(changes.plan, { putBack: ['a.txt'], removed: ['new.txt'], broughtBack: [] });
  const done = await cps.restore(turn.sha);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(done.undo.label, `before restoring turn ${turn.n}`);
  await cps.restore(done.undo.sha);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'two\n');
});

test('only a listed checkpoint is shown or restored; outside git, the view says why', async () => {
  const { root, run } = await repo();
  const cps = createCheckpoints({ root, run, missions: () => [] });
  await assert.rejects(cps.changes('f'.repeat(40)), /not one of Spark's checkpoints/);
  await assert.rejects(cps.restore('--output=x'), /not one of Spark's checkpoints/);
  const outside = createCheckpoints({ root: mkdtempSync(join(tmpdir(), 'spark-nogit-')), run: undefined, missions: () => [] });
  await assert.rejects(outside.list(), /Checkpoints need a git repository; this folder isn't one/);
});

test('a restore is refused while anything could race it, and the refusal says what', () => {
  assert.equal(restoreRefusal({ turnOpen: false, missionBusy: false, marathon: false }), undefined);
  assert.match(restoreRefusal({ turnOpen: true, missionBusy: false, marathon: false }), /Claude is working on a turn/);
  assert.match(restoreRefusal({ turnOpen: false, missionBusy: true, marathon: false }), /a mission is running or Spark is checking one/);
  assert.match(restoreRefusal({ turnOpen: false, missionBusy: false, marathon: true }), /a marathon is running/);
});
