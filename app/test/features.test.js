import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, withModes } from '../lib/commands.js';
import { payer, costLine } from '../lib/account.js';
import { skillDescription, describeSkills, listSkills } from '../lib/skills.js';
import { cookPrompt, quickAnswer, SPARKY_SYSTEM } from '../lib/cook.js';

test("Sparky answers in depth: 2 to 4 headed sections of 3 to 6 bullets, and knows Gemini may have rewritten the message", () => {
  assert.match(SPARKY_SYSTEM, /2 to 4 sections, each opening with a "## " header, with 3 to 6 "- " bullets under each/);
  assert.match(SPARKY_SYSTEM, /may have been rewritten by Gemini before it reached you/);
});

test('with rewriting off, the typed prompt goes out with only the Skills line', async () => {
  const out = await cookPrompt('add a dark mode toggle please', {
    key: 'k',
    rewrite: false,
    skills: [{ name: 'tdd', description: 'test first' }],
    routeModels: ['r'],
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"skills":["tdd"]}' }] } }] }) }),
  });
  assert.equal(out.text, 'add a dark mode toggle please\n\nSkills: tdd');
});
import { parseLine } from '../lib/stream.js';

test('slash commands: modes and pickers stay in the window, anything else passes through', () => {
  assert.deepEqual(parseCommand('/antislop'), { kind: 'mode', mode: 'anti-slop' });
  assert.deepEqual(parseCommand('/anti-slop'), { kind: 'mode', mode: 'anti-slop' });
  assert.deepEqual(parseCommand('/red-team'), { kind: 'mode', mode: 'thinking-red-team' });
  assert.deepEqual(parseCommand('/model Sonnet'), { kind: 'model', model: 'sonnet' });
  assert.deepEqual(parseCommand('/effort max'), { kind: 'effort', effort: 'max' });
  assert.deepEqual(parseCommand('/marathon fix the parser --time 1h'), { kind: 'marathon', args: 'fix the parser --time 1h' });
  assert.deepEqual(parseCommand('/marathon'), { kind: 'marathon', args: '' });
  assert.deepEqual(parseCommand('/superpowers:brainstorming plan a cache'), { kind: 'passthrough' });
  assert.equal(parseCommand('fix the bug'), null);
  assert.equal(withModes('fix it', ['anti-slop']), 'fix it\n\n<spark-modes>anti-slop</spark-modes>');
  assert.equal(withModes('fix it', []), 'fix it');
});

test('the payer: a Claude plan counts toward limits, an API key is billed', () => {
  const max = payer({ apiKeySource: 'none', account: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' } });
  assert.deepEqual(max, { label: 'Claude Max 20x', billed: false, note: 'counts toward your Claude Max 20x limits, not billed per message' });
  assert.match(payer({ apiKeySource: 'none', account: { organizationType: 'claude_pro', hasExtraUsageEnabled: true } }).note, /extra usage past them is billed/);
  assert.equal(payer({ apiKeySource: 'ANTHROPIC_API_KEY' }).billed, true);
  assert.equal(
    costLine({ costUsd: 0.1874, model: 'claude-opus-5-5', usage: { input: 3, cacheRead: 12000, cacheWrite: 300, output: 420 }, tools: 1 }, max),
    '≈$0.1874 for claude-opus-5-5: 12.3k in · 420 out · 1 tool · counts toward your Claude Max 20x limits, not billed per message',
  );
});

test('skill descriptions come from SKILL.md front matter, for user and plugin skills', () => {
  assert.equal(skillDescription('---\nname: tdd\ndescription: "Use when writing code: test first"\n---\nbody'), 'Use when writing code: test first');
  const home = mkdtempSync(join(tmpdir(), 'spark-home-'));
  mkdirSync(join(home, '.claude', 'skills', 'grillme'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'grillme', 'SKILL.md'), '---\ndescription: Interrogate a plan\n---\n');
  const dir = join(home, '.claude', 'plugins', 'cache', 'market', 'superpowers', '6.4.1', 'skills', 'brainstorming');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Turn ideas into designs\n---\n');
  assert.deepEqual(describeSkills(['grillme', 'superpowers:brainstorming', 'missing'], home), [
    { name: 'grillme', description: 'Interrogate a plan' },
    { name: 'superpowers:brainstorming', description: 'Turn ideas into designs' },
    { name: 'missing', description: '' },
  ]);
});

test('before Claude Code reports its skills, they are read from disk: own skills and enabled plugins', () => {
  const home = mkdtempSync(join(tmpdir(), 'spark-home-'));
  mkdirSync(join(home, '.claude', 'skills', 'grillme'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'grillme', 'SKILL.md'), '---\ndescription: x\n---\n');
  mkdirSync(join(home, '.claude', 'skills', 'notes'), { recursive: true });
  for (const [plugin, version] of [['superpowers', '6.4.1'], ['superpowers', '6.10.0'], ['off', '1.0.0']]) {
    const dir = join(home, '.claude', 'plugins', 'cache', 'market', plugin, version, 'skills', version === '6.4.1' ? 'old-skill' : 'brainstorming');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: y\n---\n');
  }
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@market': true, 'off@market': false } }));
  assert.deepEqual(listSkills(home), ['grillme', 'superpowers:brainstorming']);
});

const reply = (json) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });

test('cooking rewrites and picks skills side by side, and the Skills line rides along', async () => {
  const fetchImpl = async (_url, init) => {
    const system = JSON.parse(init.body).systemInstruction.parts[0].text;
    return system.startsWith('You rewrite') ? reply({ prompt: 'Add a dark mode toggle.', unclear: [] }) : reply({ skills: ['tdd', 'nope'] });
  };
  const out = await cookPrompt('add dark mode', {
    key: 'k',
    rewriteModels: ['r'],
    routeModels: ['s'],
    skills: [{ name: 'tdd', description: 'Test-driven development' }],
    fetchImpl,
  });
  assert.deepEqual(out, {
    text: '(Gemini (r) rewrote this prompt from what I typed. If part of it seems to contradict what I meant, ask me.)\n\nAdd a dark mode toggle.\n\nSkills: tdd',
    model: 'r', rewriteError: undefined, skills: ['tdd'], skillsModel: 's' });
});

test('with rewriting off, only the skills are added to the prompt as typed', async () => {
  const out = await cookPrompt('add dark mode', {
    key: 'k',
    rewrite: false,
    rewriteModels: ['r'],
    routeModels: ['s'],
    skills: [{ name: 'tdd', description: 'x' }],
    fetchImpl: async () => reply({ skills: ['tdd'] }),
  });
  assert.equal(out.text, 'add dark mode\n\nSkills: tdd');
  assert.equal(out.model, undefined);
});

test('a quick answer sends the chat and images to Gemini and returns its text', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Use **Map**.' }] } }] }) };
  };
  const out = await quickAnswer([{ role: 'user', text: 'map or object?', images: [{ mediaType: 'image/png', data: 'AAAA' }] }], { key: 'k', rewriteModels: ['q'], fetchImpl });
  assert.deepEqual(out, { text: 'Use **Map**.', model: 'q' });
  assert.deepEqual(sent.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
});

test('init carries the skills and key source; a result carries token usage', () => {
  assert.deepEqual(parseLine('{"type":"system","subtype":"init","session_id":"s","model":"m","skills":["tdd"],"apiKeySource":"none"}'), [
    { kind: 'init', sessionId: 's', model: 'm', skills: ['tdd'], apiKeySource: 'none' },
  ]);
  const [result] = parseLine(
    '{"type":"result","subtype":"success","result":"ok","total_cost_usd":0.2,"duration_ms":10,"usage":{"input_tokens":3,"output_tokens":420,"cache_read_input_tokens":12000,"cache_creation_input_tokens":300}}',
  );
  assert.deepEqual(result.usage, { input: 3, output: 420, cacheRead: 12000, cacheWrite: 300 });
});

test('/mission becomes a mission command with its arguments', () => {
  assert.deepEqual(parseCommand('/mission rate-limit the login route'), { kind: 'mission', args: 'rate-limit the login route' });
  assert.deepEqual(parseCommand('/mission'), { kind: 'mission', args: '' });
});
