import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_AUTO_MODELS, autoAnswer, judgeOf, splitPicked, claudeArgs, runClaude, JUDGE_SYSTEM } from '../lib/auto.js';
import { SPARKY_SYSTEM } from '../lib/cook.js';

const history = [{ role: 'user', text: 'map or object for a cache?' }];

// Each model answers from `replies`: a string, an Error to throw, or 'hang' to never answer.
function asker(replies) {
  const calls = [];
  const ask = async (model, system, conversation) => {
    calls.push({ model, system, conversation });
    const reply = replies[model];
    if (reply === 'hang') return new Promise(() => {});
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { ask, calls };
}

test('Auto asks Opus, Fable, Gemini Flash Lite and Gemini 3.7 Flash by default', () => {
  assert.deepEqual(DEFAULT_AUTO_MODELS, ['opus', 'fable', 'gemini-3.1-flash-lite', 'gemini-3.7-flash']);
});

test('every model answers in Sparky\'s voice, then the first Claude model judges and merges', async () => {
  const replies = { 'gemini-3.7-flash': 'Use a Map.', opus: 'A Map: ordered keys, any key type.', 'gemini-x': 'Object.' };
  const { ask, calls } = asker(replies);
  let judged;
  const out = await autoAnswer(history, {
    models: ['gemini-3.7-flash', 'opus', 'gemini-x'],
    ask: async (model, system, conversation) => {
      if (system === JUDGE_SYSTEM) {
        judged = { model, conversation };
        return '## Pick\n- Use a Map.\n\nPicked from: opus, gemini-3.7-flash';
      }
      return ask(model, system, conversation);
    },
    timeoutMs: 1000,
  });
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.7-flash', 'opus', 'gemini-x']);
  assert.ok(calls.every((c) => c.system === SPARKY_SYSTEM && c.conversation === history));
  assert.equal(judged.model, 'opus');
  const asked = judged.conversation[0].text;
  assert.match(asked, /<conversation>\nPerson: map or object for a cache\?\n<\/conversation>/);
  for (const [model, text] of Object.entries(replies)) assert.ok(asked.includes(`<answer model="${model}">\n${text}\n</answer>`));
  assert.deepEqual(out, {
    text: '## Pick\n- Use a Map.',
    judge: 'opus',
    picked: ['opus', 'gemini-3.7-flash'],
    answers: [
      { model: 'gemini-3.7-flash', text: 'Use a Map.' },
      { model: 'opus', text: 'A Map: ordered keys, any key type.' },
      { model: 'gemini-x', text: 'Object.' },
    ],
  });
});

test('a model that fails or hangs is listed with why, and the rest are still judged', async () => {
  const { ask } = asker({ opus: new Error('rate limited'), fable: 'hang', 'gemini-a': 'Map.', 'gemini-b': 'A Map.' });
  const out = await autoAnswer(history, {
    models: ['opus', 'fable', 'gemini-a', 'gemini-b'],
    ask: async (model, system, c) => (system === JUDGE_SYSTEM ? `## A\n- Map\n\nPicked from: ${model}` : ask(model, system, c)),
    timeoutMs: 30,
  });
  assert.equal(out.judge, 'gemini-a');
  assert.deepEqual(out.answers.slice(0, 2), [
    { model: 'opus', error: 'rate limited' },
    { model: 'fable', error: 'no answer within 0s' },
  ]);
});

test('one answer needs no judge; no answer at all is an error naming each failure', async () => {
  const one = await autoAnswer(history, { models: ['opus', 'gemini-a'], ask: asker({ opus: new Error('down'), 'gemini-a': 'Map.' }).ask, timeoutMs: 100 });
  assert.deepEqual({ text: one.text, judge: one.judge, picked: one.picked }, { text: 'Map.', judge: null, picked: ['gemini-a'] });
  await assert.rejects(
    autoAnswer(history, { models: ['opus', 'gemini-a'], ask: asker({ opus: new Error('down'), 'gemini-a': new Error('no key') }).ask, timeoutMs: 100 }),
    /no model answered: opus \(down\), gemini-a \(no key\)/,
  );
  await assert.rejects(autoAnswer(history, { models: [], ask: async () => 'x', timeoutMs: 100 }), /pick at least one model for Auto/);
});

test('a judge that fails leaves the first answer, and says why', async () => {
  const out = await autoAnswer(history, {
    models: ['opus', 'gemini-a'],
    ask: async (model, system) => {
      if (system === JUDGE_SYSTEM) throw new Error('judge down');
      return model === 'opus' ? 'Opus says Map.' : 'Gemini says Map.';
    },
    timeoutMs: 100,
  });
  assert.equal(out.text, 'Opus says Map.');
  assert.equal(out.judge, null);
  assert.deepEqual(out.picked, ['opus']);
  assert.equal(out.judgeError, 'judge down');
});

test('the judge is the first Claude model, else the first one listed', () => {
  assert.equal(judgeOf(['gemini-a', 'fable', 'opus']), 'fable');
  assert.equal(judgeOf(['gemini-a', 'gemini-b']), 'gemini-a');
});

test('the judge\'s last "Picked from" line is split off', () => {
  assert.deepEqual(splitPicked('## A\n- x\n\nPicked from: opus,  fable '), { text: '## A\n- x', picked: ['opus', 'fable'] });
  assert.deepEqual(splitPicked('## A\n- x'), { text: '## A\n- x', picked: [] });
});

test('a Claude member runs one-shot: no tools, no user settings or MCP servers, nothing saved', () => {
  assert.deepEqual(claudeArgs('fable', 'SYS'), [
    '-p', '--model', 'fable', '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--system-prompt', 'SYS', '--output-format', 'json', '--no-session-persistence',
  ]);
});

function fakeClaude(stdout, code = 0) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let written = '';
    child.stdin = { end: (text) => (written = text) };
    spawned.push({ cmd, args, opts, written: () => written });
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, spawned };
}

test('runClaude sends the conversation on stdin and returns the result text', async () => {
  const { spawn, spawned } = fakeClaude(JSON.stringify({ result: 'Use a Map.', is_error: false }));
  const text = await runClaude('opus', 'SYS', history, { spawn, cwd: 'C:/tmp', env: { A: '1' } });
  assert.equal(text, 'Use a Map.');
  assert.equal(spawned[0].cmd, 'claude');
  assert.deepEqual(spawned[0].args, claudeArgs('opus', 'SYS'));
  assert.equal(spawned[0].written(), 'Person: map or object for a cache?');
  const failed = fakeClaude(JSON.stringify({ result: 'Credit balance too low', is_error: true }));
  await assert.rejects(runClaude('opus', 'SYS', history, { spawn: failed.spawn, cwd: '.', env: {} }), /Credit balance too low/);
  const broken = fakeClaude('not json', 1);
  await assert.rejects(runClaude('opus', 'SYS', history, { spawn: broken.spawn, cwd: '.', env: {} }), /opus exited with 1/);
});
