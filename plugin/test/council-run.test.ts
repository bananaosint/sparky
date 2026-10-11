import { test, expect } from 'claude-code/testing'
import { CLAUDE_CANDIDATES, RUBRIC, SECTIONS, pickCouncil } from '../hooks/council'
import type { Candidate, Seat } from '../hooks/council'
import { callError } from '../hooks/council-providers'
import type { CallRequest } from '../hooks/council-providers'
import { runCouncil } from '../hooks/council-run'

// The mod's type contract has no timers; the test runner does.
declare const setTimeout: (fn: (...args: never[]) => void, ms: number) => unknown
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const brief = { objective: 'speed up the cache', context: [], constraints: [], criteria: [], verification: [] }
const scored = (id: string, coding: number, intelligence: number): Candidate => ({
  id,
  provider: 'openrouter',
  name: id,
  family: id.split('/')[0]!,
  access: 'free-hosted',
  openWeights: true,
  context: 200_000,
  price: { in: 0, out: 0 },
  coding,
  intelligence,
})
const pool = [...CLAUDE_CANDIDATES, ...['deepseek', 'qwen', 'z-ai', 'moonshotai', 'meta-llama', 'mistralai', 'google', 'openai', 'x-ai'].map((f, i) => scored(`${f}/m`, 90 - i, 80 - i))]
const proposal = (seat: Seat) => SECTIONS.map((s) => `## ${s}\n${seat.candidate.id} says use an LRU.`).join('\n')
const verdictFor = (letters: string[]) =>
  '```verdict\n' +
  JSON.stringify({
    scores: Object.fromEntries(letters.map((l, i) => [l, Object.fromEntries(RUBRIC.map((r) => [r.key, Math.max(0, 9 - i)]))])),
    rank: letters,
    preferred: letters[0],
    ideas: [],
    risks: [],
    hybrid: { base: letters[0], take: [], drop: [], conflicts: [], worthIt: false },
    confidence: 'high',
  }) +
  '\n```'
const lettersIn = (user: string) => [...user.matchAll(/<proposal letter="(\w)">/g)].map((m) => m[1]!)

type Seen = { role: string; seat: string; req: CallRequest }
// A council whose models answer well unless `script` says otherwise for a seat.
function rig(mode: 'light' | 'full', script: (seen: Seen, n: number) => unknown = () => undefined) {
  const panel = pickCouncil(pool, mode, { briefChars: 1000 })
  const seen: Seen[] = []
  const tries = new Map<string, number>()
  let live = 0
  let peak = 0
  const call = async (seat: Seat, role: string, req: CallRequest, signal: AbortSignal) => {
    const key = `${role}:${seat.candidate.id}`
    const n = (tries.get(key) ?? 0) + 1
    tries.set(key, n)
    const s = { role, seat: seat.candidate.id, req }
    seen.push(s)
    live++
    peak = Math.max(peak, live)
    try {
      await new Promise((r) => setTimeout(r, 1))
      const own = script(s, n)
      if (own === 'hang') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      // A call that can't be stopped (a hosted request in the terminal) answers after its time.
      if (own === 'late') {
        await realSleep(60)
        return { text: proposal(seat), usd: 0.07 }
      }
      if (own instanceof Error) throw own
      if (typeof own === 'string') return { text: own }
      if (role === 'proposer') return { text: proposal(seat), usd: 0 }
      if (role === 'judge') return { text: verdictFor(lettersIn(req.user)), usd: 0.01 }
      return { text: '## Decision\ndominant: A\n```mission\n{"title":"t","criteria":[{"text":"x","how":"y"}]}\n```', usd: 0.05 }
    } finally {
      live--
    }
  }
  const told: { kind: string }[] = []
  return { panel, seen, peak: () => peak, call, told, notify: (m: { kind: string }) => told.push(m) }
}

const run = (r: ReturnType<typeof rig>, mode: 'light' | 'full', over: Record<string, unknown> = {}) =>
  runCouncil({ brief, panel: r.panel, mode, call: r.call, notify: r.notify, shuffle: (n: number) => [...Array(n).keys()].reverse(), sleep: async () => {}, deadline: realSleep, ...over })

test('proposals, then blind judging, then synthesis; judges never see a model name', async () => {
  const r = rig('full')
  const record = await run(r, 'full')
  expect(record.status).toBe('done')
  const order = r.seen.map((s) => s.role)
  expect(order.lastIndexOf('proposer')).toBeLessThan(order.indexOf('judge'))
  expect(order.at(-1)).toBe('synth')
  for (const j of r.seen.filter((s) => s.role === 'judge')) for (const p of r.panel.proposers) expect(j.req.user).not.toContain(p.candidate.id)
  expect(Object.keys(record.mapping)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  expect(record.aggregate?.judged).toBe(3)
  expect(record.synthesis).toContain('## Decision')
})

test('at most 4 calls run at once', async () => {
  const r = rig('full')
  await run(r, 'full')
  expect(r.peak()).toBeLessThanOrEqual(4)
})

test('a call past its time limit is timed out, not answered', async () => {
  const r = rig('light', (s) => (s.seat === 'deepseek/m' && s.role === 'proposer' ? 'hang' : undefined))
  const record = await run(r, 'light', { timeoutMs: 20 })
  expect(record.seats['proposer:deepseek/m']).toMatchObject({ state: 'timed out' })
  expect(record.proposals.map((p) => p.seatId)).not.toContain('deepseek/m')
})

test('a call that answers after its time limit or a cancel still has its cost recorded', async () => {
  const r = rig('light', (s) => (s.seat === 'deepseek/m' && s.role === 'proposer' ? 'late' : undefined))
  const record = await run(r, 'light', { timeoutMs: 20 })
  expect(record.seats['proposer:deepseek/m']).toMatchObject({ state: 'timed out' })
  await realSleep(100)
  expect(record.seats['proposer:deepseek/m']).toMatchObject({ state: 'timed out', usd: 0.07 })
  expect(record.seats['proposer:deepseek/m']!.error).toBe('no answer within 0 s; it answered later, and its cost is counted')
  const last = r.told.at(-1) as unknown as { record: typeof record }
  expect(last.record.seats['proposer:deepseek/m']!.usd).toBe(0.07)
})

test('a 429 is retried once and then answers', async () => {
  const r = rig('light', (s, n) => (s.seat === 'qwen/m' && s.role === 'proposer' && n === 1 ? callError(429, 'rate limited') : undefined))
  const record = await run(r, 'light')
  expect(record.seats['proposer:qwen/m']).toMatchObject({ state: 'done', tries: 2 })
})

test('a proposal missing sections is asked again, naming them, then fails', async () => {
  const r = rig('light', (s) => (s.seat === 'z-ai/m' && s.role === 'proposer' ? '## A. Recommendation\nan LRU' : undefined))
  const record = await run(r, 'light')
  expect(record.seats['proposer:z-ai/m']).toMatchObject({ state: 'failed', tries: 2 })
  expect(record.seats['proposer:z-ai/m']!.error).toContain('missing sections C, D, F, G, H')
  expect(r.seen.filter((s) => s.seat === 'z-ai/m')[1]!.req.user).toContain('missing these sections: C, D, F, G, H')
})

test('a judge that fails twice leaves 2 of 3 judged', async () => {
  const r = rig('full', (s) => (s.role === 'judge' && s.seat === r.panel.judges[0]!.candidate.id ? 'not a verdict' : undefined))
  const record = await run(r, 'full')
  expect(record.status).toBe('done')
  expect(record.aggregate?.judged).toBe(2)
  expect(record.seats[`judge:${r.panel.judges[0]!.candidate.id}`]).toMatchObject({ state: 'failed' })
})

test('fewer than 2 proposals: the run fails and keeps what it has', async () => {
  const r = rig('light', (s) => (s.role === 'proposer' && s.seat !== 'sonnet' ? callError(404, 'no endpoint') : undefined))
  const record = await run(r, 'light')
  expect(record.status).toBe('failed')
  expect(record.reason).toBe('only 1 proposal came back; a council needs 2')
  expect(record.proposals.map((p) => p.seatId)).toEqual(['sonnet'])
  expect(record.seats['proposer:qwen/m']).toMatchObject({ state: 'unavailable' })
})

test('cancelling during judging keeps the proposals and marks the run cancelled', async () => {
  const stop = new AbortController()
  const r = rig('full', (s) => {
    if (s.role !== 'judge') return undefined
    setTimeout(() => stop.abort(), 1)
    return 'hang'
  })
  const record = await run(r, 'full', { signal: stop.signal })
  expect(record.status).toBe('cancelled')
  expect(record.proposals).toHaveLength(8)
  expect(record.synthesis).toBeUndefined()
  expect(r.seen.some((s) => s.role === 'synth')).toBe(false)
})

test('the synthesis gets the aggregate and the disagreements; every change is reported', async () => {
  const r = rig('light')
  await run(r, 'light')
  const synth = r.seen.find((s) => s.role === 'synth')!
  expect(synth.req.user).toContain('"case":')
  expect(synth.req.user).toContain('"disagreements":')
  expect(r.told.filter((t) => t.kind === 'record').length).toBeGreaterThan(5)
})
