// What a mission ends with, and its timeline: both built from records alone. Claude's own
// account of the work is kept apart and labeled as unverified.
import { numstat, pinSnapshot, treeOf } from './snapshot.ts'
import type { Run } from './snapshot.ts'
import { EDIT_TOOLS, SHELL_TOOLS } from './mission.ts'
import type { Decision, GateRecord, Mission, MissionRecord } from './mission.ts'

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

export function buildReport(m: Mission, records: readonly MissionRecord[], facts: Facts): Report {
  const state = testState(records, facts)
  const tools = records.filter(is('tool'))
  const results = new Map(records.filter(is('tool-result')).map((r) => [r.id, r.ok] as const))
  const perms = records.filter(is('permission'))
  const auto = (d: Decision) => d === 'auto-allowed' || d === 'auto-denied'
  const edited = [...new Set(tools.filter((t) => EDIT_TOOLS.has(t.name)).map((t) => t.target))].map((path) => ({ path }))
  const sums = totals(records)
  const word = `${m.status.charAt(0).toUpperCase()}${m.status.slice(1)}`
  return {
    status: m.status === 'finished' ? `Finished · ${TEST_LINES[state]}` : `${word} · ${m.reason}`,
    tests: { state, line: TEST_LINES[state] },
    criteria: m.criteria.map((c) => ({ ...c, check: c.how === 'manual' ? 'needs you' : 'not checked by Spark' })),
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
  return [
    { heading: 'Status', lines: [{ text: text(field(r, 'status')), tone: tests === 'passed' ? 'ok' : tests === 'failing' ? 'fail' : 'warn' }] },
    {
      heading: 'Criteria',
      lines: list(field(r, 'criteria')).map((c) => ({
        text: `${text(field(c, 'text'))} · ${text(field(c, 'how'))} · ${text(field(c, 'check'))}${field(c, 'by') === 'you' ? ' · yours' : ''}`,
        tone: field(c, 'check') === 'needs you' ? ('warn' as const) : ('info' as const),
      })),
    },
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
        { text: `${typeof wall === 'number' ? `${clock(wall)} since approval · ` : ''}Claude worked ${clock(Number(field(time, 'workedMs')) || 0)}` },
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

// The git half of a report: the end snapshot, what changed since the start, and the end tree.
export async function gitFacts(run: Run | undefined, m: Mission, now: number): Promise<{ mission: Mission; facts: Facts }> {
  if (!run) return { mission: m, facts: { inRepo: false, now } }
  try {
    const endSha = await pinSnapshot(run, `refs/spark/missions/${m.id}/end`, `mission ${m.id} end`)
    const files = m.startSha ? await numstat(run, m.startSha, endSha) : undefined
    const endTree = await treeOf(run, endSha)
    return { mission: { ...m, endSha }, facts: { inRepo: true, now, endTree, ...(files ? { files } : {}) } }
  } catch {
    return { mission: m, facts: { inRepo: true, now } }
  }
}
