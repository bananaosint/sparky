import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missionRequest } from '../lib/mission-ipc.js';
import { openMissions } from '../lib/mission-open.js';

// What main.js hands missionRequest, with each side effect counted.
function deps(over = {}) {
  const calls = [];
  const missions = {
    start: (objective) => (calls.push(['start', objective]), { mission: { id: 'm1' } }),
    approve: async (id) => (calls.push(['approve', id]), { mission: { id } }),
    cancel: (id) => (calls.push(['cancel', id]), { mission: { id }, stop: true }),
    resume: (id, restart) => (calls.push(['resume', id]), restart('s1'), { mission: { id } }),
    checkAgain: (id) => (calls.push(['checkAgain', id]), { ok: true }),
  };
  return {
    calls,
    d: {
      missions,
      model: 'opus',
      marathonRunning: false,
      ensureClaude: () => calls.push(['ensureClaude']),
      stopTurn: () => calls.push(['stopTurn']),
      restart: (sessionId) => calls.push(['restart', sessionId]),
      notUser: () => calls.push(['notUser']),
      ...over,
    },
  };
}

test('approve starts Claude Code first when it is not running, so the run message has somewhere to go', async () => {
  const { calls, d } = deps();
  await missionRequest({ action: 'approve', id: 'm1', criteria: [] }, d);
  assert.deepEqual(calls.map((c) => c[0]), ['ensureClaude', 'notUser', 'approve']);
});

test('resume and start are refused while a marathon runs', async () => {
  const { calls, d } = deps({ marathonRunning: true });
  assert.match((await missionRequest({ action: 'resume', id: 'm1' }, d)).error, /marathon/);
  assert.match((await missionRequest({ action: 'start', objective: 'x' }, d)).error, /marathon/);
  assert.deepEqual(calls, []);
});

test('start needs Claude Code; cancel of a live mission stops the turn; resume restarts on the session', async () => {
  const gemini = deps({ model: 'gemini' });
  assert.match((await missionRequest({ action: 'start', objective: 'x' }, gemini.d)).error, /needs Claude Code/);
  const { calls, d } = deps();
  await missionRequest({ action: 'cancel', id: 'm1' }, d);
  await missionRequest({ action: 'resume', id: 'm1' }, d);
  assert.deepEqual(calls, [['cancel', 'm1'], ['stopTurn'], ['notUser'], ['resume', 'm1'], ['restart', 's1']]);
  assert.match((await missionRequest({ action: 'start', objective: 'x' }, { ...d, missions: undefined })).error, /no folder/);
});

test('check again goes to the runner and needs no Claude Code', async () => {
  const { calls, d } = deps({ marathonRunning: true });
  assert.deepEqual(await missionRequest({ action: 'check-again', id: 'm1' }, d), { ok: true });
  assert.deepEqual(calls, [['checkAgain', 'm1']]);
});

test("an opened folder's missions end with Spark's own checks: npm test and each command criterion, for real", async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-open-'));
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t']]) spawnSync('git', args, { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(42)"' } }));
  const told = [];
  const opened = await openMissions({ cwd: root, write: () => {}, notify: (m) => told.push(m), now: Date.now, hex4: () => 'beef', config: () => ({}), trusted: () => true });
  const { mission } = opened.missions.fromPlan('print 42', [{ text: 'prints 42', how: 'node -e "process.exit(0)"', by: 'claude' }], 'plan');
  await opened.missions.approve(mission.id, [{ text: 'prints 42', how: 'node -e "process.exit(0)"' }]);
  opened.missions.onEvent({ kind: 'result', ok: true, text: 'Done.' });
  await opened.missions.idle();
  const report = JSON.parse(readFileSync(join(root, '.spark', 'missions', mission.id, 'report.json'), 'utf8'));
  assert.equal(report.status, 'Finished · Verified', JSON.stringify(told.filter((m) => m.kind === 'error')));
  assert.deepEqual(report.proof.checks.map((c) => [c.name, c.status]), [['tests', 'pass'], ['criterion 1', 'pass']]);
  assert.match(readFileSync(join(root, '.spark', 'missions', mission.id, 'checks', '1.log'), 'utf8'), /42/);
});

test('a folder whose .git/info can not be written still opens: missions are off, with the reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-open-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const exclude = join(root, '.git', 'info', 'exclude');
  rmSync(exclude, { force: true });
  mkdirSync(exclude, { recursive: true });
  const opened = await openMissions({ cwd: root, write: () => {}, notify: () => {}, now: Date.now, hex4: () => 'beef' });
  assert.equal(opened.missions, undefined);
  assert.match(opened.error, /EISDIR|illegal operation/i);
});

test('a normal repo opens with missions at its top', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-open-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'sub'));
  const opened = await openMissions({ cwd: join(root, 'sub'), write: () => {}, notify: () => {}, now: Date.now, hex4: () => 'beef' });
  assert.equal(opened.error, undefined);
  assert.deepEqual(opened.missions.list(), []);
});
