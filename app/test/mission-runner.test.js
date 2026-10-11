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
function rig({ run, verify, checkTask, root = mkdtempSync(join(tmpdir(), 'spark-runner-')) } = {}) {
  let clock = new Date(2026, 9, 10, 18, 0, 0).getTime();
  const lines = [];
  const told = [];
  const store = createStore(root);
  const r = createMissionRunner({ store, write: (l) => lines.push(JSON.parse(l)), notify: (m) => told.push(m), run, verify, checkTask, now: () => (clock += 1000), hex4: () => 'beef' });
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
  assert.equal(t.store.read(mission.id).mission.reason, 'you approved 1 criterion');
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

test('in a git repo, Check again keeps the end snapshot the mission ended with', async () => {
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
  const t = await approved({ run, root, verify: async (m, onResult) => onResult({ name: 'tests', command: 'npm test', status: 'pass', exit: 0, ms: 5 }) });
  writeFileSync(join(root, 'auth.js'), 'one\ntwo\n');
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const ended = t.store.read(t.id).mission.endSha;
  writeFileSync(join(root, 'auth.js'), 'one\ntwo\nthree\n');
  t.r.checkAgain(t.id);
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.mission.endSha, ended);
  assert.equal(git('rev-parse', `refs/spark/missions/${t.id}/end`).stdout.trim(), ended);
  assert.deepEqual(back.report.files, [{ path: 'auth.js', added: 1, removed: 0 }]);
});

const checked = (status) => async (m, onResult) => {
  onResult({ name: 'tests', command: 'npm test', status, exit: status === 'pass' ? 0 : 1, ms: 1000 });
  onResult({ name: 'criterion 1', criterion: 0, command: 'npm test', status, exit: status === 'pass' ? 0 : 1, ms: 900 });
};

test("a finished mission is checked by Spark before its report, and the verdict comes from Spark's checks", async () => {
  const seen = [];
  const verify = checked('pass');
  const t = await approved({ verify: (m, onResult) => (seen.push(m.status), verify(m, onResult)) });
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.deepEqual(seen, ['finished']);
  assert.deepEqual(
    back.records.filter((x) => x.kind === 'verify' || x.kind === 'check').map((x) => (x.kind === 'verify' ? `verify again=${x.again}` : `${x.name} ${x.status}`)),
    ['verify again=false', 'tests pass', 'criterion 1 pass'],
  );
  assert.equal(back.report.status, 'Finished · Needs review');
  assert.deepEqual(back.report.criteria.map((c) => c.check), ['passed (npm test)', 'needs you']);
  assert.ok(t.told.some((x) => x.kind === 'verifying' && x.id === t.id));
  assert.ok(t.told.some((x) => x.kind === 'row' && x.row.text === 'tests passed'));
});

test('a cancelled mission is not checked; checks that cannot run still leave a report and say why', async () => {
  let calls = 0;
  const t = rig({ verify: async () => calls++ });
  const { mission } = t.r.start('rate-limit the login route');
  t.r.cancel(mission.id);
  await t.r.idle();
  assert.equal(calls, 0);
  assert.ok(t.store.read(mission.id).report);
  const broke = await approved({ verify: async () => Promise.reject(new Error('EACCES: package.json')) });
  broke.r.onEvent(result('Done.'));
  await broke.r.idle();
  assert.equal(broke.store.read(broke.id).report.status, 'Finished · Not verified');
  assert.ok(broke.told.some((x) => x.kind === 'error' && /Spark's checks could not run: EACCES/.test(x.error)));
});

test('Check again records a new pass on an ended mission and rebuilds its report; never while a mission runs', async () => {
  let status = 'fail';
  const t = await approved({ verify: (m, onResult) => checked(status)(m, onResult) });
  assert.match(t.r.checkAgain(t.id).error, /is running: check again once it stops/);
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  assert.equal(t.store.read(t.id).report.status, 'Finished · Checks failed');
  status = 'pass';
  assert.deepEqual(t.r.checkAgain(t.id), { ok: true });
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.report.status, 'Finished · Needs review');
  assert.equal(back.report.proof.again, true);
  assert.equal(back.records.filter((x) => x.kind === 'verify').length, 2);
  assert.equal(t.told.filter((x) => x.kind === 'report').length, 2);
  assert.match(t.r.checkAgain('m-20261010-000000-0000').error, /only an ended mission/);
  t.r.start('another objective');
  assert.match(t.r.checkAgain(t.id).error, /is draft: check again once it stops/);
});

test('review fixes: an exit error is redacted before it is kept', async () => {
  const t = await approved();
  const key = `sk-${'b'.repeat(30)}`;
  t.r.exited(1, `auth failed for ${key}`);
  const exit = t.store.read(t.id).records.find((x) => x.kind === 'process' && x.event === 'exited');
  assert.ok(!exit.error.includes(key));
});

test('review fixes: detaching tells the window the mission is no longer this window\'s', async () => {
  const t = await approved();
  t.r.stopped();
  t.r.interrupted('you started a new chat', { detach: true });
  const last = t.told.filter((x) => x.kind === 'state' && x.mission.id === t.id).at(-1);
  assert.equal(last.active, false);
  const live = rig();
  live.r.start('rate-limit the login route');
  live.r.interrupted('you opened another folder', { detach: true });
  const lastLive = live.told.filter((x) => x.kind === 'state').at(-1);
  assert.equal(lastLive.mission.status, 'interrupted');
  assert.equal(lastLive.active, false);
});

test('review fixes: recover keeps going past a mission it cannot save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runner-'));
  const first = await approved({ root });
  const store = createStore(root);
  createMissionRunner({ store, write: () => {}, notify: () => {}, now: () => Date.now(), hex4: () => 'cafe' }).start('another objective');
  const stuck = first.id;
  const picky = { ...store, save: (m) => (m.id === stuck ? (() => { throw new Error('EPERM: read-only'); })() : store.save(m)), append: (id, r) => (id === stuck ? undefined : store.append(id, r)) };
  const again = createMissionRunner({ store: picky, write: () => {}, notify: () => {}, now: () => Date.now(), hex4: () => 'cafe' });
  assert.doesNotThrow(() => again.recover());
  const other = store.list().find((m) => m.id !== stuck);
  assert.equal(other.status, 'interrupted');
});

test('a mission from a council plan goes straight to review, and approving it sends the plan', async () => {
  const t = rig();
  const out = t.r.fromPlan('speed up the cache', [{ text: 'p95 under 50 ms', how: 'npm run bench', by: 'claude' }], '## Decision\nhybrid', { sessionId: SESSION });
  assert.equal(out.mission.status, 'review');
  assert.deepEqual(t.lines, []);
  assert.equal(t.told.filter((x) => x.kind === 'review').length, 1);
  await t.r.approve(out.mission.id, [{ text: 'p95 under 50 ms', how: 'npm run bench' }]);
  assert.match(t.texts().at(-1), /Plan \(from Council\):\n## Decision\nhybrid/);
  assert.match(t.r.fromPlan('again', [], 'p').error, /cancel it first/);
});

const PLANNED = `Read it.\n\`\`\`mission\n${JSON.stringify({
  title: 'Rate-limit login',
  spec: 'Per account, 15 minutes.',
  criteria: [{ text: 'A sixth failed login gets 429', how: 'npm test' }],
  tasks: [
    { id: 't1', title: 'Limiter', do: 'Add a limiter', after: [], check: 'npm test -- limiter' },
    { id: 't2', title: 'Message', do: 'Say when to retry', after: ['t1'] },
  ],
})}\n\`\`\``;

// A mission with two tasks, approved; `checks` answers each task check in turn.
async function tasked(checks = [], over = {}) {
  const seen = [];
  const t = rig({ ...over, checkTask: async (m, task, attempt) => (seen.push(`${task.id}#${attempt}`), checks.shift() ?? { name: `task ${task.id}`, status: 'pass', exit: 0 }) });
  t.r.onEvent({ kind: 'init', sessionId: SESSION, model: 'claude-opus-5-5', skills: [] });
  const { mission } = t.r.start('rate-limit the login route', { sessionId: SESSION });
  t.r.onEvent(result(PLANNED));
  const out = await t.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }], [
    { id: 't1', do: 'Add a limiter', check: 'npm test -- limiter' },
    { id: 't2', do: 'Say when to retry' },
  ]);
  return { ...t, id: mission.id, mission: out.mission, seen };
}
const taskEvents = (t) => t.store.read(t.id).records.filter((x) => x.kind === 'task').map((x) => `${x.id} ${x.event}#${x.attempt}`);

test('a planned mission runs its tasks in order: each turn ends one task, Spark checks it and sends the next', async () => {
  const t = await tasked();
  assert.match(t.texts().at(-1), /Do only task t1 \(Limiter\) now: Add a limiter/);
  t.r.onEvent(result('Added the limiter.'));
  await t.r.idle();
  assert.deepEqual(t.seen, ['t1#1']);
  assert.match(t.texts().at(-1), /^Do only task t2 \(Message\) now: Say when to retry/);
  assert.equal(t.store.read(t.id).mission.status, 'running');
  t.r.onEvent(result('Added the message.'));
  await t.r.idle();
  assert.deepEqual(taskEvents(t), ['t1 started#1', 't1 done#1', 't2 started#1', 't2 done#1']);
  const back = t.store.read(t.id);
  assert.equal(back.mission.status, 'finished');
  assert.equal(back.mission.reason, 'every task is done');
  assert.ok(back.report);
});

test("a failed task check is sent back once with its tail; a second failure blocks the mission", async () => {
  const fail = { name: 'task t1', status: 'fail', exit: 1, tail: 'not ok 1 limiter' };
  const t = await tasked([fail, fail]);
  t.r.onEvent(result('Added the limiter.'));
  await t.r.idle();
  assert.match(t.texts().at(-1), /^Task t1's check failed \(exit 1\):\n\nnot ok 1 limiter/);
  t.r.onEvent(result('Fixed it.'));
  await t.r.idle();
  assert.deepEqual(t.seen, ['t1#1', 't1#2']);
  assert.deepEqual(taskEvents(t), ['t1 started#1', 't1 retry#2', 't1 failed#2']);
  const back = t.store.read(t.id).mission;
  assert.equal(back.status, 'blocked');
  assert.equal(back.reason, "task t1's check failed twice");
});

test("a task check that didn't run leaves the task done with the reason; Run as one piece drops the plan", async () => {
  const t = await tasked([{ name: 'task t1', status: 'not-run', reason: 'the folder is untrusted; only your own configured commands run' }]);
  t.r.onEvent(result('Added the limiter.'));
  await t.r.idle();
  const done = t.store.read(t.id).records.find((x) => x.kind === 'task' && x.event === 'done');
  assert.equal(done.note, 'check not run: the folder is untrusted; only your own configured commands run');
  const whole = rig();
  const { mission } = whole.r.start('rate-limit the login route');
  whole.r.onEvent(result(PLANNED));
  const out = await whole.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }], []);
  assert.equal(out.mission.tasks, undefined);
  assert.doesNotMatch(whole.texts().at(-1), /Do only task/);
});

test('stop during a task, then Resume, sends that task again', async () => {
  const t = await tasked();
  t.r.onEvent(result('Added the limiter.'));
  await t.r.idle();
  t.r.stopped();
  assert.equal(t.store.read(t.id).mission.status, 'paused');
  t.r.resume(t.id, () => {});
  assert.match(t.texts().at(-1), /^Resuming mission: Rate-limit login[\s\S]*Do only task t2 \(Message\) now/);
});

test("the mission view carries the plan: tasks, their states from Spark's records, the layers, and each task's rows", async () => {
  const t = await tasked();
  t.r.onEvent(result('Added the limiter.'));
  await t.r.idle();
  const view = t.r.view(t.id);
  assert.deepEqual(view.plan.layers, [['t1'], ['t2']]);
  assert.deepEqual(view.plan.tasks.map((x) => [x.id, x.state]), [['t1', 'done'], ['t2', 'running']]);
  assert.ok(view.plan.tasks[0].rows.some((row) => row.text === 'task t1 done · check passed'));
  assert.equal(view.plan.tasks[0].check, 'npm test -- limiter');
  assert.equal(view.plan.tasks[0].checkResult.status, 'pass');
  const plain = rig();
  assert.equal(plain.r.view(plain.r.start('plain').mission.id).plan, undefined);
});

test('records a check writes into the mission folder during the pass do not change the verdict', async () => {
  let t;
  // The tests fail; then the criterion's command writes a fresh pass of its own; then it passes.
  const verify = async (m, onResult) => {
    onResult({ name: 'tests', command: 'npm test', status: 'fail', exit: 1 });
    t.store.append(m.id, { at: Date.now(), kind: 'verify', again: false });
    t.store.append(m.id, { at: Date.now(), kind: 'check', name: 'tests', command: 'npm test', status: 'pass', exit: 0 });
    onResult({ name: 'criterion 1', criterion: 0, command: 'npm test', status: 'pass', exit: 0 });
  };
  t = await approved({ verify });
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  assert.equal(t.store.read(t.id).report.status, 'Finished · Checks failed');
});

test("while Spark's checks run, no mission starts or is approved and no second pass starts: they would race the checks", async () => {
  let release = () => {};
  const t = await approved({ verify: () => new Promise((r) => (release = r)) });
  t.r.onEvent(result('Done.'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.r.busy(), true);
  assert.match(t.r.start('another objective').error, /Spark is running its checks/);
  assert.match(t.r.fromPlan('x', [{ text: 'a', how: 'b', by: 'claude' }], 'p').error, /Spark is running its checks/);
  assert.match(t.r.checkAgain(t.id).error, /Spark is running its checks/);
  release();
  await t.r.idle();
  assert.equal(t.r.busy(), false);
  assert.equal(t.r.start('another objective').mission.status, 'draft');
});

test("an edited plan that doesn't hold together is refused with the reason; the mission stays in review", async () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  t.r.onEvent(result(PLANNED));
  const out = await t.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }], [
    { id: 't1', do: '', check: 'npm test -- limiter' },
    { id: 't2', do: 'Say when to retry' },
  ]);
  assert.equal(out.error, 'task t1 has no title or instructions');
  assert.equal(t.store.read(mission.id).mission.status, 'review');
});

test("while a task's check runs, Resume waits for it and the window hears what Spark is doing", async () => {
  let release = () => {};
  const seen = [];
  const t = rig({ checkTask: (m, task, attempt) => (seen.push(`${task.id}#${attempt}`), new Promise((r) => (release = () => r({ name: `task ${task.id}`, status: 'pass', exit: 0 })))) });
  const { mission } = t.r.start('rate-limit the login route');
  t.r.onEvent(result(PLANNED));
  await t.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }]);
  t.r.onEvent(result('Added the limiter.'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(t.told.some((x) => x.kind === 'checking' && x.id === mission.id && x.task === 't1'));
  t.r.stopped();
  assert.match(t.r.resume(mission.id, () => {}).error, /Spark is still checking task t1/);
  release();
  await t.r.idle();
  assert.deepEqual(seen, ['t1#1']);
  assert.equal(t.store.read(mission.id).mission.status, 'paused');
  t.r.resume(mission.id, () => {});
  assert.match(t.texts().at(-1), /Do only task t2 \(Message\) now/);
});
