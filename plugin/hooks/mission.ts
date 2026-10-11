// Missions: an objective, criteria the person approved, and a record of what really happened.
// Pure, and shared by the app (app/lib/mission-runner.js) and the terminal's /mission. The app
// loads this file through Node's type stripping, so runtime imports name their .ts file.
import { redact } from './redact.ts'
import { endsInQuestion } from './testgate.ts'
import { isCommandHow } from './verify.ts'
import type { CheckResult } from './verify.ts'
import { removeTask, taskText, validatePlan } from './plan.ts'
import type { Task, TaskRecord } from './plan.ts'

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
  // A Council synthesis the mission started from; the run text carries it.
  plan?: string
  // A substantial mission's short spec and its task plan (plan.ts), drafted and approved with
  // the criteria. Spark drives the tasks one turn at a time.
  spec?: string
  tasks?: Task[]
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
  // A verification pass: the check records after it are its results. `again`: Check again, on
  // the working tree as it was then rather than as the mission ended.
  | { at: number; kind: 'verify'; again: boolean }
  | ({ at: number; kind: 'check' } & CheckResult)
  | TaskRecord
export type Drafted = { title: string; criteria: Criterion[]; spec?: string; tasks?: Task[]; planError?: string }
// `task`: the turn ended one of the mission's tasks; the status stays until Spark checks it.
export type TurnEnd = { to: Status; reason: string; drafted?: Drafted; task?: boolean }

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

const PLAN_CHARS = 20_000

// A mission drafts its own criteria, unless it comes from a Council plan that already has them:
// then it starts in review.
export function newMission(
  objective: string,
  at: number,
  hex4: string,
  gateOffset: number,
  { criteria = [], plan }: { criteria?: Criterion[]; plan?: string } = {},
): { mission: Mission; record: MissionRecord } {
  const text = objective.trim()
  const planned = criteria.length > 0
  const status: Status = planned ? 'review' : 'draft'
  const reason = planned ? 'criteria from Council' : 'drafting criteria'
  return {
    mission: {
      id: missionId(at, hex4),
      title: clean(text, 80),
      objective: clean(text, 4000),
      criteria: criteria.map((c) => ({ text: clean(c.text, 500), how: clean(c.how, 300) || 'manual', by: c.by })),
      status,
      reason,
      createdAt: at,
      gateOffset,
      ...(plan ? { plan: clean(plan, PLAN_CHARS) } : {}),
    },
    record: { at, kind: 'status', to: status, reason: planned ? reason : 'mission created' },
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

// Claude Code's stderr and control errors can echo a key back: redacted like everything else.
export const processRecord = (event: 'started' | 'resumed' | 'exited' | 'plan-mode-refused', at: number, { code, error }: { code?: number; error?: unknown } = {}): MissionRecord => {
  const text = error === undefined ? '' : clean(String(error).slice(-500), 500)
  return { at, kind: 'process', event, ...(typeof code === 'number' ? { code } : {}), ...(text ? { error: text } : {}) }
}

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

const SPEC_CHARS = 1500

// The criteria Claude drafted, from the last ```mission block in its answer, with the optional
// spec and task plan. A plan that doesn't hold together is dropped and `planError` says why.
export function parseMissionBlock(text: string): Drafted | undefined {
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
  const plan = validatePlan(j.tasks)
  return {
    title: typeof j.title === 'string' ? clean(j.title.trim(), 80) : '',
    criteria,
    ...(typeof j.spec === 'string' && j.spec.trim() ? { spec: clean(j.spec.trim(), SPEC_CHARS) } : {}),
    ...('error' in plan ? { planError: plan.error } : plan.tasks.length ? { tasks: plan.tasks } : {}),
  }
}

// What the window sends back on Approve: the tasks kept, each with its instructions and check as
// edited. A task left out is removed and its dependents rewired; the result is checked again.
// Fewer than 2 tasks is no plan, as the card says; an edit that doesn't hold together is an error.
export function approvedPlan(drafted: readonly Task[], sent: unknown): Task[] | { error: string } {
  if (!Array.isArray(sent)) return []
  const edits = new Map(sent.map((s: unknown) => [String((s as Record<string, unknown>)?.id ?? ''), (s ?? {}) as Record<string, unknown>]))
  const stranger = [...edits.keys()].find((id) => !drafted.some((t) => t.id === id))
  if (stranger !== undefined) return { error: `the plan sent back names a task that was not drafted: ${clean(stranger, 40)}` }
  let tasks = [...drafted]
  for (const t of drafted) if (!edits.has(t.id)) tasks = removeTask(tasks, t.id)
  const edited = tasks.map((t) => {
    const e = edits.get(t.id)!
    const check = typeof e.check === 'string' ? e.check.trim() : t.check
    return { ...t, do: typeof e.do === 'string' ? e.do : t.do, ...(check ? { check } : { check: undefined }) }
  })
  const wrong = edited.find((t) => t.check && !isCommandHow(t.check))
  if (wrong) return { error: `task ${wrong.id}'s check isn't a command Spark can run (${clean(wrong.check, 80)}): give a command, or leave it empty` }
  if (edited.length < 2) return []
  const plan = validatePlan(edited)
  return 'tasks' in plan ? plan.tasks : plan
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

export const criteriaCount = (n: number) => `${n} ${n === 1 ? 'criterion' : 'criteria'}`

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
    '',
    'If the change is substantial (several files or steps), add two fields to the same block:',
    '"spec": "<under 1500 characters: requirements, constraints, risks, data or API changes>",',
    '"tasks": [{"id": "t1", "title": "<short>", "do": "<what to do>", "after": [], "check": "<a command that shows this task is done, or leave it out>"}]',
    'with 2 to 10 tasks; "after" lists only earlier task ids. Spark sends the tasks one at a time. Leave both out for a small change.',
  ].join('\n')

const planLines = (tasks: readonly Task[]) =>
  tasks.map((t) => `${t.id}. ${t.title}${t.after.length ? ` (after ${t.after.join(', ')})` : ''}${t.check ? ` (check: ${t.check})` : ''}`)

export const runText = (m: Mission) =>
  [
    `Mission: ${m.title}`,
    '',
    `Objective: ${m.objective}`,
    '',
    'Acceptance criteria (approved):',
    ...listed(m),
    ...(m.plan ? ['', 'Plan (from Council):', m.plan] : []),
    ...(m.spec ? ['', 'Spec:', m.spec] : []),
    ...(m.tasks?.length
      ? [
          '',
          'Tasks:',
          ...planLines(m.tasks),
          '',
          "Spark sends the tasks one at a time and runs each task's check. When you end a task's turn, say what you changed and what you ran. Spark records what actually happened and reports it next to your account.",
          '',
          taskText(m.tasks[0]!),
        ]
      : [
          '',
          'Do the work until every criterion is met, or until you are blocked and need me. When you finish, end with what you changed, the commands you ran and their results, and for each criterion whether you believe it is met and why. Spark records what actually happened and reports it next to your account.',
        ]),
  ].join('\n')

// `current`: the task the mission was on, sent again.
export const resumeText = (m: Mission, current?: Task) =>
  [
    `Resuming mission: ${m.title}`,
    '',
    `Objective: ${m.objective}`,
    '',
    'Acceptance criteria:',
    ...listed(m),
    ...(m.tasks?.length ? ['', 'Tasks:', ...planLines(m.tasks)] : []),
    '',
    "Check the current state of the project before doing more; don't redo finished work. End the same way: what changed, what you ran, and where each criterion stands.",
    ...(current ? ['', taskText(current)] : []),
  ].join('\n')

// What a draft or running mission becomes when a turn ends. `halted`: Spark halted since approval.
export function onTurnEnd(m: Mission, turn: { ok: boolean; text: string }, halted: boolean): TurnEnd {
  if (m.status === 'draft') {
    const drafted = turn.ok ? parseMissionBlock(turn.text) : undefined
    if (drafted) {
      const what = drafted.tasks ? `${criteriaCount(drafted.criteria.length)} and ${drafted.tasks.length} tasks` : criteriaCount(drafted.criteria.length)
      return { to: 'review', reason: `${what} drafted${drafted.planError ? `; the task plan was dropped: ${drafted.planError}` : ''}`, drafted }
    }
    return { to: 'review', reason: turn.ok ? 'no mission block came back; write the criteria' : 'the draft turn failed; write the criteria' }
  }
  if (!turn.ok) return { to: 'blocked', reason: `the turn failed: ${clean(turn.text || 'no message', 200)}` }
  if (halted) return { to: 'blocked', reason: 'halted after two failed test or build runs' }
  if (endsInQuestion(turn.text)) return { to: 'waiting', reason: 'Claude asked you a question' }
  if (m.tasks?.length) return { to: 'running', reason: 'the task turn ended', task: true }
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
  const base: Mission = { ...m, gateOffset }
  const d = end.drafted
  // A draft replaces the spec and plan of an earlier draft, or leaves the mission without them.
  if (d) {
    Object.assign(base, { title: d.title || m.title, criteria: d.criteria })
    delete base.spec
    delete base.tasks
    if (d.spec) base.spec = d.spec
    if (d.tasks) base.tasks = d.tasks
  }
  if (end.task) return { mission: base, records: [...gates] }
  const moved = move(base, end.to, end.reason, at)
  return { mission: moved.mission, records: [...gates, moved.record] }
}

// The last Resume's process died before Claude Code said which model it runs: the session is
// probably gone, so the next Resume starts a fresh one.
export function resumeFailed(records: readonly MissionRecord[]) {
  const [a, b] = records.filter((r) => r.kind === 'process' || r.kind === 'model').slice(-2)
  return a?.kind === 'process' && a.event === 'resumed' && b?.kind === 'process' && b.event === 'exited'
}

const KINDS: ReadonlySet<string> = new Set(['status', 'you', 'tool', 'tool-result', 'permission', 'turn', 'gate', 'model', 'process', 'verify', 'check', 'task'])
const TASK_EVENTS: ReadonlySet<string> = new Set(['started', 'retry', 'done', 'failed'])
// A check record's status feeds the verdict, so an unknown one is not let through.
const CHECK_STATUSES: ReadonlySet<string> = new Set(['pass', 'fail', 'timed-out', 'not-run'])

// Files under .spark/ can come with the repo: only well-formed ones are used, and values that
// would reach git or claude are dropped unless they have the expected form.
export function asRecord(j: unknown): MissionRecord | undefined {
  const r = (j ?? {}) as Record<string, unknown>
  if (r.kind === 'check' && !(typeof r.name === 'string' && CHECK_STATUSES.has(String(r.status)))) return undefined
  if (r.kind === 'task' && !(typeof r.id === 'string' && /^[A-Za-z][\w-]{0,19}$/.test(r.id) && TASK_EVENTS.has(String(r.event)) && typeof r.attempt === 'number')) return undefined
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
    plan: typeof m.plan === 'string' ? clip(m.plan, PLAN_CHARS) : undefined,
    spec: typeof m.spec === 'string' ? clip(m.spec, SPEC_CHARS) : undefined,
    tasks: (() => {
      const plan = validatePlan(m.tasks)
      return 'tasks' in plan && plan.tasks.length ? plan.tasks : undefined
    })(),
  }
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) Object.assign(mission, { [key]: value })
  return mission
}
