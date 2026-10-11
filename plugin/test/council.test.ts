import { test, expect } from 'claude-code/testing'
import { CLAUDE_CANDIDATES, estimate, normalizeGemini, normalizeOllama, normalizeOpenRouter, pickCouncil } from '../hooks/council'
import type { Candidate } from '../hooks/council'

const orModel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created: 1_790_000_000,
  context_length: 131072,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  top_provider: { is_moderated: false, context_length: 131072, max_completion_tokens: 16384 },
  hugging_face_id: `${id.split('/')[0]}/weights`,
  benchmarks: { design_arena: [], artificial_analysis: { coding_index: 50, intelligence_index: 50 } },
  ...over,
})

const scored = (id: string, coding: number, intelligence: number, over: Partial<Candidate> = {}): Candidate => ({
  id,
  provider: 'openrouter',
  name: id,
  family: id.split('/')[0]!,
  access: 'free-hosted',
  openWeights: true,
  context: 131072,
  price: { in: 0, out: 0 },
  coding,
  intelligence,
  ...over,
})

test('openrouter: free from zero prices, open weights from hugging_face_id, benchmarks read, other modalities and routers dropped', () => {
  const list = normalizeOpenRouter({
    data: [
      orModel('deepseek/deepseek-r2:free'),
      orModel('openai/gpt-5.6-luna', { pricing: { prompt: '0.0000002', completion: '0.0000012' }, hugging_face_id: null, benchmarks: { design_arena: [] } }),
      orModel('black-forest/flux', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
      orModel('openrouter/free'),
      orModel('anthropic/claude-opus-5.5'),
    ],
  })
  expect(list.map((c) => c.id)).toEqual(['deepseek/deepseek-r2:free', 'openai/gpt-5.6-luna'])
  expect(list[0]).toMatchObject({ provider: 'openrouter', family: 'deepseek', access: 'free-hosted', openWeights: true, coding: 50, intelligence: 50, context: 131072, maxOutput: 16384 })
  expect(list[1]).toMatchObject({ access: 'paid-hosted', openWeights: false, price: { in: 0.2, out: 1.2 } })
  expect(list[1]!.coding).toBeUndefined()
  expect(normalizeOpenRouter({ nope: 1 })).toEqual([])
})

test('gemini and ollama catalogs become candidates', () => {
  const gemini = normalizeGemini({
    models: [
      { name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-4-31b-it', inputTokenLimit: 131072, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-005', inputTokenLimit: 2048, supportedGenerationMethods: ['embedContent'] },
    ],
  })
  expect(gemini.map((c) => [c.id, c.family, c.access, c.openWeights])).toEqual([
    ['gemini-3.5-flash', 'gemini', 'gemini-key', false],
    ['gemma-4-31b-it', 'gemma', 'gemini-key', true],
  ])
  const local = normalizeOllama({ models: [{ name: 'qwen3:32b', details: { family: 'qwen3' } }] })
  expect(local).toEqual([{ id: 'qwen3:32b', provider: 'ollama', name: 'qwen3:32b', family: 'qwen3', access: 'local', openWeights: true }])
})

test('full: Opus, Sonnet and Fable plus five discovered proposers, one per family, best coding index first', () => {
  const pool = [
    ...CLAUDE_CANDIDATES,
    scored('deepseek/a', 70, 60),
    scored('deepseek/b', 69, 59),
    scored('qwen/a', 65, 62),
    scored('z-ai/a', 60, 58),
    scored('moonshotai/a', 58, 57),
    scored('meta-llama/a', 50, 50),
    scored('mistralai/a', 45, 44),
    scored('google/a', 40, 70, { access: 'paid-hosted', openWeights: false, price: { in: 1, out: 4 } }),
    scored('openai/a', 40, 69, { access: 'paid-hosted', openWeights: false, price: { in: 1, out: 4 }, provider: 'openrouter' }),
    scored('x-ai/a', 40, 68, { access: 'paid-hosted', openWeights: false, price: { in: 1, out: 4 } }),
  ]
  const panel = pickCouncil(pool, 'full', { briefChars: 8000 })
  expect(panel.proposers.map((s) => s.candidate.id)).toEqual(['opus', 'sonnet', 'fable', 'deepseek/a', 'qwen/a', 'z-ai/a', 'moonshotai/a', 'meta-llama/a'])
  expect(panel.proposers[3]!.reason).toContain('coding index 70')
  expect(panel.synth.candidate.id).toBe('fable')
  expect(panel.empty).toEqual([])
  const judgeIds = panel.judges.map((s) => s.candidate.id)
  expect(judgeIds).toHaveLength(3)
  for (const id of judgeIds) expect(panel.proposers.some((p) => p.candidate.id === id)).toBe(false)
  expect(new Set(panel.judges.map((s) => s.candidate.family)).size).toBe(3)
  expect(judgeIds).not.toContain('deepseek/b')
})

test('unscored candidates rank after every scored one, and say so', () => {
  const pool = [...CLAUDE_CANDIDATES, scored('qwen/a', 30, 30), { ...scored('local/x', 0, 0), coding: undefined, intelligence: undefined, provider: 'ollama' as const, access: 'local' as const, context: undefined }]
  const panel = pickCouncil(pool, 'light', { briefChars: 4000 })
  const ids = panel.proposers.map((s) => s.candidate.id)
  expect(ids.indexOf('qwen/a')).toBeLessThan(ids.indexOf('local/x'))
  expect(panel.proposers.find((s) => s.candidate.id === 'local/x')!.reason).toContain('no benchmark data')
})

test('a short pool names the empty seats and never reuses a proposer as a judge', () => {
  const panel = pickCouncil([...CLAUDE_CANDIDATES, scored('qwen/a', 30, 30)], 'full', { briefChars: 4000 })
  expect(panel.proposers.map((s) => s.candidate.id)).toEqual(['opus', 'sonnet', 'fable', 'qwen/a'])
  expect(panel.judges).toEqual([])
  expect(panel.empty).toEqual(['4 of 8 proposer seats', '3 of 3 judge seats'])
})

test('light: Sonnet plus three discovered proposers, two judges, Sonnet synthesizes, Opus may judge', () => {
  const pool = [...CLAUDE_CANDIDATES, scored('deepseek/a', 70, 60), scored('qwen/a', 65, 62), scored('z-ai/a', 60, 58), scored('moonshotai/a', 58, 57)]
  const panel = pickCouncil(pool, 'light', { briefChars: 4000 })
  expect(panel.proposers.map((s) => s.candidate.id)).toEqual(['sonnet', 'deepseek/a', 'qwen/a', 'z-ai/a'])
  expect(panel.judges.map((s) => s.candidate.id)).toEqual(['moonshotai/a', 'opus'])
  expect(panel.synth.candidate.id).toBe('sonnet')
  expect(panel.proposers.map((s) => s.perspective)).toEqual(['simplest viable implementation', 'strongest architecture', 'performance and scalability', 'reliability and failure recovery'])
})

test('estimates: paid by price, free at $0, Claude on your plan, Gemini not reported', () => {
  const paid = scored('openai/a', 40, 40, { access: 'paid-hosted', price: { in: 1, out: 4 } })
  expect(estimate(paid, 40_000, 'proposer', 'light')).toEqual({ usd: 0.02, label: '~$0.02' })
  expect(estimate(scored('qwen/a', 1, 1), 40_000, 'proposer', 'light')).toEqual({ usd: 0, label: '$0 (free hosted)' })
  expect(estimate(CLAUDE_CANDIDATES[0]!, 40_000, 'proposer', 'light').label).toBe('on your Claude plan; reported after the run')
  expect(estimate({ ...scored('gemini-x', 1, 1), provider: 'gemini', access: 'gemini-key', price: undefined }, 4000, 'judge', 'light')).toEqual({ label: 'on your Gemini key; cost not reported' })
})

test('when only used families are left, a judge may share a proposer family (never a proposer) and says so', () => {
  const gemini = (id: string, context: number): Candidate => ({ id, provider: 'gemini', name: id, family: id.startsWith('gemma') ? 'gemma' : 'gemini', access: 'gemini-key', openWeights: id.startsWith('gemma'), context })
  const pool = [...CLAUDE_CANDIDATES, gemini('gemini-3.8-flash', 1_048_576), gemini('gemini-3.5-flash', 1_000_000), gemini('gemma-4-31b-it', 131_072)]
  const panel = pickCouncil(pool, 'light', { briefChars: 4000 })
  expect(panel.proposers.map((s) => s.candidate.id)).toEqual(['sonnet', 'gemini-3.8-flash', 'gemma-4-31b-it'])
  expect(panel.judges.map((s) => s.candidate.id)).toEqual(['gemini-3.5-flash', 'opus'])
  expect(panel.judges[0]!.reason).toContain('same family as a proposer')
  expect(panel.empty).toEqual(['1 of 4 proposer seats'])
})

test('local models under 7B parameters are left out: they can not follow the proposal format', () => {
  const local = normalizeOllama({
    models: [
      { name: 'moondream:latest', details: { family: 'moondream', parameter_size: '1.8B' } },
      { name: 'gemma3:270m', details: { family: 'gemma3', parameter_size: '270M' } },
      { name: 'qwen3:32b', details: { family: 'qwen3', parameter_size: '32.8B' } },
      { name: 'mystery:latest', details: { family: 'mystery' } },
    ],
  })
  expect(local.map((c) => c.id)).toEqual(['qwen3:32b', 'mystery:latest'])
})

test('with no benchmarks and equal context, the newer Gemini version ranks first', () => {
  const gemini = normalizeGemini({
    models: [
      { name: 'models/gemini-2.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-4-31b-it', inputTokenLimit: 131072, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-3-27b-it', inputTokenLimit: 131072, supportedGenerationMethods: ['generateContent'] },
    ],
  })
  const panel = pickCouncil([...CLAUDE_CANDIDATES, ...gemini], 'light', { briefChars: 1000 })
  expect(panel.proposers.map((s) => s.candidate.id)).toEqual(['sonnet', 'gemini-3.8-flash', 'gemma-4-31b-it'])
})
