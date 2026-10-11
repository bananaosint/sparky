import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
