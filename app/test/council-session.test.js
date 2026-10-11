import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCouncils } from '../lib/council-session.js';
import { CLAUDE_CANDIDATES, RUBRIC, SECTIONS } from '../staged/plugin/hooks/council.ts';

const BRIEF = '```brief\n{"objective":"speed up the cache","context":[{"file":"src/cache.js","excerpt":"export const get = () => {}"}],"constraints":["no new deps"],"criteria":["p95 under 50 ms"],"verification":["npm run bench"]}\n```';
const scored = (id, over = {}) => ({ id, provider: 'openrouter', name: id, family: id.split('/')[0], access: 'free-hosted', openWeights: true, context: 200000, price: { in: 0, out: 0 }, coding: 50, intelligence: 50, ...over });
const POOL = [...CLAUDE_CANDIDATES, scored('deepseek/a'), scored('qwen/a'), scored('z-ai/a'), scored('moonshotai/a', { access: 'paid-hosted', openWeights: false, price: { in: 2, out: 8 }, intelligence: 90 })];
const letters = (user) => [...user.matchAll(/<proposal letter="(\w)">/g)].map((m) => m[1]);

// A fake io: the brief and every model answer well; the panel comes from POOL.
function fakeIo(pool = POOL) {
  const calls = [];
  return {
    calls,
    io: {
      catalogs: async () => ({ candidates: pool, notes: ['ollama: not running'] }),
      freeRequestsLeft: async () => 40,
      killAll: () => calls.push('killAll'),
      call: async (seat, role, req) => {
        calls.push(role);
        if (role === 'brief') return { text: BRIEF, usd: 0.02 };
        if (role === 'proposer') return { text: SECTIONS.map((s) => `## ${s}\nuse an LRU`).join('\n'), usd: 0 };
        if (role === 'judge') {
          const ls = letters(req.user);
          return { text: '```verdict\n' + JSON.stringify({ scores: Object.fromEntries(ls.map((l, i) => [l, Object.fromEntries(RUBRIC.map((r) => [r.key, 9 - i]))])), rank: ls, preferred: ls[0], ideas: [], risks: [], hybrid: { base: ls[0], take: [], drop: [], conflicts: [], worthIt: false }, confidence: 'high' }) + '\n```', usd: 0.01 };
        }
        return { text: '## Decision\ndominant: A\n## Acceptance criteria\n```mission\n{"title":"Faster cache","criteria":[{"text":"p95 under 50 ms","how":"npm run bench"}]}\n```', usd: 0.05 };
      },
    },
  };
}

function rig({ pool, consents = {}, budget = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spark-councils-'));
  const f = fakeIo(pool);
  const told = [];
  const saved = [];
  const councils = createCouncils({
    root,
    makeIo: () => f.io,
    notify: (m) => told.push(m),
    now: () => new Date(2026, 9, 10, 20, 0, 0).getTime(),
    hex4: () => 'beef',
    shuffle: (n) => [...Array(n).keys()],
    sleep: async () => {},
    deadline: () => new Promise(() => {}),
    consents: () => consents,
    saveConsent: (provider, dataCollection) => saved.push([provider, dataCollection]),
    budgetUsd: () => budget,
  });
  return { root, councils, calls: f.calls, told, saved };
}

test('pre-flight: the brief, the panel with reasons, estimates, consent needed, free requests left, all saved', async () => {
  const r = rig();
  const pre = await r.councils.preflight('speed up the cache', 'light');
  assert.equal(pre.brief.objective, 'speed up the cache');
  assert.deepEqual(pre.panel.proposers.map((s) => s.id), ['sonnet', 'deepseek/a', 'qwen/a', 'z-ai/a']);
  assert.ok(pre.panel.proposers[1].reason.includes('coding index 50'));
  assert.deepEqual(pre.consentNeeded, ['openrouter']);
  assert.equal(pre.freeLeft, 40);
  assert.ok(pre.estimate.meteredUsd > 0);
  assert.ok(pre.notes.includes('ollama: not running'));
  assert.deepEqual(readdirSync(join(r.root, '.spark', 'councils')), [`${pre.id}.json`]);
});

test('run is refused without consent, over the cap, or with empty seats unless reduced', async () => {
  const r = rig({ budget: 0.0001 });
  const pre = await r.councils.preflight('speed up the cache', 'light');
  assert.match((await r.councils.run(pre.id, {})).error, /consent/);
  assert.match((await r.councils.run(pre.id, { consent: true })).error, /cap/);
  const short = rig({ pool: [...CLAUDE_CANDIDATES, scored('deepseek/a'), scored('qwen/a', { context: 200000 }), scored('mistralai/a', { intelligence: 10 })] });
  const p2 = await short.councils.preflight('x', 'light');
  assert.ok(p2.empty.length > 0);
  assert.match((await short.councils.run(p2.id, { consent: true })).error, /reduced panel/);
});

test('a consented run goes through every stage, saves the record, remembers the consent, and hands a mission plan back', async () => {
  const r = rig({ budget: 5 });
  const pre = await r.councils.preflight('speed up the cache', 'light');
  const started = await r.councils.run(pre.id, { consent: true, dataCollection: 'deny' });
  assert.equal(started.started, true);
  const record = await r.councils.finished(pre.id);
  assert.equal(record.status, 'done');
  assert.deepEqual(r.saved, [['openrouter', 'deny']]);
  assert.equal(r.councils.view(pre.id).run.status, 'done');
  const plan = r.councils.toMission(pre.id);
  assert.equal(plan.objective, 'speed up the cache');
  assert.deepEqual(plan.criteria, [{ text: 'p95 under 50 ms', how: 'npm run bench', by: 'claude' }]);
  assert.match(plan.plan, /## Decision/);
  assert.ok(r.told.some((m) => m.kind === 'council' && m.id === pre.id));
});

test('cancel stops the run and kills Claude calls; ids that are not council ids are refused', async () => {
  const r = rig({ budget: 5, consents: { openrouter: { at: 1, dataCollection: 'deny' } } });
  const pre = await r.councils.preflight('speed up the cache', 'light');
  await r.councils.run(pre.id, {});
  r.councils.cancel(pre.id);
  const record = await r.councils.finished(pre.id);
  assert.ok(['cancelled', 'done'].includes(record.status));
  assert.ok(r.calls.includes('killAll'));
  assert.equal(r.councils.view('../x'), undefined);
});
