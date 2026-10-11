// What a mission ends with, and its timeline: both built from records alone. Claude's own
// account of the work is kept apart and labeled as unverified.
import { numstat, pinSnapshot, treeOf } from './snapshot.ts'
import type { Run } from './snapshot.ts'
import { EDIT_TOOLS, FINAL, SHELL_TOOLS } from './mission.ts'
import { taskStates } from './plan.ts'
import type { Task, TaskState, TaskView } from './plan.ts'
import type { Decision, GateRecord, Mission, MissionRecord } from './mission.ts'
import { isCommandHow, verdict } from './verify.ts'
import type { CheckResult, CheckStatus, Verdict } from './verify.ts'

export type FileStat = { path: string; added: number; removed: number }
export type Facts = { inRepo: boolean; now: number; files?: FileStat[]; endTree?: string }
export type TestState = 'passed' | 'failing' | 'not-run' | 'passed-unknown'
export type Report = {
  status: string
  tests: { state: TestState; line: string }
  criteria: { text: string; how: string; by: 'claude' | 'you'; check: string }[]
  files: { path: string; added?: number; removed?: number }[]
  filesNote?: string
  commands: { command: string; ok?: boolean }[]
  checks: { at: number; ok: boolean; line: string }[]
  approvals: { cards: number; allowed: number; denied: string[]; bySpark: number }
  time: { wallMs?: number; workedMs: number }
  cost: { usd?: number; tokens?: number }
  claude: string
  // A planned mission's tasks, as Spark's task records left them.
  tasks?: { id: string; title: string; after: string[]; state: TaskState; attempts: number; files?: FileStat[]; line: string }[]
  // Spark's own checks, from the last verification pass.
  proof?: { verdict: Verdict; at: number; again: boolean; logDir: string; checks: { name: string; status: CheckStatus; line: string; log?: string }[] }
}
export type Row = { at: number; glyph: string; tone: 'ok' | 'fail' | 'info' | 'warn'; text: string; detail?: string }
export type Section = { heading: string; lines: { text: string; tone?: Row['tone'] }[]; markdown?: boolean }

type Of<K extends MissionRecord['kind']> = Extract<MissionRecord, { kind: K }>
const is =
  <K extends MissionRecord['kind']>(kind: K) =>
  (r: MissionRecord): r is Of<K> =>
    r.kind === kind

const TEST_LINES: Record<TestState, string> = {
  passed: 'tests passed on this code',
  failing: 'tests failing',
  'not-run': 'tests not run on the final code',
  'passed-unknown': "tests passed; Spark can't tell whether files changed after (not a git repo)",
}

// Passed only when the last test-gate run passed on exactly the tree the mission ended with.
export function testState(records: readonly MissionRecord[], facts: Pick<Facts, 'inRepo' | 'endTree'>): TestState {
  const last = records.filter(is('gate')).filter((r) => r.check === 'tests').at(-1)
  if (!last) return 'not-run'
  if (!last.ok) return 'failing'
  if (!facts.inRepo) return 'passed-unknown'
  return last.tree !== undefined && last.tree === facts.endTree ? 'passed' : 'not-run'
}

// Sums over turns. A total that no turn reported stays undefined rather than reading as zero.
export function totals(records: readonly MissionRecord[]) {
  const turns = records.filter(is('turn'))
  const sum = (pick: (t: Of<'turn'>) => unknown) =>
    turns.some((t) => typeof pick(t) === 'number') ? turns.reduce((n, t) => n + (Number(pick(t)) || 0), 0) : undefined
  return { usd: sum((t) => t.costUsd), tokens: sum((t) => t.tokens), workedMs: sum((t) => t.durationMs) ?? 0 }
}

const gateLine = (r: GateRecord) =>
  r.check === 'halt' ? 'halted: two failed test or build runs in a row' : `${r.check} ${r.ok ? 'passed' : `failed${r.exit === undefined ? '' : ` (exit ${r.exit})`}`}`

const VERDICT_WORD: Record<Verdict, string> = { verified: 'Verified', 'needs review': 'Needs review', 'checks failed': 'Checks failed', 'not verified': 'Not verified' }

const outcome = (c: Partial<CheckResult>) => {
  if (c.status === 'pass') return 'passed'
  if (c.status === 'fail') return c.exit === undefined ? `failed: ${String(c.reason ?? '')}` : `failed (exit ${String(c.exit)})`
  if (c.status === 'timed-out') return 'timed out'
  return `not run: ${String(c.reason ?? '')}`
}
const proofLine = (c: CheckResult) => (c.command ? `${c.command} · ${outcome(c)} · ${clock(Number(c.ms) || 0)}` : outcome(c))

const taskLine = (t: Task, v: TaskView) =>
  [
    `${t.id} ${t.title}`,
    v.state,
    ...(v.attempts > 1 ? [`${v.attempts} attempts`] : []),
    ...(v.check ? [`check ${outcome(v.check)}`] : []),
    ...(v.note ? [v.note] : []),
    ...(v.files ? [`${v.files.length} file${v.files.length === 1 ? '' : 's'} changed`] : []),
  ].join(' · ')

function lastPass(records: readonly MissionRecord[]) {
  const i = records.map((r) => r.kind).lastIndexOf('verify')
  return i < 0 ? undefined : { start: records[i] as Of<'verify'>, checks: records.slice(i + 1).filter(is('check')) }
}

export function buildReport(m: Mission, records: readonly MissionRecord[], facts: Facts): Report {
  const state = testState(records, facts)
  const pass = lastPass(records)
  const v = pass && verdict(pass.checks, m.criteria)
  const planned = m.tasks?.length ? taskStates(m.tasks, records, { over: FINAL.has(m.status) }) : undefined
  const byCriterion = new Map((pass?.checks ?? []).filter((c) => typeof c.criterion === 'number').map((c) => [c.criterion, c] as const))
  const tools = records.filter(is('tool'))
  const results = new Map(records.filter(is('tool-result')).map((r) => [r.id, r.ok] as const))
  const perms = records.filter(is('permission'))
  const auto = (d: Decision) => d === 'auto-allowed' || d === 'auto-denied'
  const edited = [...new Set(tools.filter((t) => EDIT_TOOLS.has(t.name)).map((t) => t.target))].map((path) => ({ path }))
  const sums = totals(records)
  const word = `${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`
  return {
    status: v
      ? [word, VERDICT_WORD[v], ...(m.status === 'finished' ? [] : [m.reason])].join(' · ')
      : m.status === 'finished'
        ? `Finished · ${TEST_LINES[state]}`
        : `${word} · ${m.reason}`,
    tests: { state, line: TEST_LINES[state] },
    criteria: m.criteria.map((c, i) => {
      const ran = byCriterion.get(i)
      const check = ran
        ? ran.status === 'pass'
          ? `passed (${ran.command})`
          : outcome(ran)
        : c.how === 'manual' || (pass && !isCommandHow(c.how))
          ? 'needs you'
          : 'not checked by Spark'
      return { ...c, check }
    }),
    files: facts.files ?? edited,
    ...(facts.files
      ? {}
      : { filesNote: facts.inRepo ? 'Spark could not compare the snapshots: these are the files edit tools touched' : "not a git repo: only files edit tools touched; shell changes aren't seen" }),
    commands: tools.filter((t) => SHELL_TOOLS.has(t.name)).map((t) => ({ command: t.target, ok: results.get(t.id) })),
    checks: records.filter(is('gate')).map((r) => ({ at: r.at, ok: r.ok, line: gateLine(r) })),
    approvals: {
      cards: perms.filter((p) => !auto(p.decision)).length,
      allowed: perms.filter((p) => p.decision === 'allowed' || p.decision === 'always').length,
      denied: perms.filter((p) => p.decision === 'denied').map((p) => `${p.tool} ${p.target}`),
      bySpark: perms.filter((p) => auto(p.decision)).length,
    },
    time: { ...(m.approvedAt === undefined ? {} : { wallMs: (m.endedAt ?? facts.now) - m.approvedAt }), workedMs: sums.workedMs },
    cost: { ...(sums.usd === undefined ? {} : { usd: sums.usd }), ...(sums.tokens === undefined ? {} : { tokens: sums.tokens }) },
    claude: records.filter(is('turn')).at(-1)?.text ?? '',
    ...(planned
      ? {
          tasks: m.tasks!.map((t) => {
            const view = planned[t.id]!
            return { id: t.id, title: t.title, after: t.after, state: view.state, attempts: view.attempts, ...(view.files ? { files: view.files } : {}), line: taskLine(t, view) }
          }),
        }
      : {}),
    ...(pass && v
      ? {
          proof: {
            verdict: v,
            at: pass.start.at,
            again: pass.start.again === true,
            logDir: `.spark/missions/${m.id}/checks`,
            checks: pass.checks.map((c) => ({ name: c.name, status: c.status, line: proofLine(c), ...(c.log ? { log: c.log } : {}) })),
          },
        }
      : {}),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
export function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
const ktokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const timeOfDay = (at: number) => {
  const d = new Date(at)
  return Number.isFinite(at) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '--:--:--'
}

const GLYPH: Record<string, string> = { Bash: '›_', PowerShell: '›_', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Write: '＋', Read: '◱', Grep: '⌕', Glob: '⌕' }
const SAID: Record<string, string> = {
  allowed: 'you allowed',
  always: 'you allowed (always)',
  denied: 'you denied',
  'auto-allowed': 'Spark allowed',
  'auto-denied': 'Spark denied',
}
const PROCESS: Record<string, string> = {
  started: 'Claude Code started',
  resumed: 'Claude Code resumed the session',
  exited: 'Claude Code exited',
  'plan-mode-refused': 'Claude Code refused plan mode; the draft is read-only through Spark alone',
}

// One timeline row per record. Records can come from disk, so every field is coerced.
export function describe(r: MissionRecord): Row | undefined {
  const s = (v: unknown) => String(v ?? '')
  switch (r.kind) {
    case 'status':
      return { at: r.at, glyph: '◆', tone: r.to === 'blocked' ? 'fail' : r.to === 'finished' ? 'ok' : 'info', text: `${s(r.to)} · ${s(r.reason)}` }
    case 'you':
      return { at: r.at, glyph: '›', tone: 'info', text: `you: ${s(r.text)}` }
    case 'tool':
      return { at: r.at, glyph: GLYPH[s(r.name)] ?? '•', tone: 'info', text: `${s(r.name)} ${s(r.target)}`.trim() }
    case 'tool-result':
      return r.ok === true ? undefined : { at: r.at, glyph: '✗', tone: 'fail', text: 'the tool call failed', ...(r.tail ? { detail: s(r.tail) } : {}) }
    case 'permission':
      return { at: r.at, glyph: '?', tone: s(r.decision).endsWith('denied') ? 'warn' : 'info', text: `${SAID[s(r.decision)] ?? s(r.decision)} ${s(r.tool)} ${s(r.target)}`.trim() }
    case 'turn': {
      if (r.ok !== true) return { at: r.at, glyph: '✗', tone: 'fail', text: `turn failed: ${s(r.text).slice(0, 200)}` }
      const parts = ['turn ended']
      if (typeof r.durationMs === 'number') parts.push(clock(r.durationMs))
      if (typeof r.costUsd === 'number') parts.push(`$${r.costUsd.toFixed(2)}`)
      if (typeof r.tokens === 'number') parts.push(`${ktokens(r.tokens)} tokens`)
      return { at: r.at, glyph: '✦', tone: 'ok', text: parts.join(' · ') }
    }
    case 'gate':
      return { at: r.at, glyph: r.ok === true ? '✓' : '✗', tone: r.ok === true ? 'ok' : 'fail', text: gateLine(r) }
    case 'model':
      return { at: r.at, glyph: '◇', tone: 'info', text: `model ${s(r.model)}` }
    case 'process':
      return {
        at: r.at,
        glyph: '⏻',
        tone: r.event === 'exited' || r.event === 'plan-mode-refused' ? 'warn' : 'info',
        text: `${PROCESS[s(r.event)] ?? s(r.event)}${typeof r.code === 'number' ? ` (code ${r.code})` : ''}`,
        ...(r.error ? { detail: s(r.error) } : {}),
      }
    case 'verify':
      return { at: r.at, glyph: '◆', tone: 'info', text: r.again === true ? 'Spark checked again, on the working tree as it is now' : 'Spark ran its checks' }
    case 'task': {
      const id = `task ${s(r.id)}`
      const c = r.check
      const tail = c?.tail ? { detail: s(c.tail) } : {}
      if (r.event === 'started') return { at: r.at, glyph: '▶', tone: 'info', text: `${id} started` }
      if (r.event === 'retry') return { at: r.at, glyph: '↻', tone: 'warn', text: `${id}: check ${c ? outcome(c) : 'failed'}, sent back (attempt ${s(r.attempt)})`, ...tail }
      if (r.event === 'done') return { at: r.at, glyph: '✓', tone: 'ok', text: `${id} done${c ? ` · check ${outcome(c)}` : ''}${r.note ? ` · ${s(r.note)}` : ''}` }
      return { at: r.at, glyph: '✗', tone: 'fail', text: `${id} failed: ${s(r.note)}`, ...tail }
    }
    case 'check':
      return {
        at: r.at,
        glyph: r.status === 'pass' ? '✓' : r.status === 'not-run' ? '·' : '✗',
        tone: r.status === 'pass' ? 'ok' : r.status === 'not-run' ? 'warn' : 'fail',
        text: `${s(r.name)} ${outcome(r)}`,
        ...(r.status !== 'pass' && r.tail ? { detail: s(r.tail) } : {}),
      }
  }
  return undefined
}

const field = (o: unknown, key: string): unknown => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v))

// The report as headed lines for the window and the terminal pane. report.json can come with the
// repo, so every field is read defensively.
export function reportSections(r: unknown): Section[] {
  const tests = text(field(field(r, 'tests'), 'state'))
  const approvals = field(r, 'approvals')
  const denied = list(field(approvals, 'denied'))
  const time = field(r, 'time')
  const wall = field(time, 'wallMs')
  const usd = field(field(r, 'cost'), 'usd')
  const tokens = field(field(r, 'cost'), 'tokens')
  const note = field(r, 'filesNote')
  const proof = field(r, 'proof')
  const said = field(proof, 'verdict')
  const statusTone = proof
    ? said === 'verified' ? 'ok' : said === 'checks failed' ? 'fail' : 'warn'
    : tests === 'passed' ? 'ok' : tests === 'failing' ? 'fail' : 'warn'
  const at = timeOfDay(Number(field(proof, 'at')))
  const logDir = text(field(proof, 'logDir'))
  return [
    { heading: 'Status', lines: [{ text: text(field(r, 'status')), tone: statusTone }] },
    ...(proof
      ? [
          {
            heading: 'Proof of completion',
            lines: [
              { text: field(proof, 'again') === true ? `Checked again at ${at}, on the working tree as it was then` : `Spark ran these checks itself at ${at}` },
              ...list(field(proof, 'checks')).map((c) => {
                const status = field(c, 'status')
                const log = field(c, 'log')
                return {
                  text: `${status === 'pass' ? '✓' : status === 'not-run' ? '·' : '✗'} ${text(field(c, 'name'))} · ${text(field(c, 'line'))}${log ? ` · log ${logDir}/${text(log)}` : ''}`,
                  tone: status === 'pass' ? ('ok' as const) : status === 'not-run' ? ('warn' as const) : ('fail' as const),
                }
              }),
            ],
          },
        ]
      : []),
    {
      heading: 'Criteria',
      lines: list(field(r, 'criteria')).map((c) => ({
        text: `${text(field(c, 'text'))} · ${text(field(c, 'how'))} · ${text(field(c, 'check'))}${field(c, 'by') === 'you' ? ' · yours' : ''}`,
        tone: field(c, 'check') === 'needs you' ? ('warn' as const) : ('info' as const),
      })),
    },
    ...(Array.isArray(field(r, 'tasks'))
      ? [
          {
            heading: 'Tasks',
            lines: list(field(r, 'tasks')).map((t) => {
              const state = field(t, 'state')
              return {
                text: `${state === 'done' ? '✓' : state === 'failed' ? '✗' : '·'} ${text(field(t, 'line'))}`,
                tone: state === 'done' ? ('ok' as const) : state === 'failed' ? ('fail' as const) : ('warn' as const),
              }
            }),
          },
        ]
      : []),
    {
      heading: 'Changed files',
      lines: [
        ...list(field(r, 'files')).map((f) => ({
          text: typeof field(f, 'added') === 'number' ? `${text(field(f, 'path'))} +${text(field(f, 'added'))} −${text(field(f, 'removed'))}` : text(field(f, 'path')),
        })),
        ...(note ? [{ text: text(note), tone: 'warn' as const }] : []),
      ],
    },
    {
      heading: 'Commands run',
      lines: list(field(r, 'commands')).map((c) => {
        const ok = field(c, 'ok')
        return { text: `${ok === false ? '✗' : ok === true ? '✓' : '·'} ${text(field(c, 'command'))}`, tone: ok === false ? ('fail' as const) : ('info' as const) }
      }),
    },
    {
      heading: 'Checks',
      lines: list(field(r, 'checks')).map((c) => ({ text: `${timeOfDay(Number(field(c, 'at')))} ${text(field(c, 'line'))}`, tone: field(c, 'ok') === true ? ('ok' as const) : ('fail' as const) })),
    },
    {
      heading: 'Approvals',
      lines: [
        { text: `${text(field(approvals, 'cards')) || 0} cards · ${text(field(approvals, 'allowed')) || 0} allowed · ${denied.length} denied · ${text(field(approvals, 'bySpark')) || 0} answered by Spark` },
        ...denied.map((d) => ({ text: `denied: ${text(d)}`, tone: 'warn' as const })),
      ],
    },
    {
      heading: 'Time and cost',
      lines: [
        { text: `${typeof wall === 'number' ? `${clock(wall)} since approval · ` : ''}Claude worked ${clock(Number(field(time, 'workedMs')) || 0)}, drafting included` },
        {
          text:
            typeof usd === 'number'
              ? `$${usd.toFixed(2)} at API rates, as Claude Code reports it${typeof tokens === 'number' ? ` · ${ktokens(tokens)} tokens` : ''}`
              : 'cost not reported',
        },
      ],
    },
    { heading: "Claude's account (not verified by Spark)", lines: [{ text: text(field(r, 'claude')) }], markdown: true },
  ]
}

// The git half of a report: the end snapshot, what changed since the start, and the end tree. A
// report built again (Check again) keeps the end snapshot the mission ended with.
export async function gitFacts(run: Run | undefined, m: Mission, now: number): Promise<{ mission: Mission; facts: Facts }> {
  if (!run) return { mission: m, facts: { inRepo: false, now } }
  try {
    const endSha = m.endSha ?? (await pinSnapshot(run, `refs/spark/missions/${m.id}/end`, `mission ${m.id} end`))
    const files = m.startSha ? await numstat(run, m.startSha, endSha) : undefined
    const endTree = await treeOf(run, endSha)
    return { mission: { ...m, endSha }, facts: { inRepo: true, now, endTree, ...(files ? { files } : {}) } }
  } catch {
    return { mission: m, facts: { inRepo: true, now } }
  }
}
