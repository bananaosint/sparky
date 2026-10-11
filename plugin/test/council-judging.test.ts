import { test, expect } from 'claude-code/testing'
import { RUBRIC, aggregate, blind, briefPrompt, missingSections, parseBrief, parseVerdict, proposalPrompt, judgePrompt, synthPrompt } from '../hooks/council'
import type { Verdict } from '../hooks/council'

const full = (scores: Record<string, number>) => Object.fromEntries(RUBRIC.map((r) => [r.key, scores[r.key] ?? scores.all ?? 0]))
const verdict = (over: Partial<Verdict> & { scores: Verdict['scores']; rank: string[] }): Verdict => ({
  preferred: over.rank[0]!,
  ideas: [],
  risks: [],
  hybrid: { base: over.rank[0]!, take: [], drop: [], conflicts: [], worthIt: false },
  confidence: 'medium',
  ...over,
})
const block = (j: unknown) => `Here it is.\n\`\`\`verdict\n${JSON.stringify(j)}\n\`\`\``

test('the brief: last block wins, excerpts capped at 12 and 6,000 characters, secrets redacted', () => {
  const excerpts = Array.from({ length: 15 }, (_, i) => ({ file: `src/f${i}.js`, excerpt: 'x'.repeat(1000) }))
  const text = '```brief\n' + JSON.stringify({ objective: 'speed up the cache', context: excerpts, constraints: ['no new deps'], criteria: ['p95 under 50 ms'], verification: ['bench'] }) + '\n```'
  const b = parseBrief(text)!
  expect(b.objective).toBe('speed up the cache')
  expect(b.context.length).toBeLessThanOrEqual(12)
  expect(b.context.reduce((n, c) => n + c.excerpt.length, 0)).toBeLessThanOrEqual(6000)
  const leaky = parseBrief('```brief\n' + JSON.stringify({ objective: 'x', context: [{ file: '.env', excerpt: `API_KEY=sk-${'a'.repeat(30)}` }], constraints: [], criteria: [], verification: [] }) + '\n```')!
  expect(leaky.context[0]!.excerpt).not.toContain('sk-aaa')
  expect(parseBrief('no block')).toBeUndefined()
  expect(briefPrompt('speed up the cache')).toContain('```brief')
})

test('a proposal must carry sections A, C, D, F, G and H', () => {
  const good = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((l) => `## ${l}. Heading\ntext`).join('\n')
  expect(missingSections(good)).toEqual([])
  expect(missingSections('## A. Recommendation\n## B. Interpretation\n## D) Plan')).toEqual(['C', 'F', 'G', 'H'])
  const p = proposalPrompt({ objective: 'x', context: [], constraints: [], criteria: [], verification: [] }, 'security and correctness', 'light')
  expect(p.user).toContain('security and correctness')
  expect(p.system).toContain('900 words')
})

test('verdicts are checked: every letter scored 0–10 on every criterion, rank a permutation, severities from the list', () => {
  const ok = { scores: { A: full({ all: 7 }), B: full({ all: 5 }) }, rank: ['A', 'B'], preferred: 'A', alternative: 'B', ideas: [{ proposal: 'B', idea: 'a cache key per tenant' }], risks: [{ proposal: 'A', issue: 'races', severity: 'major', evidence: 'two writers' }], hybrid: { base: 'A', take: [{ from: 'B', contribution: 'tenant keys' }], drop: [], conflicts: [], worthIt: true }, confidence: 'high' }
  expect(parseVerdict(block(ok), ['A', 'B'])?.preferred).toBe('A')
  expect(parseVerdict(block({ ...ok, scores: { A: ok.scores.A } }), ['A', 'B'])).toBeUndefined()
  expect(parseVerdict(block({ ...ok, scores: { ...ok.scores, C: ok.scores.A } }), ['A', 'B'])).toBeUndefined()
  expect(parseVerdict(block({ ...ok, scores: { ...ok.scores, B: full({ all: 11 }) } }), ['A', 'B'])).toBeUndefined()
  expect(parseVerdict(block({ ...ok, rank: ['A', 'A'] }), ['A', 'B'])).toBeUndefined()
  expect(parseVerdict(block({ ...ok, risks: [{ proposal: 'A', issue: 'x', severity: 'apocalyptic', evidence: '' }] }), ['A', 'B'])).toBeUndefined()
  expect(parseVerdict('no block', ['A', 'B'])).toBeUndefined()
})

test('blind packets: letters from the shuffle, model and vendor names stripped, the mapping kept', () => {
  const out = blind(
    [
      { seatId: 'opus', family: 'claude', text: 'As Claude Opus, I suggest a write-through cache.' },
      { seatId: 'deepseek/deepseek-r2:free', family: 'deepseek', text: 'DeepSeek-R2 here. Use an LRU.' },
    ],
    () => [1, 0],
  )
  expect(out.packets.map((p) => p.letter)).toEqual(['A', 'B'])
  expect(out.mapping).toEqual({ A: 'deepseek/deepseek-r2:free', B: 'opus' })
  expect(out.packets[0]!.text).toBe('[model] here. Use an LRU.')
  expect(out.packets[1]!.text).toBe('As [model] [model], I suggest a write-through cache.')
})

test('aggregate: Spark computes the weighted totals; a proposal leading every judge dominates', () => {
  const v1 = verdict({ scores: { A: full({ all: 9 }), B: full({ all: 6 }), C: full({ all: 5 }) }, rank: ['A', 'B', 'C'] })
  const v2 = verdict({ scores: { A: full({ all: 8 }), B: full({ all: 7 }), C: full({ all: 4 }) }, rank: ['A', 'B', 'C'] })
  const a = aggregate([v1, v2], ['A', 'B', 'C'])
  expect(a.totals.A).toEqual([90, 80])
  expect(a.mean.A).toBe(85)
  expect(a.borda).toEqual({ A: 4, B: 2, C: 0 })
  expect(a.firsts.A).toBe(2)
  expect(a.case).toBe('dominant')
  expect(a.leader).toBe('A')
})

test('aggregate: a critical flag stops the top proposal from dominating', () => {
  const flagged = verdict({ scores: { A: full({ all: 9 }), B: full({ all: 6 }) }, rank: ['A', 'B'], risks: [{ proposal: 'A', issue: 'drops writes on crash', severity: 'critical', evidence: 'no fsync' }] })
  const other = verdict({ scores: { A: full({ all: 9 }), B: full({ all: 6 }) }, rank: ['A', 'B'] })
  const a = aggregate([flagged, other], ['A', 'B'])
  expect(a.case).not.toBe('dominant')
  expect(a.flags).toEqual([{ proposal: 'A', issue: 'drops writes on crash', evidence: 'no fsync', judge: 0 }])
})

test('aggregate: hybrid when most judges say so, contested when nothing leads, inadequate under 55', () => {
  const h = (rank: string[], worthIt: boolean) => verdict({ scores: { A: full({ all: 7 }), B: full({ all: 7 }) }, rank, hybrid: { base: 'A', take: [{ from: 'B', contribution: 'x' }], drop: [], conflicts: [], worthIt } })
  expect(aggregate([h(['A', 'B'], true), h(['B', 'A'], true)], ['A', 'B']).case).toBe('hybrid')
  expect(aggregate([h(['A', 'B'], false), h(['B', 'A'], false)], ['A', 'B']).case).toBe('contested')
  const weak = verdict({ scores: { A: full({ all: 5 }), B: full({ all: 3 }) }, rank: ['A', 'B'] })
  expect(aggregate([weak, weak], ['A', 'B']).case).toBe('inadequate')
})

test('aggregate lists criteria where judges differ by 3 points or more', () => {
  const v1 = verdict({ scores: { A: full({ all: 8, security: 9 }), B: full({ all: 6 }) }, rank: ['A', 'B'] })
  const v2 = verdict({ scores: { A: full({ all: 8, security: 4 }), B: full({ all: 6 }) }, rank: ['A', 'B'] })
  expect(aggregate([v1, v2], ['A', 'B']).disagreements).toEqual([{ proposal: 'A', criterion: 'security', low: 4, high: 9 }])
})

test('judge and synthesis prompts carry what they need and no model names', () => {
  const brief = { objective: 'speed up the cache', context: [], constraints: [], criteria: [], verification: [] }
  const packets = [{ letter: 'A', text: 'use an LRU' }, { letter: 'B', text: 'write-through' }]
  const j = judgePrompt(brief, packets)
  expect(j.user).toContain('<proposal letter="A">')
  expect(j.system).toContain('```verdict')
  for (const r of RUBRIC) expect(j.system).toContain(r.label)
  const v = verdict({ scores: { A: full({ all: 8 }), B: full({ all: 6 }) }, rank: ['A', 'B'] })
  const s = synthPrompt(brief, packets, [v], aggregate([v], ['A', 'B']))
  expect(s.system).toContain('```mission')
  expect(s.user).toContain('"case": "dominant"')
})
