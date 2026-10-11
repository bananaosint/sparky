import { test, expect } from 'claude-code/testing'
import { buildReport, clock, describe, reportSections, testState, totals } from '../hooks/mission-report'
import { newMission } from '../hooks/mission'
import type { Mission, MissionRecord } from '../hooks/mission'

const T = 'c'.repeat(40)
const base = newMission('rate-limit login', 1000, 'beef', 0).mission
const done = (over: Partial<Mission> = {}): Mission => ({
  ...base,
  status: 'finished',
  reason: 'Claude finished the work',
  approvedAt: 2000,
  endedAt: 62_000,
  criteria: [
    { text: 'sixth login gets 429', how: 'npm test', by: 'claude' },
    { text: 'message reads well', how: 'manual', by: 'you' },
  ],
  ...over,
})
const records: MissionRecord[] = [
  { at: 3000, kind: 'tool', id: 't1', name: 'Edit', target: 'C:/app/src/auth.js' },
  { at: 3100, kind: 'tool-result', id: 't1', ok: true },
  { at: 4000, kind: 'tool', id: 't2', name: 'Bash', target: 'npm test' },
  { at: 4100, kind: 'tool-result', id: 't2', ok: false, tail: 'not ok 2 lockout' },
  { at: 4200, kind: 'permission', tool: 'Bash', target: 'npm i express-rate-limit', decision: 'denied' },
  { at: 4300, kind: 'permission', tool: 'Edit', target: 'C:/app/src/auth.js', decision: 'auto-allowed' },
  { at: 4400, kind: 'permission', tool: 'Bash', target: 'npm test', decision: 'allowed' },
  { at: 5000, kind: 'gate', check: 'tests', ok: false, exit: 1, tree: 'd'.repeat(40) },
  { at: 6000, kind: 'gate', check: 'tests', ok: true, tree: T },
  { at: 7000, kind: 'turn', ok: true, text: 'Changed auth.js; tests pass.', durationMs: 50_000, costUsd: 0.4, tokens: 30_000 },
]

test('test state: passed only when the last run passed on exactly the final tree', () => {
  expect(testState(records, { inRepo: true, endTree: T })).toBe('passed')
  expect(testState(records, { inRepo: true, endTree: 'e'.repeat(40) })).toBe('not-run')
  expect(testState(records, { inRepo: false })).toBe('passed-unknown')
  expect(testState(records.slice(0, 8), { inRepo: true, endTree: T })).toBe('failing')
  expect(testState([], { inRepo: true, endTree: T })).toBe('not-run')
})

test('the report comes from records: files, commands, checks, approvals, cost', () => {
  const r = buildReport(done(), records, { inRepo: true, endTree: T, now: 99_000, files: [{ path: 'src/auth.js', added: 12, removed: 3 }] })
  expect(r.status).toBe('Finished · tests passed on this code')
  expect(r.criteria.map((c) => c.check)).toEqual(['not checked by Spark', 'needs you'])
  expect(r.files).toEqual([{ path: 'src/auth.js', added: 12, removed: 3 }])
  expect(r.filesNote).toBeUndefined()
  expect(r.commands).toEqual([{ command: 'npm test', ok: false }])
  expect(r.checks.map((c) => c.line)).toEqual(['tests failed (exit 1)', 'tests passed'])
  expect(r.approvals).toEqual({ cards: 2, allowed: 1, denied: ['Bash npm i express-rate-limit'], bySpark: 1 })
  expect(r.time).toEqual({ wallMs: 60_000, workedMs: 50_000 })
  expect(r.cost).toEqual({ usd: 0.4, tokens: 30_000 })
  expect(r.claude).toBe('Changed auth.js; tests pass.')
})

test('outside a repo the files are what edit tools touched, with a note; unknown cost stays unknown', () => {
  const noCost = records.map((x) => (x.kind === 'turn' ? { at: x.at, kind: 'turn' as const, ok: true, text: x.text } : x))
  const r = buildReport(done({ status: 'blocked', reason: 'halted after two failed test or build runs' }), noCost, { inRepo: false, now: 99_000 })
  expect(r.status).toBe('Blocked · halted after two failed test or build runs')
  expect(r.files).toEqual([{ path: 'C:/app/src/auth.js' }])
  expect(r.filesNote).toContain('not a git repo')
  expect(r.cost).toEqual({})
  expect(totals(noCost).workedMs).toBe(0)
})

test('timeline rows: a successful tool result folds into its call, and a failure shows its tail', () => {
  expect(describe(records[1]!)).toBeUndefined()
  expect(describe(records[3]!)).toMatchObject({ tone: 'fail', detail: 'not ok 2 lockout' })
  expect(describe(records[4]!)?.text).toBe('you denied Bash npm i express-rate-limit')
  expect(describe(records[5]!)?.text).toBe('Spark allowed Edit C:/app/src/auth.js')
  expect(describe(records[9]!)?.text).toBe('turn ended · 0:50 · $0.40 · 30k tokens')
  expect(describe({ at: 1, kind: 'gate', check: 'halt', ok: false })?.text).toBe('halted: two failed test or build runs in a row')
})

test('rows and sections survive hostile files from disk', () => {
  const junk = { at: 1, kind: 'turn', ok: 'yes', text: { html: '<b>' }, costUsd: 'free' } as unknown as MissionRecord
  expect(() => describe(junk)).not.toThrow()
  for (const report of [null, 'x', { criteria: 'no', files: [1, null], approvals: 5 }]) expect(() => reportSections(report)).not.toThrow()
  const sections = reportSections(buildReport(done(), records, { inRepo: true, endTree: T, now: 99_000 }))
  expect(sections.map((s) => s.heading)).toEqual(['Status', 'Criteria', 'Changed files', 'Commands run', 'Checks', 'Approvals', 'Time and cost', "Claude's account (not verified by Spark)"])
  expect(sections.at(-1)?.markdown).toBe(true)
  // Worked time counts the draft turn too, so it can exceed the time since approval: say so.
  expect(sections.find((s) => s.heading === 'Time and cost')?.lines[0]?.text).toBe('1:00 since approval · Claude worked 0:50, drafting included')
})

test('clock reads m:ss, or h:mm:ss past an hour', () => {
  expect(clock(50_000)).toBe('0:50')
  expect(clock(3_725_000)).toBe('1:02:05')
})
