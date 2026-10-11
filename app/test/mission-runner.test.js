import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/mission-store.js';
import { createMissionRunner } from '../lib/mission-runner.js';
import { treeNow } from '../staged/plugin/hooks/snapshot.ts';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DRAFT = 'I read src/auth.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"A sixth failed login gets 429","how":"npm test"}]}\n```';
const result = (text, over = {}) => ({ kind: 'result', ok: true, text, costUsd: 0.1, durationMs: 2000, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 300 }, ...over });

// A runner with Claude Code and the window replaced by arrays, on a real store in a temp folder.
function rig({ run, root = mkdtempSync(join(tmpdir(), 'spark-runner-')) } = {}) {
  let clock = new Date(2026, 9, 10, 18, 0, 0).getTime();
  const lines = [];
  const told = [];
  const store = createStore(root);
  const r = createMissionRunner({ store, write: (l) => lines.push(JSON.parse(l)), notify: (m) => told.push(m), run, now: () => (clock += 1000), hex4: () => 'beef' });
  const texts = () => lines.filter((l) => l.type === 'user').map((l) => l.message.content[0].text);
  const modes = () => lines.filter((l) => l.type === 'control_request').map((l) => l.request.mode);
  return { r, store, root, lines, told, texts, modes };
}

function drafted(over) {
  const t = rig(over);
  t.r.onEvent({ kind: 'init', sessionId: SESSION, model: 'claude-opus-5-5', skills: [] });
  const { mission } = t.r.start('rate-limit the login route', { sessionId: SESSION });
  t.r.onEvent(result(DRAFT));
  return { ...t, id: mission.id };
}

async function approved(over) {
  const t = drafted(over);
  const out = await t.r.approve(t.id, [
    { text: 'A sixth failed login gets 429', how: 'npm test' },
    { text: 'Locked users see when to retry', how: 'manual' },
  ]);
  return { ...t, mission: out.mission };
}

test('start switches to plan mode and asks for the draft; the draft turn moves to review and puts the mode back', () => {
  const t = drafted();
  assert.deepEqual(t.modes(), ['plan', 'default']);
  assert.match(t.texts()[0], /^Mission: rate-limit the login route/);
  const m = t.store.read(t.id).mission;
  assert.equal(m.status, 'review');
  assert.equal(m.title, 'Rate-limit login');
  assert.equal(m.sessionId, SESSION);
  assert.deepEqual(t.told.filter((x) => x.kind === 'review').map((x) => x.mission.criteria.length), [1]);
  assert.equal(t.r.busy(), false);
});

test('while drafting, writes and shell commands are refused and recorded; after approval they go through', async () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  assert.match(t.r.draftDenial('Edit', { file_path: 'C:/app/src/auth.js' }), /being drafted/);
  assert.equal(t.r.draftDenial('Read', { file_path: 'C:/app/src/auth.js' }), undefined);
  t.r.onEvent(result(DRAFT));
  await t.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }]);
  assert.equal(t.r.draftDenial('Edit', { file_path: 'C:/app/src/auth.js' }), undefined);
  assert.deepEqual(
    t.store.read(mission.id).records.filter((x) => x.kind === 'permission').map((x) => [x.tool, x.decision]),
    [['Edit', 'auto-denied']],
  );
});

test('approve sends the criteria and marks edited rows as yours; a finished turn writes a report', async () => {
  const t = await approved();
  assert.match(t.texts().at(-1), /1\. A sixth failed login gets 429 \(check: npm test\)\n2\. Locked users see when to retry \(check: manual\)/);
  assert.deepEqual(t.mission.criteria.map((c) => c.by), ['claude', 'you']);
  t.r.onEvent({ kind: 'tool', id: 't1', name: 'Edit', input: { file_path: 'C:/app/src/auth.js' } });
  t.r.onEvent({ kind: 'tool-result', id: 't1', output: 'ok', isError: false });
  t.r.onEvent(result('Changed auth.js.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.mission.status, 'finished');
  assert.equal(back.report.status, 'Finished · tests not run on the final code');
  assert.deepEqual(back.report.files, [{ path: 'C:/app/src/auth.js' }]);
  assert.equal(t.told.filter((x) => x.kind === 'report').length, 1);
  assert.equal(t.r.start('another one').mission.status, 'draft');
});

test('a question waits for you, and your answer puts it back to running', async () => {
  const t = await approved();
  t.r.onEvent(result('Per IP or per account?'));
  assert.equal(t.store.read(t.id).mission.status, 'waiting');
  t.r.you('per account');
  assert.equal(t.store.read(t.id).mission.status, 'running');
  assert.deepEqual(t.store.read(t.id).records.filter((x) => x.kind === 'you').map((x) => x.text), ['per account']);
});

test('a chat turn during review leaves the mission in review', () => {
  const t = drafted();
  t.r.you('what does 429 mean?');
  t.r.onEvent(result('Too Many Requests.'));
  assert.equal(t.store.read(t.id).mission.status, 'review');
});

test('stop pauses; resume restarts on the mission session and sends the resume text', async () => {
  const t = await approved();
  t.r.stopped();
  assert.equal(t.store.read(t.id).mission.status, 'paused');
  const restarts = [];
  const out = t.r.resume(t.id, (sessionId) => restarts.push(sessionId));
  assert.equal(out.mission.status, 'running');
  assert.deepEqual(restarts, [SESSION]);
  assert.match(t.texts().at(-1), /^Resuming mission: Rate-limit login/);
});

test('an exit interrupts; a resume that died starts fresh next time', async () => {
  const t = await approved();
  t.r.exited(1, 'boom');
  assert.equal(t.store.read(t.id).mission.status, 'interrupted');
  const restarts = [];
  t.r.resume(t.id, (s) => restarts.push(s));
  t.r.exited(1, 'No conversation found with session ID');
  t.r.resume(t.id, (s) => restarts.push(s));
  assert.deepEqual(restarts, [SESSION, undefined]);
});

test('an interrupted draft drafts again on resume', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  t.r.exited(1);
  t.r.resume(mission.id, () => {});
  assert.equal(t.store.read(mission.id).mission.status, 'draft');
  assert.deepEqual(t.modes(), ['plan', 'plan']);
});

test('opening the folder again marks missions that were live as interrupted', async () => {
  const t = await approved();
  const again = createMissionRunner({ store: createStore(t.root), write: () => {}, notify: () => {}, now: () => Date.now(), hex4: () => 'cafe' });
  again.recover();
  assert.equal(t.store.read(t.id).mission.status, 'interrupted');
  assert.equal(t.store.read(t.id).mission.reason, 'Spark closed while it ran');
});

test('a halt after approval blocks, and gate lines from before the mission are ignored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runner-'));
  mkdirSync(join(root, '.spark'));
  writeFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: 1, check: 'halt', ok: false })}\n`);
  const t = await approved({ root });
  appendFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: Date.now() + 10 ** 9, check: 'halt', ok: false })}\n`);
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.mission.status, 'blocked');
  assert.equal(back.records.filter((x) => x.kind === 'gate').length, 1);
});

test('a refused plan mode is recorded and the bridge still denies', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  t.r.onEvent({ kind: 'control', id: 'mission-plan', ok: false, error: 'unknown subtype' });
  assert.ok(t.r.draftDenial('Bash', { command: 'npm i' }));
  assert.ok(t.store.read(mission.id).records.some((x) => x.kind === 'process' && x.event === 'plan-mode-refused'));
});

test('cancel ends a live mission and asks main to stop the turn; a final mission cannot be cancelled', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  const out = t.r.cancel(mission.id);
  assert.equal(out.stop, true);
  assert.equal(out.mission.status, 'cancelled');
  assert.match(t.r.cancel(mission.id).error, /already over/);
  assert.equal(t.r.busy(), false);
});

test('in a git repo: start and end are pinned, files come from numstat, tests passed on this code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runner-git-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  writeFileSync(join(root, '.gitignore'), '.spark/\n');
  writeFileSync(join(root, 'auth.js'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? root, env: { ...process.env, ...init.env }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const t = await approved({ run, root });
  assert.match(t.mission.startSha, /^[0-9a-f]{40}$/);
  writeFileSync(join(root, 'auth.js'), 'one\ntwo\n');
  mkdirSync(join(root, '.spark'), { recursive: true });
  appendFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: Date.now(), check: 'tests', ok: true, tree: await treeNow(run) })}\n`);
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.report.status, 'Finished · tests passed on this code');
  assert.deepEqual(back.report.files, [{ path: 'auth.js', added: 1, removed: 0 }]);
  assert.equal(git('rev-parse', `refs/spark/missions/${t.id}/end`).stdout.trim(), back.mission.endSha);
});
