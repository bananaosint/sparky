import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, parseMarathon, tierOf, startMarathon, noteTool, userSent, onResult, passText, sessionBlock, statusLine, summary } from '../lib/marathon.js';

const result = (over = {}) => ({ kind: 'result', ok: true, text: 'Nothing found.', costUsd: 0, durationMs: 1, usage: { input: 100, output: 50, cacheRead: 9999, cacheWrite: 10 }, ...over });
const begin = (over = {}) => ({ ...startMarathon({ task: 'fix the parser', limits: { timeMs: 90 * 60_000, tokens: 2_000_000 }, now: 0, tier: 'haiku' }), ...over });
const min = (n) => n * 60_000;

test('/marathon reads the task and the limits /goal reads', () => {
  assert.deepEqual(DEFAULT_LIMITS, { timeMs: min(30), tokens: 500_000 });
  assert.deepEqual(parseMarathon('fix the parser'), { task: 'fix the parser', limits: DEFAULT_LIMITS });
  assert.deepEqual(parseMarathon('fix the parser --time 1.5h --tokens 2m'), { task: 'fix the parser', limits: { timeMs: 5_400_000, tokens: 2_000_000 } });
  const sentence = parseMarathon('ship "it" --tokens 200k. --time 45m,');
  assert.equal(sentence.task, 'ship "it"');
  assert.deepEqual(sentence.limits, { timeMs: min(45), tokens: 200_000 });
});

test('bare /marathon is a status request, stop stops, bad input says what is wrong', () => {
  assert.deepEqual(parseMarathon(''), { status: true });
  assert.deepEqual(parseMarathon('  stop '), { stop: true });
  assert.match(parseMarathon('fix it --time soon').error, /--time takes a duration like 45m, 90s or 1\.5h/);
  assert.match(parseMarathon('fix it --tokens').error, /--tokens takes a count like 200k or 2m/);
  assert.match(parseMarathon('fix it --time 0m').error, /above zero/);
  assert.match(parseMarathon('fix it --tokens 0').error, /above zero/);
  assert.match(parseMarathon('--time 1h').error, /say what to work on/);
});

test('a model id maps to its tier', () => {
  assert.equal(tierOf('claude-opus-5-5'), 'opus');
  assert.equal(tierOf('claude-sonnet-5-5'), 'sonnet');
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku');
  assert.equal(tierOf('claude-fable-5-1'), 'fable');
  assert.equal(tierOf('sonnet'), 'sonnet');
  assert.equal(tierOf(''), undefined);
  assert.equal(tierOf(undefined), undefined);
});

test('a turn that ends past the time limit ends the marathon, even mid-task', () => {
  assert.deepEqual(onResult(begin(), result(), { now: min(90) }).next, { kind: 'end', reason: 'time is up' });
});

test('tokens count input, output and cache writes, never cache reads; the cap ends it', () => {
  const s = begin({ limits: { timeMs: min(60), tokens: 1000 } });
  const first = onResult(s, result({ usage: { input: 400, output: 100, cacheRead: 500_000, cacheWrite: 100 } }), { now: 1000 });
  assert.equal(first.state.tokens, 600);
  assert.equal(first.next.kind, 'send');
  const second = onResult(first.state, result({ usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0 } }), { now: 2000 });
  assert.deepEqual(second.next, { kind: 'end', reason: 'token budget spent' });
});

test('a failed turn ends it with the reason', () => {
  assert.deepEqual(onResult(begin(), result({ ok: false, text: 'API Error: overloaded' }), { now: 1000 }).next, { kind: 'end', reason: 'a turn failed: API Error: overloaded' });
});

test('a question to the user waits instead of sending a pass', () => {
  const { next, state } = onResult(begin(), result({ text: 'Keep the old API or break it?' }), { now: 1000 });
  assert.deepEqual(next, { kind: 'wait' });
  assert.equal(state.pass, 1);
});

test('each turn end sends the next pass, one lens at a time, around again after the last', () => {
  let s = begin();
  const texts = [];
  for (let i = 0; i < 8; i++) {
    const r = onResult(s, result(), { now: 1000 * (i + 1) });
    s = r.state;
    texts.push(passText(s, 1000 * (i + 1)));
  }
  assert.match(texts[0], /^Check the original request/);
  assert.match(texts[2], /^Run the full test suite/);
  assert.equal(texts[6].split('\n')[0], texts[0].split('\n')[0]);
  assert.match(texts[0], /<spark-session>marathon pass 2 · /);
  assert.match(texts[0], /reply "Nothing found\." and stop/);
});

test('two idle passes in a row, with half the budget left, step up one tier', () => {
  const s = onResult(begin(), result(), { now: 1000 }).state;
  const a = onResult(s, result(), { now: 2000 });
  assert.equal(a.next.switchTo, undefined);
  const b = onResult(a.state, result(), { now: 3000 });
  assert.equal(b.next.switchTo, 'sonnet');
  assert.equal(b.state.idle, 0);
  assert.equal(b.next.delayMs, 0);
  assert.match(passText(b.state, 3000, 'sonnet'), /model sonnet<\/spark-session>$/);
});

test('idle passes with nowhere higher to go back off: 15s, doubling to 5 minutes; an edit starts over', () => {
  let s = { ...begin({ tier: 'opus' }), forced: true };
  const delays = [];
  for (let i = 0; i < 8; i++) {
    const r = onResult(s, result(), { now: 1000 * (i + 1) });
    s = r.state;
    delays.push(r.next.delayMs);
  }
  assert.deepEqual(delays, [0, 15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.equal(onResult(noteTool(s, 'Edit'), result(), { now: 9000 }).next.delayMs, 0);
});

test('an edit resets the idle count, and no step-up happens late in the budget', () => {
  let s = onResult(begin(), result(), { now: 1000 }).state;
  s = onResult(s, result(), { now: 2000 }).state;
  s = noteTool(s, 'Edit');
  s = onResult(s, result(), { now: 3000 }).state;
  assert.equal(s.idle, 0);
  s = onResult(s, result(), { now: 4000 }).state;
  assert.equal(onResult(s, result(), { now: min(60) }).next.switchTo, undefined);
});

test('the ladder never goes down, stops at opus, and reaches fable only when allowed', () => {
  const up = (tier, top) => onResult({ ...begin({ tier }), forced: true, idle: 1 }, result(), { now: 1000, top }).next.switchTo;
  assert.equal(up('sonnet'), 'opus');
  assert.equal(up('opus'), undefined);
  assert.equal(up('opus', 'fable'), 'fable');
  assert.equal(up('fable', 'fable'), undefined);
  assert.equal(up(undefined), undefined);
});

test('a message from the user is not a pass, and it starts the pace over', () => {
  const s = userSent({ ...begin({ tier: 'opus' }), forced: true, edits: 3, idle: 3 });
  assert.equal(s.forced, false);
  assert.equal(s.edits, 0);
  const r = onResult(s, result(), { now: 1000 });
  assert.equal(r.state.idle, 0);
  assert.equal(r.next.delayMs, 0);
});

test('stop is case-insensitive', () => {
  assert.deepEqual(parseMarathon('Stop'), { stop: true });
});

test('only tools that change files count as edits', () => {
  let s = begin();
  for (const name of ['Read', 'Bash', 'Grep']) s = noteTool(s, name);
  assert.equal(s.edits, 0);
  for (const name of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) s = noteTool(s, name);
  assert.equal(s.edits, 4);
});

test('the session block and the header line say what is left', () => {
  const s = begin({ tier: 'opus', pass: 4, tokens: 612_000 });
  assert.equal(sessionBlock(s, min(49)), '<spark-session>marathon pass 4 · 41m left of 1h30m · 612k of 2M tokens spent · model opus</spark-session>');
  assert.equal(sessionBlock({ ...s, tier: undefined }, min(49)).includes('model'), false);
  assert.equal(statusLine(s, min(49)), '⏱ 41m left · 612k/2M tokens · pass 4');
  assert.equal(statusLine(s, min(100)), '⏱ 0s left · 612k/2M tokens · pass 4');
  assert.equal(summary(s, min(49)), '4 passes · 49m · 612k tokens');
});

test('under ten minutes the clock shows seconds', () => {
  const s = startMarathon({ task: 't', limits: { timeMs: 90_000, tokens: 1000 }, now: 0 });
  assert.equal(statusLine(s, 0), '⏱ 1m30s left · 0/1k tokens · pass 1');
  assert.equal(statusLine(s, 30_000), '⏱ 1m left · 0/1k tokens · pass 1');
  assert.equal(statusLine({ ...s, limits: { timeMs: min(15), tokens: 1000 } }, 0), '⏱ 15m left · 0/1k tokens · pass 1');
});
