// The steps around a council run that the app and the terminal share: the pre-flight record,
// the checks before Run, the panel back from the record, and the hand-off to a mission. Pure.
import { MODES, briefText, estimate, pickCouncil } from './council.ts'
import type { Brief, Candidate, Mode, Panel, Role, Seat } from './council.ts'
import { parseMissionBlock } from './mission.ts'
import type { Criterion } from './mission.ts'

export const BRIEF_SYSTEM = 'You prepare a problem brief that other models will work from without access to this project. Be exact and short. Read files; never change them.'
// Providers whose servers see the brief; Claude runs on the person's plan, Ollama on this machine.
const NEEDS_CONSENT: ReadonlySet<string> = new Set(['openrouter', 'gemini'])

const pad = (n: number) => String(n).padStart(2, '0')
export function councilId(at: number, hex4: string) {
  const d = new Date(at)
  return `c-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex4}`
}
export const isCouncilId = (id: unknown): id is string => typeof id === 'string' && /^c-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)

// A seat as the window, the pane and the record keep it: the model's facts, why, its estimate.
export type SeatInfo = Candidate & { reason: string; perspective?: string; estimate: { usd?: number; label: string } }
export type Preflight = {
  id: string
  question: string
  mode: Mode
  createdAt: number
  brief: Brief
  briefCost?: number
  panel: { proposers: SeatInfo[]; judges: SeatInfo[]; synth: SeatInfo }
  empty: string[]
  notes: string[]
  freeLeft?: number
  estimate: { meteredUsd: number; freeCalls: number }
  consentNeeded: string[]
}

const info = (seat: Seat, role: Role, chars: number, mode: Mode): SeatInfo => ({
  ...seat.candidate,
  reason: seat.reason,
  ...(seat.perspective ? { perspective: seat.perspective } : {}),
  estimate: estimate(seat.candidate, chars, role, mode),
})

export function preflightRecord(a: {
  id: string
  question: string
  mode: Mode
  at: number
  brief: Brief
  briefCost?: number
  candidates: readonly Candidate[]
  notes: string[]
  freeLeft?: number
  consents: Record<string, unknown>
}): Preflight {
  const chars = briefText(a.brief).length
  const panel = pickCouncil(a.candidates, a.mode, { briefChars: chars })
  const m = MODES[a.mode]
  const judgeChars = chars + panel.proposers.length * m.words * 6
  const seats = {
    proposers: panel.proposers.map((s) => info(s, 'proposer', chars, a.mode)),
    judges: panel.judges.map((s) => info(s, 'judge', judgeChars, a.mode)),
    synth: info(panel.synth, 'synth', judgeChars + panel.judges.length * m.judgeTokens * 4, a.mode),
  }
  const all = [...seats.proposers, ...seats.judges, seats.synth]
  return {
    id: a.id,
    question: a.question,
    mode: a.mode,
    createdAt: a.at,
    brief: a.brief,
    ...(a.briefCost === undefined ? {} : { briefCost: a.briefCost }),
    panel: seats,
    empty: panel.empty,
    notes: a.notes,
    ...(a.freeLeft === undefined ? {} : { freeLeft: a.freeLeft }),
    estimate: {
      meteredUsd: Math.round(all.reduce((n, s) => n + (s.access === 'paid-hosted' ? (s.estimate.usd ?? 0) : 0), 0) * 100) / 100,
      freeCalls: all.filter((s) => s.access === 'free-hosted').length,
    },
    consentNeeded: [...new Set(all.map((s) => s.provider))].filter((p) => NEEDS_CONSENT.has(p) && !a.consents[p]),
  }
}

// Why Run can't start yet, or undefined when it can.
export function runRefusal(c: Preflight, { consent, reduced }: { consent: boolean; reduced: boolean }, budgetUsd: number) {
  if (c.consentNeeded.length && !consent) return `consent needed to send the brief to ${c.consentNeeded.join(' and ')}`
  if (c.empty.length && !reduced) return `the panel is short (${c.empty.join(', ')} empty): run with a reduced panel`
  if (c.panel.proposers.length < 2 || c.panel.judges.length < 2) return 'a council needs at least 2 proposers and 2 judges'
  if (c.estimate.meteredUsd > budgetUsd) return `the estimate ($${c.estimate.meteredUsd.toFixed(2)}) is over your cap ($${budgetUsd.toFixed(2)}); raise councilBudgetUsd or run Light`
  return undefined
}

const seatOf = (s: SeatInfo): Seat => ({ candidate: s, reason: s.reason, ...(s.perspective ? { perspective: s.perspective } : {}) })
export const panelOf = (c: Preflight): Panel => ({ proposers: c.panel.proposers.map(seatOf), judges: c.panel.judges.map(seatOf), synth: seatOf(c.panel.synth), empty: c.empty })

// The synthesis's acceptance criteria and the synthesis itself, for a mission that starts in review.
export function missionPlan(c: Preflight & { run?: { synthesis?: string } }): { objective: string; criteria: Criterion[]; plan: string } | { error: string } {
  const synthesis = c.run?.synthesis
  if (!synthesis) return { error: 'this council has no synthesis to start from' }
  const drafted = parseMissionBlock(synthesis)
  if (!drafted) return { error: 'the synthesis has no mission block with acceptance criteria' }
  return { objective: c.brief.objective, criteria: drafted.criteria, plan: synthesis }
}
