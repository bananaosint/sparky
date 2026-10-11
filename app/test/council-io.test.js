import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCouncilIo } from '../lib/council-io.js';

const HOUR = 3600_000;
const orCatalog = { data: [{ id: 'qwen/qwen4:free', name: 'Qwen 4', created: 1, context_length: 131072, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, top_provider: { is_moderated: false }, hugging_face_id: 'Qwen/Qwen4' }] };
const geminiCatalog = { models: [{ name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }] };

const response = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

function fakeSpawn(reply) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    child.stdin = {
      end: (input) => {
        spawned.push({ cmd, args, opts, input });
        if (reply !== 'hang')
          setImmediate(() => {
            child.stdout.emit('data', JSON.stringify(reply));
            child.emit('close', 0);
          });
      },
    };
    spawned.at(-1);
    return child;
  };
  return { spawn, spawned };
}

function rig({ keys = { openrouter: 'sk-or', gemini: 'AIza' }, fetchImpl, reply = { result: 'ok', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } }, now = () => 10 * HOUR } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spark-council-io-'));
  const cachePath = join(dir, 'council-catalog.json');
  const fetched = [];
  const f =
    fetchImpl ??
    (async (url) => {
      fetched.push(url);
      if (url.includes('openrouter.ai/api/v1/models')) return response(200, orCatalog);
      if (url.includes('generativelanguage')) return response(200, geminiCatalog);
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
  const { spawn, spawned } = fakeSpawn(reply);
  const io = createCouncilIo({ fetchImpl: f, spawn, keys, cwd: dir, scratch: tmpdir(), env: {}, cachePath, now, dataCollection: 'deny' });
  return { io, cachePath, fetched, spawned };
}

test('catalogs: Claude always, OpenRouter and Gemini with their keys, Ollama only when it answers', async () => {
  const r = rig();
  const { candidates, notes } = await r.io.catalogs();
  assert.deepEqual(candidates.map((c) => c.id), ['opus', 'sonnet', 'fable', 'haiku', 'qwen/qwen4:free', 'gemini-3.5-flash']);
  assert.ok(notes.some((n) => n.startsWith('ollama: not running')));
});

test('a catalog fetched within 6 hours comes from the cache; a stale one is used, with its age, when the fetch fails', async () => {
  const r = rig({ now: () => 10 * HOUR });
  writeFileSync(r.cachePath, JSON.stringify({ openrouter: { at: 9 * HOUR, json: orCatalog }, gemini: { at: 1 * HOUR, json: geminiCatalog } }));
  const failing = rig({ fetchImpl: async (url) => (url.includes('generativelanguage') ? response(503, {}) : Promise.reject(new Error('offline'))) });
  writeFileSync(failing.cachePath, JSON.stringify({ gemini: { at: 1 * HOUR, json: geminiCatalog } }));
  await r.io.catalogs();
  assert.ok(!r.fetched.some((u) => u.includes('openrouter.ai/api/v1/models')));
  assert.ok(r.fetched.some((u) => u.includes('generativelanguage')));
  const out = await failing.io.catalogs();
  assert.ok(out.candidates.some((c) => c.id === 'gemini-3.5-flash'));
  assert.ok(out.notes.some((n) => /gemini: .*copy from 9 h ago/.test(n)));
});

test('without a key the provider is left out and the note says so', async () => {
  const r = rig({ keys: {} });
  const { candidates, notes } = await r.io.catalogs();
  assert.deepEqual(candidates.map((c) => c.provider).filter((p) => p !== 'claude'), []);
  assert.ok(notes.includes('openrouter: no key'));
  assert.ok(notes.includes('gemini: no key'));
});

test('calls go to the right provider; Claude reads the project only for the brief and the synthesis', async () => {
  const sent = [];
  const r = rig({
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return response(200, url.includes('openrouter') ? { choices: [{ message: { content: 'or answer' } }], usage: { cost: 0.002 } } : { candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] });
    },
  });
  const signal = new AbortController().signal;
  const req = { system: 's', user: 'u', maxTokens: 100 };
  const or = await r.io.call({ candidate: { id: 'qwen/qwen4:free', provider: 'openrouter' } }, 'proposer', req, signal);
  assert.deepEqual(or, { text: 'or answer', usd: 0.002 });
  assert.equal(sent[0].body.provider.data_collection, 'deny');
  await r.io.call({ candidate: { id: 'gemini-3.5-flash', provider: 'gemini' } }, 'judge', req, signal);
  assert.match(sent[1].url, /gemini-3\.5-flash:generateContent/);
  await r.io.call({ candidate: { id: 'sonnet', provider: 'claude' } }, 'proposer', req, signal);
  await r.io.call({ candidate: { id: 'fable', provider: 'claude' } }, 'synth', req, signal);
  const [proposer, synth] = r.spawned;
  assert.equal(proposer.args[proposer.args.indexOf('--tools') + 1], '');
  assert.equal(proposer.opts.cwd, tmpdir());
  assert.equal(synth.args[synth.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(synth.input, 'u');
});

test('a 429 carries its wait, a 404 is unavailable; killAll stops running Claude calls', async () => {
  const r = rig({ fetchImpl: async (url) => (url.includes('openrouter') ? response(429, { error: { message: 'rate limited' } }, { 'retry-after': '7' }) : response(404, { error: { message: 'No endpoints found matching your data policy' } })) });
  const signal = new AbortController().signal;
  const req = { system: 's', user: 'u', maxTokens: 100 };
  await assert.rejects(r.io.call({ candidate: { id: 'x/y', provider: 'openrouter' } }, 'judge', req, signal), (e) => e.retry && e.waitMs === 7000);
  await assert.rejects(r.io.call({ candidate: { id: 'g', provider: 'gemini' } }, 'judge', req, signal), (e) => e.unavailable && /data policy/.test(e.message));
  const hanging = rig({ reply: 'hang' });
  const pending = hanging.io.call({ candidate: { id: 'opus', provider: 'claude' } }, 'proposer', req, signal);
  await new Promise((r2) => setImmediate(r2));
  hanging.io.killAll();
  await assert.rejects(pending);
});

test('free requests left today come from the key endpoint', async () => {
  const r = rig({ fetchImpl: async () => response(200, { data: { free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } }) });
  assert.equal(await r.io.freeRequestsLeft(), 38);
  assert.equal(await rig({ keys: {} }).io.freeRequestsLeft(), undefined);
});
