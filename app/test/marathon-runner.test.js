import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarathon } from '../lib/marathon-runner.js';

const min = (n) => n * 60_000;
const result = (over = {}) => ({ kind: 'result', ok: true, text: 'Nothing found.', costUsd: 0, durationMs: 1, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, ...over });
const edit = { kind: 'tool', id: 't1', name: 'Edit', input: {} };

// A marathon with Claude Code and the window replaced by arrays: `lines` is what reaches Claude Code
// (parsed), `told` what reaches the window.
function rig({ picker = 'haiku', model = 'claude-haiku-5-5', limits = { timeMs: min(90), tokens: 2_000_000 }, top = 'opus' } = {}) {
  let clock = 0;
  const lines = [];
  const told = [];
  // Waits the marathon schedules: `fn` runs when the delay is up, unless it was cancelled.
  const jobs = [];
  const schedule = (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    jobs.push(job);
    return () => (job.cancelled = true);
  };
  const m = createMarathon({ write: (line) => lines.push(JSON.parse(line)), notify: (x) => told.push(x), now: () => clock, top: () => top, schedule });
  m.onEvent({ kind: 'init', sessionId: 's1', model, skills: [] });
  m.start({ task: 'fix the parser', limits, picker });
  const passes = () => lines.filter((l) => l.type === 'user').map((l) => l.message.content[0].text);
  const switches = () => lines.filter((l) => l.type === 'control_request');
  return { m, lines, told, jobs, passes, switches, at: (n) => (clock = min(n)) };
}

// On opus, with nowhere higher to go: the task turn, an idle pass, then the second idle pass waits.
function idleOnOpus(over) {
  const r = rig({ picker: 'opus', model: 'claude-opus-5-5', ...over });
  r.m.outgoing({ text: 'fix the parser' });
  for (const n of [1, 2, 3]) {
    r.at(n);
    r.m.onEvent(result());
  }
  return r;
}

// The task turn and two idle passes after it: the third result asks for a stronger model.
function idleUntilSwitch(r) {
  r.m.outgoing({ text: 'fix the parser' });
  for (const n of [1, 2, 3]) {
    r.at(n);
    r.m.onEvent(result());
  }
}

test('the first message carries the session block, and a result sends the next pass', () => {
  const r = rig();
  assert.deepEqual(r.told.map((t) => t.kind), ['start']);
  const sent = r.m.outgoing({ text: 'fix the parser' });
  assert.equal(sent.text, 'fix the parser\n\n<spark-session>marathon pass 1 · 1h30m left of 1h30m · 0 of 2M tokens spent · model haiku</spark-session>');
  r.at(5);
  r.m.onEvent(result());
  assert.equal(r.passes().length, 1);
  assert.match(r.passes()[0], /^Check the original request/);
  assert.deepEqual(r.told.map((t) => t.kind), ['start', 'pass']);
  assert.match(r.told[1].lens, /^Check the original request/);
});

test('two idle passes move Claude up a tier, and the end puts the picker model back', () => {
  const r = rig({ picker: 'haiku' });
  idleUntilSwitch(r);
  const [ask] = r.switches();
  assert.equal(ask.request.model, 'sonnet');
  assert.equal(r.lines.at(-2), ask);
  assert.match(r.passes().at(-1), /model sonnet<\/spark-session>$/);
  r.m.onEvent({ kind: 'control', id: ask.request_id, ok: true });
  assert.equal(r.told.at(-1).kind, 'switched');
  assert.equal(r.told.at(-1).tier, 'sonnet');
  r.at(90);
  r.m.onEvent(result());
  assert.deepEqual(r.told.at(-1), { kind: 'end', reason: 'time is up', summary: '4 passes · 1h30m · 600 tokens' });
  assert.equal(r.switches().length, 2);
  assert.equal(r.switches().at(-1).request.model, 'haiku');
});

test('with the default model picked, the end puts the default back', () => {
  const r = rig({ picker: 'default', model: 'claude-haiku-5-5' });
  idleUntilSwitch(r);
  r.m.onEvent({ kind: 'control', id: r.switches()[0].request_id, ok: true });
  r.at(90);
  r.m.onEvent(result());
  assert.deepEqual(r.switches().at(-1).request, { subtype: 'set_model' });
});

test('a refused switch is reported, the marathon goes on, and nothing is restored at the end', () => {
  const r = rig();
  idleUntilSwitch(r);
  r.m.onEvent({ kind: 'control', id: r.switches()[0].request_id, ok: false, error: "Model 'sonnet' not found" });
  assert.equal(r.told.at(-1).kind, 'switch-failed');
  assert.equal(r.told.at(-1).error, "Model 'sonnet' not found");
  const before = r.passes().length;
  r.at(10);
  r.m.onEvent(result());
  assert.equal(r.passes().length, before + 1);
  r.at(90);
  r.m.onEvent(result());
  assert.equal(r.told.at(-1).kind, 'end');
  assert.equal(r.switches().length, 1);
});

test('edits during the passes keep Claude on the model it has', () => {
  const r = rig();
  r.m.outgoing({ text: 'fix the parser' });
  for (const n of [1, 2, 3, 4, 5]) {
    r.at(n);
    r.m.onEvent(edit);
    r.m.onEvent(result());
  }
  assert.equal(r.switches().length, 0);
});

test('a question waits; the reply is not a pass and cannot count as idle', () => {
  const r = rig();
  r.m.outgoing({ text: 'fix the parser' });
  r.m.onEvent(result({ text: 'Keep the old API or break it?' }));
  assert.equal(r.lines.length, 0);
  const reply = r.m.outgoing({ text: 'keep it' });
  assert.match(reply.text, /^keep it\n\n<spark-session>marathon pass 1 · /);
  r.m.onEvent(result());
  assert.equal(r.passes().length, 1);
});

test('a failed turn ends the marathon with the reason and leaves the model alone', () => {
  const r = rig();
  r.m.outgoing({ text: 'fix the parser' });
  r.m.onEvent(result({ ok: false, text: 'API Error: overloaded' }));
  assert.equal(r.told.at(-1).reason, 'a turn failed: API Error: overloaded');
  assert.equal(r.lines.length, 0);
});

test('a stop or restart ends it without touching the model, and later events do nothing', () => {
  const r = rig();
  idleUntilSwitch(r);
  r.m.onEvent({ kind: 'control', id: r.switches()[0].request_id, ok: true });
  r.m.end('you pressed stop', { restore: false });
  assert.equal(r.told.at(-1).reason, 'you pressed stop');
  const written = r.lines.length;
  r.m.onEvent(result());
  assert.equal(r.lines.length, written);
  assert.deepEqual(r.m.outgoing({ text: 'hi' }), { text: 'hi' });
});

test('on the strongest model, idle passes wait, and the pass is written when the wait is over', () => {
  const r = idleOnOpus();
  assert.equal(r.passes().length, 2);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].ms, 15_000);
  assert.deepEqual(r.told.at(-1).kind, 'wait');
  assert.equal(r.told.at(-1).ms, 15_000);
  r.at(4);
  r.jobs[0].fn();
  assert.equal(r.passes().length, 3);
  assert.match(r.passes().at(-1), /^Run the full test suite/);
  assert.match(r.passes().at(-1), /<spark-session>marathon pass 4 · 1h26m left of 1h30m/);
  assert.equal(r.told.at(-1).kind, 'pass');
});

test('a wait never outlasts the time limit: the marathon ends when the time is up', () => {
  const r = idleOnOpus();
  r.at(89.875);
  r.m.onEvent(result());
  const wait = r.jobs.at(-1);
  assert.equal(wait.ms, 7500);
  r.at(90);
  const sent = r.passes().length;
  wait.fn();
  assert.equal(r.passes().length, sent);
  assert.equal(r.told.at(-1).reason, 'time is up');
});

test('a message from the user, a stop or a restart cancels the wait', () => {
  const byUser = idleOnOpus();
  byUser.m.outgoing({ text: 'hold on' });
  assert.equal(byUser.jobs[0].cancelled, true);

  const byStop = idleOnOpus();
  byStop.m.end('you stopped it', { restore: true });
  assert.equal(byStop.jobs[0].cancelled, true);
  const sent = byStop.passes().length;
  byStop.jobs[0].fn();
  assert.equal(byStop.passes().length, sent);

  const byRestart = idleOnOpus();
  byRestart.m.restarted();
  assert.equal(byRestart.jobs[0].cancelled, true);
});

test('running says whether a marathon is on', () => {
  const r = rig();
  assert.equal(r.m.running(), true);
  r.m.end('you stopped it', { restore: true });
  assert.equal(r.m.running(), false);
});

test('a marathon that is not running ignores the stream', () => {
  const lines = [];
  const m = createMarathon({ write: (l) => lines.push(l), notify: () => lines.push('told'), now: () => 0, top: () => 'opus' });
  m.onEvent({ kind: 'init', sessionId: 's', model: 'claude-opus-5-5', skills: [] });
  m.onEvent(result());
  m.end('stopped', { restore: true });
  assert.deepEqual(lines, []);
});
