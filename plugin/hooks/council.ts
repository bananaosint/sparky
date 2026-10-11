// Council mode: several models propose, others judge blind, one synthesizes. This file is pure:
// catalogs, selection, estimates, prompts, validation, blind packets and aggregation. The app
// loads it through Node's type stripping, so runtime imports name their .ts file.

export type Provider = 'claude' | 'openrouter' | 'gemini' | 'ollama'
export type Access = 'claude-plan' | 'free-hosted' | 'paid-hosted' | 'gemini-key' | 'local'
export type Candidate = {
  id: string
  provider: Provider
  name: string
  family: string
  access: Access
  openWeights: boolean
  context?: number
  maxOutput?: number
  // USD per million tokens; absent when the provider doesn't say.
  price?: { in: number; out: number }
  // OpenRouter's Artificial Analysis indexes; absent when there are none.
  coding?: number
  intelligence?: number
  created?: number
}
export type Mode = 'light' | 'full'
export type Role = 'proposer' | 'judge' | 'synth'
export type Seat = { candidate: Candidate; reason: string; perspective?: string }
export type Panel = { proposers: Seat[]; judges: Seat[]; synth: Seat; empty: string[] }

export const MODES = {
  light: { proposers: 4, claude: ['sonnet'], judges: 2, judgeClaude: ['opus'], synth: 'sonnet', words: 900, proposalTokens: 2500, judgeTokens: 3000, synthTokens: 6000, retries: 1, timeoutMs: 120_000 },
  full: { proposers: 8, claude: ['opus', 'sonnet', 'fable'], judges: 3, judgeClaude: [] as string[], synth: 'fable', words: 1800, proposalTokens: 5000, judgeTokens: 4000, synthTokens: 8000, retries: 2, timeoutMs: 300_000 },
} as const

export const PERSPECTIVES = [
  'simplest viable implementation',
  'strongest architecture',
  'performance and scalability',
  'reliability and failure recovery',
  'developer experience and maintainability',
  'security and correctness',
  'an unconventional alternative',
  'the best overall balance of quality, practicality and long-term value',
]

const MIN_CONTEXT = 32_000

// Claude models run as one-shot `claude -p` calls on the person's plan. Prices aren't known
// up front; Claude Code reports each call's cost afterwards.
export const CLAUDE_CANDIDATES: Candidate[] = ['opus', 'sonnet', 'fable', 'haiku'].map((id) => ({
  id,
  provider: 'claude',
  name: `Claude ${id[0]!.toUpperCase()}${id.slice(1)}`,
  family: 'claude',
  access: 'claude-plan',
  openWeights: false,
  context: 200_000,
}))

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const perMillion = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined
}

// GET https://openrouter.ai/api/v1/models. Text-in, text-out single models only: routers and
// Claude (which runs on the person's plan instead) are left out.
export function normalizeOpenRouter(json: unknown): Candidate[] {
  return list(obj(json).data).flatMap((raw): Candidate[] => {
    const m = obj(raw)
    const id = typeof m.id === 'string' ? m.id : ''
    const family = id.split('/')[0] ?? ''
    const arch = obj(m.architecture)
    const textIn = list(arch.input_modalities).includes('text')
    const textOut = list(arch.output_modalities).includes('text')
    if (!id.includes('/') || !textIn || !textOut || family === 'openrouter' || family === 'anthropic') return []
    const pricing = obj(m.pricing)
    const priceIn = perMillion(pricing.prompt)
    const priceOut = perMillion(pricing.completion)
    const price = priceIn !== undefined && priceOut !== undefined ? { in: priceIn, out: priceOut } : undefined
    const aa = obj(obj(m.benchmarks).artificial_analysis)
    const top = obj(m.top_provider)
    const c: Candidate = {
      id,
      provider: 'openrouter',
      name: typeof m.name === 'string' ? m.name : id,
      family,
      access: price && price.in === 0 && price.out === 0 ? 'free-hosted' : 'paid-hosted',
      openWeights: typeof m.hugging_face_id === 'string' && m.hugging_face_id.length > 0,
    }
    const extra = {
      context: num(m.context_length) ?? num(top.context_length),
      maxOutput: num(top.max_completion_tokens),
      price,
      coding: num(aa.coding_index),
      intelligence: num(aa.intelligence_index),
      created: num(m.created),
    }
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) Object.assign(c, { [k]: v })
    return [c]
  })
}

const NOT_CHAT = /embedding|aqa|image|tts|native-audio|live|robotics/i

// GET https://generativelanguage.googleapis.com/v1beta/models with the person's Gemini key.
export function normalizeGemini(json: unknown): Candidate[] {
  return list(obj(json).models).flatMap((raw): Candidate[] => {
    const m = obj(raw)
    const id = String(m.name ?? '').replace(/^models\//, '')
    if (!id || NOT_CHAT.test(id) || !list(m.supportedGenerationMethods).includes('generateContent')) return []
    const gemma = id.startsWith('gemma')
    const c: Candidate = { id, provider: 'gemini', name: typeof m.displayName === 'string' ? m.displayName : id, family: gemma ? 'gemma' : 'gemini', access: 'gemini-key', openWeights: gemma }
    const context = num(m.inputTokenLimit)
    const maxOutput = num(m.outputTokenLimit)
    if (context !== undefined) c.context = context
    if (maxOutput !== undefined) c.maxOutput = maxOutput
    return [c]
  })
}

// GET http://127.0.0.1:11434/api/tags: local models, open weights, context not reported.
export function normalizeOllama(json: unknown): Candidate[] {
  return list(obj(json).models).flatMap((raw): Candidate[] => {
    const m = obj(raw)
    const id = typeof m.name === 'string' ? m.name : ''
    if (!id) return []
    const family = typeof obj(m.details).family === 'string' ? String(obj(m.details).family) : id.split(':')[0]!
    return [{ id, provider: 'ollama', name: id, family, access: 'local', openWeights: true }]
  })
}

const ACCESS: Record<Access, string> = {
  'claude-plan': 'your Claude plan',
  'free-hosted': 'free hosted',
  'paid-hosted': 'paid hosted',
  'gemini-key': 'your Gemini key',
  local: 'local',
}
export const accessLabel = (c: Candidate) => `${ACCESS[c.access]}${c.openWeights ? ', open weights' : ''}`

const scoredBy = (first: 'coding' | 'intelligence') => (a: Candidate, b: Candidate) => {
  const second = first === 'coding' ? 'intelligence' : 'coding'
  const has = (c: Candidate) => c.coding !== undefined || c.intelligence !== undefined
  if (has(a) !== has(b)) return has(a) ? -1 : 1
  return (b[first] ?? -1) - (a[first] ?? -1) || (b[second] ?? -1) - (a[second] ?? -1) || (b.context ?? 0) - (a.context ?? 0) || (b.created ?? 0) - (a.created ?? 0)
}

function reasonFor(c: Candidate, first: 'coding' | 'intelligence') {
  const scores =
    c.coding === undefined && c.intelligence === undefined
      ? 'no benchmark data; picked by context size'
      : first === 'coding'
        ? `coding index ${c.coding ?? 'n/a'}, intelligence index ${c.intelligence ?? 'n/a'}`
        : `intelligence index ${c.intelligence ?? 'n/a'}, coding index ${c.coding ?? 'n/a'}`
  const context = c.context ? `, ${Math.round(c.context / 1000)}k context` : ', context not reported'
  return `${scores}; ${accessLabel(c)}${context}`
}

// The seats for a run. Proposers: the mode's Claude models, then discovered open-weight, free
// or Gemini-key models by coding index, one per family. Judges: never a proposer, each from a
// family no proposer used and no other judge used, by intelligence index, with room for every
// proposal; providers spread where the pool allows.
export function pickCouncil(candidates: readonly Candidate[], mode: Mode, { briefChars }: { briefChars: number }): Panel {
  const m = MODES[mode]
  const byId = (id: string) => candidates.find((c) => c.provider === 'claude' && c.id === id)
  const proposers: Seat[] = m.claude.flatMap((id) => {
    const c = byId(id)
    return c ? [{ candidate: c, reason: `designated Claude proposer; ${accessLabel(c)}` }] : []
  })
  const families = new Set(proposers.map((s) => s.candidate.family))
  const eligible = candidates
    .filter((c) => c.provider !== 'claude' && (c.openWeights || c.access === 'free-hosted' || c.access === 'gemini-key'))
    .filter((c) => c.context === undefined || c.context >= MIN_CONTEXT)
    .sort(scoredBy('coding'))
  for (const c of eligible) {
    if (proposers.length >= m.proposers) break
    if (families.has(c.family)) continue
    families.add(c.family)
    proposers.push({ candidate: c, reason: reasonFor(c, 'coding') })
  }
  proposers.forEach((s, i) => (s.perspective = PERSPECTIVES[i]))

  const needed = Math.ceil((briefChars + m.proposers * m.words * 6) / 4) + m.judgeTokens
  const taken = new Set(proposers.map((s) => s.candidate))
  const pool = candidates
    .filter((c) => !taken.has(c) && (c.provider !== 'claude' || (m.judgeClaude as readonly string[]).includes(c.id)))
    .filter((c) => c.provider === 'claude' || !families.has(c.family))
    .filter((c) => c.context !== undefined && c.context >= needed)
    .sort(scoredBy('intelligence'))
  const judges: Seat[] = []
  const judgeFamilies = new Set<string>()
  const providers = new Set<Provider>()
  while (judges.length < m.judges) {
    const open = pool.filter((c) => !judgeFamilies.has(c.family) && !judges.some((j) => j.candidate === c))
    const pick = open.find((c) => !providers.has(c.provider)) ?? open[0]
    if (!pick) break
    judgeFamilies.add(pick.family)
    providers.add(pick.provider)
    judges.push({ candidate: pick, reason: pick.provider === 'claude' ? `Claude judge (Light allows it); ${accessLabel(pick)}` : reasonFor(pick, 'intelligence') })
  }
  judges.sort((a, b) => scoredBy('intelligence')(a.candidate, b.candidate))

  const synth = byId(m.synth) ?? CLAUDE_CANDIDATES.find((c) => c.id === m.synth)!
  const empty = [
    ...(proposers.length < m.proposers ? [`${m.proposers - proposers.length} of ${m.proposers} proposer seats`] : []),
    ...(judges.length < m.judges ? [`${m.judges - judges.length} of ${m.judges} judge seats`] : []),
  ]
  return { proposers, judges, synth: { candidate: synth, reason: `synthesizes; ${accessLabel(synth)}` }, empty }
}

// Before a run: input at four characters a token, output at the role's cap.
export function estimate(c: Candidate, inputChars: number, role: Role, mode: Mode): { usd?: number; label: string } {
  if (c.access === 'claude-plan') return { label: 'on your Claude plan; reported after the run' }
  if (c.access === 'gemini-key') return { label: 'on your Gemini key; cost not reported' }
  if (c.access === 'local') return { usd: 0, label: 'local' }
  if (c.access === 'free-hosted') return { usd: 0, label: '$0 (free hosted)' }
  if (!c.price) return { label: 'price not listed' }
  const m = MODES[mode]
  const out = role === 'proposer' ? m.proposalTokens : role === 'judge' ? m.judgeTokens : m.synthTokens
  const usd = Math.round(((Math.ceil(inputChars / 4) * c.price.in + out * c.price.out) / 1e6) * 100) / 100
  return { usd, label: `~$${usd.toFixed(2)}` }
}
