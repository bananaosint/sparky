// Missions: an objective, criteria the person approved, and a record of what really happened.
// Pure, and shared by the app (app/lib/mission-runner.js) and the terminal's /mission. The app
// loads this file through Node's type stripping, so runtime imports name their .ts file.
import { redact } from './redact.ts'
import { endsInQuestion } from './testgate.ts'

export type Status = 'draft' | 'review' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'finished' | 'blocked' | 'cancelled'
export type Criterion = { text: string; how: string; by: 'claude' | 'you' }
export type Mission = {
  id: string
  title: string
  objective: string
  criteria: Criterion[]
  status: Status
  reason: string
  createdAt: number
  approvedAt?: number
  endedAt?: number
  sessionId?: string
  model?: string
  // Snapshot commits pinned at refs/spark/missions/<id>/start and /end.
  startSha?: string
  endSha?: string
  // How much of .spark/gate.jsonl was there already or has been read: only later lines count.
  gateOffset: number
}
export type Decision = 'allowed' | 'always' | 'denied' | 'auto-allowed' | 'auto-denied'
export type GateCheck = 'tests' | 'build' | 'halt'
export type GateRecord = { at: number; kind: 'gate'; check: GateCheck; ok: boolean; exit?: number; tree?: string }
export type MissionRecord =
  | { at: number; kind: 'status'; from?: Status; to: Status; reason: string }
  | { at: number; kind: 'you'; text: string }
  | { at: number; kind: 'tool'; id: string; name: string; target: string }
  | { at: number; kind: 'tool-result'; id: string; ok: boolean; tail?: string }
  | { at: number; kind: 'permission'; tool: string; target: string; decision: Decision; gate?: string }
  | { at: number; kind: 'turn'; ok: boolean; text: string; durationMs?: number; costUsd?: number; tokens?: number }
  | GateRecord
  | { at: number; kind: 'model'; model: string }
  | { at: number; kind: 'process'; event: 'started' | 'resumed' | 'exited' | 'plan-mode-refused'; code?: number; error?: string }
export type TurnEnd = { to: Status; reason: string; drafted?: { title: string; criteria: Criterion[] } }

const STATUSES: readonly Status[] = ['draft', 'review', 'running', 'waiting', 'paused', 'interrupted', 'finished', 'blocked', 'cancelled']
export const FINAL: ReadonlySet<Status> = new Set<Status>(['finished', 'blocked', 'cancelled'])
// A turn or a session is behind these, so a restart cuts them off.
export const LIVE: ReadonlySet<Status> = new Set<Status>(['draft', 'running', 'waiting'])
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
// A draft only reads: these are refused while one runs, whatever "always allow" says.
export const DRAFT_DENIED: ReadonlySet<string> = new Set([...EDIT_TOOLS, ...SHELL_TOOLS, 'ExitPlanMode'])
export const DRAFT_DENIAL = '✦ spark: the mission is being drafted, which only reads. Reply with the mission block instead.'

const MOVES: Record<Status, readonly Status[]> = {
  draft: ['review', 'interrupted', 'cancelled'],
  review: ['running', 'cancelled'],
  running: ['waiting', 'paused', 'finished', 'blocked', 'cancelled', 'interrupted'],
  waiting: ['running', 'paused', 'cancelled', 'interrupted'],
  paused: ['running', 'cancelled'],
  interrupted: ['running', 'draft', 'cancelled'],
  finished: [],
  blocked: [],
  cancelled: [],
}

export function move(m: Mission, to: Status, reason: string, at: number): { mission: Mission; record: MissionRecord } {
  if (!MOVES[m.status].includes(to)) throw new Error(`a ${m.status} mission can't become ${to}`)
  return {
    mission: { ...m, status: to, reason, ...(FINAL.has(to) ? { endedAt: at } : {}) },
    record: { at, kind: 'status', from: m.status, to, reason },
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
export function missionId(at: number, hex4: string) {
  const d = new Date(at)
  return `m-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex4}`
}
export const isMissionId = (id: unknown): id is string => typeof id === 'string' && /^m-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)
export const isSessionId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
// Kept redacted for good: what reaches .spark/ never holds a secret back.
const clean = (s: unknown, n: number) => clip(redact(String(s ?? '')).text, n)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export function newMission(objective: string, at: number, hex4: string, gateOffset: number): { mission: Mission; record: MissionRecord } {
  const text = objective.trim()
  return {
    mission: { id: missionId(at, hex4), title: clean(text, 80), objective: clean(text, 4000), criteria: [], status: 'draft', reason: 'drafting criteria', createdAt: at, gateOffset },
    record: { at, kind: 'status', to: 'draft', reason: 'mission created' },
  }
}

// What a tool call is about: its file, command, pattern or address.
export function target(input: Record<string, unknown> | undefined) {
  const i = input ?? {}
  return clean(i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? '', 300)
}

type StreamEvent = {
  kind: string
  id?: unknown
  name?: unknown
  input?: Record<string, unknown>
  isError?: unknown
  output?: unknown
  ok?: unknown
  text?: unknown
  durationMs?: unknown
  costUsd?: unknown
  model?: unknown
  usage?: { input?: number; output?: number; cacheWrite?: number }
}

const lastLines = (s: string, n: number) => s.split(/\r?\n/).slice(-n).join('\n')

// One event from app/lib/stream.js becomes zero or more records. Tokens count as /goal counts
// them: input, output and cache writes.
export function recordsFor(e: StreamEvent, at: number): MissionRecord[] {
  if (e.kind === 'init' && typeof e.model === 'string') return [{ at, kind: 'model', model: e.model }]
  if (e.kind === 'tool') return [{ at, kind: 'tool', id: String(e.id), name: String(e.name), target: target(e.input) }]
  if (e.kind === 'tool-result')
    return [{ at, kind: 'tool-result', id: String(e.id), ok: !e.isError, ...(e.isError ? { tail: clean(lastLines(String(e.output ?? ''), 20), 4000) } : {}) }]
  if (e.kind === 'result') {
    const durationMs = num(e.durationMs)
    const costUsd = num(e.costUsd)
    const tokens = e.usage ? (e.usage.input ?? 0) + (e.usage.output ?? 0) + (e.usage.cacheWrite ?? 0) : undefined
    return [
      {
        at,
        kind: 'turn',
        ok: Boolean(e.ok),
        text: clean(e.text, 8000),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(tokens === undefined ? {} : { tokens }),
      },
    ]
  }
  return []
}

export const youRecord = (text: string, at: number): MissionRecord => ({ at, kind: 'you', text: clean(text, 500) })

export const permissionRecord = (tool: string, input: Record<string, unknown> | undefined, decision: Decision, at: number, gate?: string): MissionRecord => ({
  at,
  kind: 'permission',
  tool: String(tool),
  target: target(input),
  decision,
  ...(gate ? { gate: clean(gate, 300) } : {}),
})

const SHA = /^[0-9a-f]{40,64}$/
const CHECKS: ReadonlySet<string> = new Set(['tests', 'build', 'halt'])

// .spark/gate.jsonl, which the plugin writes: anything that isn't a well-formed line is dropped.
export function parseGateLines(text: string): MissionRecord[] {
  return text.split('\n').flatMap((line): MissionRecord[] => {
    let j: Record<string, unknown> | null
    try {
      j = JSON.parse(line)
    } catch {
      return []
    }
    if (typeof j?.at !== 'number' || !CHECKS.has(String(j.check)) || typeof j.ok !== 'boolean') return []
    return [
      {
        at: j.at,
        kind: 'gate',
        check: j.check as GateCheck,
        ok: j.ok,
        ...(Number.isInteger(j.exit) ? { exit: j.exit as number } : {}),
        ...(typeof j.tree === 'string' && SHA.test(j.tree) ? { tree: j.tree } : {}),
      },
    ]
  })
}

// The criteria Claude drafted, from the last ```mission block in its answer.
export function parseMissionBlock(text: string): { title: string; criteria: Criterion[] } | undefined {
  const block = [...text.matchAll(/```mission[^\n]*\n([\s\S]*?)```/g)].at(-1)?.[1]
  if (!block) return undefined
  let j: Record<string, unknown> | null
  try {
    j = JSON.parse(block)
  } catch {
    return undefined
  }
  if (!Array.isArray(j?.criteria)) return undefined
  const criteria = j.criteria.flatMap((c: unknown): Criterion[] => {
    const x = (c ?? {}) as Record<string, unknown>
    if (typeof x.text !== 'string' || !x.text.trim()) return []
    return [{ text: clean(x.text.trim(), 500), how: typeof x.how === 'string' && x.how.trim() ? clean(x.how.trim(), 300) : 'manual', by: 'claude' }]
  })
  if (!criteria.length) return undefined
  return { title: typeof j.title === 'string' ? clean(j.title.trim(), 80) : '', criteria }
}

// What the window sends back on Approve: rows kept as drafted stay Claude's, the rest are yours.
export function approvedCriteria(drafted: readonly Criterion[], sent: unknown): Criterion[] {
  if (!Array.isArray(sent)) return []
  return sent.flatMap((c: unknown): Criterion[] => {
    const x = (c ?? {}) as Record<string, unknown>
    if (typeof x.text !== 'string' || !x.text.trim()) return []
    const text = clean(x.text.trim(), 500)
    const how = typeof x.how === 'string' && x.how.trim() ? clean(x.how.trim(), 300) : 'manual'
    return [{ text, how, by: drafted.some((d) => d.text === text && d.how === how) ? 'claude' : 'you' }]
  })
}

const listed = (m: Mission) => m.criteria.map((c, i) => `${i + 1}. ${c.text} (check: ${c.how})`)

export const draftText = (objective: string) =>
  [
    `Mission: ${objective}`,
    '',
    "This is the drafting step. Read whatever you need in the project, but don't change anything and don't run commands.",
    'Reply with a short interpretation of the objective (what has to be true when it is done), then the acceptance criteria in one fenced block exactly like this:',
    '',
    '```mission',
    '{"title": "<short name, under 60 characters>", "criteria": [{"text": "<one checkable outcome>", "how": "<the test or command that shows it, or manual>"}]}',
    '```',
    '',
    'Each criterion is one outcome a test, a command or a person can check. Use "manual" only when a person has to judge it. Don\'t call ExitPlanMode: the block is the plan, and Spark shows it for approval.',
  ].join('\n')

export const runText = (m: Mission) =>
  [
    `Mission: ${m.title}`,
    '',
    `Objective: ${m.objective}`,
    '',
    'Acceptance criteria (approved):',
    ...listed(m),
    '',
    'Do the work until every criterion is met, or until you are blocked and need me. When you finish, end with what you changed, the commands you ran and their results, and for each criterion whether you believe it is met and why. Spark records what actually happened and reports it next to your account.',
  ].join('\n')

export const resumeText = (m: Mission) =>
  [
    `Resuming mission: ${m.title}`,
    '',
    `Objective: ${m.objective}`,
    '',
    'Acceptance criteria:',
    ...listed(m),
    '',
    "Check the current state of the project before doing more; don't redo finished work. End the same way: what changed, what you ran, and where each criterion stands.",
  ].join('\n')

// What a draft or running mission becomes when a turn ends. `halted`: Spark halted since approval.
export function onTurnEnd(m: Mission, turn: { ok: boolean; text: string }, halted: boolean): TurnEnd {
  if (m.status === 'draft') {
    const drafted = turn.ok ? parseMissionBlock(turn.text) : undefined
    if (drafted) return { to: 'review', reason: `${drafted.criteria.length} criteria drafted`, drafted }
    return { to: 'review', reason: turn.ok ? 'no mission block came back; write the criteria' : 'the draft turn failed; write the criteria' }
  }
  if (!turn.ok) return { to: 'blocked', reason: `the turn failed: ${clip(turn.text || 'no message', 200)}` }
  if (halted) return { to: 'blocked', reason: 'halted after two failed test or build runs' }
  if (endsInQuestion(turn.text)) return { to: 'waiting', reason: 'Claude asked you a question' }
  return { to: 'finished', reason: 'Claude finished the work' }
}

// A turn of a draft or running mission ended: the new gate lines, then the status move, and the
// mission with its drafted criteria and the new gate offset.
export function turnEnded(
  m: Mission,
  earlier: readonly MissionRecord[],
  turn: { ok: boolean; text: string },
  gates: readonly MissionRecord[],
  gateOffset: number,
  at: number,
): { mission: Mission; records: MissionRecord[] } {
  const since = m.approvedAt
  const halted = since !== undefined && [...earlier, ...gates].some((r) => r.kind === 'gate' && r.check === 'halt' && r.at >= since)
  const end = onTurnEnd(m, turn, halted)
  const base: Mission = { ...m, gateOffset, ...(end.drafted ? { title: end.drafted.title || m.title, criteria: end.drafted.criteria } : {}) }
  const moved = move(base, end.to, end.reason, at)
  return { mission: moved.mission, records: [...gates, moved.record] }
}

// The last Resume's process died before Claude Code said which model it runs: the session is
// probably gone, so the next Resume starts a fresh one.
export function resumeFailed(records: readonly MissionRecord[]) {
  const [a, b] = records.filter((r) => r.kind === 'process' || r.kind === 'model').slice(-2)
  return a?.kind === 'process' && a.event === 'resumed' && b?.kind === 'process' && b.event === 'exited'
}

const KINDS: ReadonlySet<string> = new Set(['status', 'you', 'tool', 'tool-result', 'permission', 'turn', 'gate', 'model', 'process'])

// Files under .spark/ can come with the repo: only well-formed ones are used, and values that
// would reach git or claude are dropped unless they have the expected form.
export function asRecord(j: unknown): MissionRecord | undefined {
  const r = (j ?? {}) as Record<string, unknown>
  return typeof r.at === 'number' && KINDS.has(String(r.kind)) ? (r as MissionRecord) : undefined
}

export function asMission(j: unknown): Mission | undefined {
  const m = (j ?? {}) as Record<string, unknown>
  if (!isMissionId(m.id) || typeof m.title !== 'string' || typeof m.objective !== 'string') return undefined
  if (!STATUSES.includes(m.status as Status) || typeof m.createdAt !== 'number' || !Array.isArray(m.criteria)) return undefined
  const criteria = m.criteria.flatMap((c: unknown): Criterion[] => {
    const x = (c ?? {}) as Record<string, unknown>
    return typeof x.text === 'string' && typeof x.how === 'string' ? [{ text: x.text, how: x.how, by: x.by === 'you' ? 'you' : 'claude' }] : []
  })
  const sha = (v: unknown) => (typeof v === 'string' && SHA.test(v) ? v : undefined)
  const mission: Mission = {
    id: m.id,
    title: m.title,
    objective: m.objective,
    criteria,
    status: m.status as Status,
    reason: str(m.reason) ?? '',
    createdAt: m.createdAt,
    gateOffset: num(m.gateOffset) ?? 0,
  }
  const optional = {
    approvedAt: num(m.approvedAt),
    endedAt: num(m.endedAt),
    sessionId: isSessionId(m.sessionId) ? m.sessionId : undefined,
    model: str(m.model),
    startSha: sha(m.startSha),
    endSha: sha(m.endSha),
  }
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) Object.assign(mission, { [key]: value })
  return mission
}
