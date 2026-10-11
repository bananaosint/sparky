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

const UNTRUSTED = 'the folder is untrusted; only your own configured commands run'
const verified: MissionRecord[] = [
  ...records,
  { at: 8000, kind: 'verify', again: false },
  { at: 8100, kind: 'check', name: 'tests', command: 'npm test', status: 'pass', exit: 0, ms: 12_000, tree: T, tail: 'ok 3', log: '1.log' },
  { at: 8200, kind: 'check', name: 'lint', status: 'not-run', reason: UNTRUSTED },
  { at: 8300, kind: 'check', name: 'criterion 1', criterion: 0, command: 'npm test', status: 'pass', exit: 0, ms: 9000, log: '3.log' },
]

test("Spark's own checks give the verdict, the criteria lines and the proof; Claude's account plays no part", () => {
  const r = buildReport(done(), verified, { inRepo: true, endTree: T, now: 99_000 })
  expect(r.status).toBe('Finished · Needs review')
  expect(r.criteria.map((c) => c.check)).toEqual(['passed (npm test)', 'needs you'])
  expect(r.proof).toEqual({
    verdict: 'needs review',
    at: 8000,
    again: false,
    logDir: `.spark/missions/${base.id}/checks`,
    checks: [
      { name: 'tests', status: 'pass', line: 'npm test · passed · 0:12', log: '1.log' },
      { name: 'lint', status: 'not-run', line: `not run: ${UNTRUSTED}` },
      { name: 'criterion 1', status: 'pass', line: 'npm test · passed · 0:09', log: '3.log' },
    ],
  })
  const onlyCommands = done({ criteria: [{ text: 'sixth login gets 429', how: 'npm test', by: 'claude' }] })
  const clean = verified.filter((x) => !(x.kind === 'check' && x.name === 'lint'))
  expect(buildReport(onlyCommands, clean, { inRepo: true, endTree: T, now: 99_000 }).status).toBe('Finished · Verified')
})

test('the last pass counts: Check again replaces the earlier results and says what it ran on', () => {
  const again: MissionRecord[] = [
    ...verified,
    { at: 9000, kind: 'verify', again: true },
    { at: 9100, kind: 'check', name: 'tests', command: 'npm test', status: 'fail', exit: 1, ms: 4000, tail: 'not ok 2 lockout', log: '1.log' },
    { at: 9200, kind: 'check', name: 'criterion 1', criterion: 0, command: 'npm test', status: 'timed-out', exit: 1, ms: 300_000, log: '2.log' },
  ]
  const r = buildReport(done({ status: 'blocked', reason: 'Claude says it is blocked' }), again, { inRepo: true, endTree: T, now: 99_000 })
  expect(r.status).toBe('Blocked · Checks failed · Claude says it is blocked')
  expect(r.proof?.again).toBe(true)
  expect(r.proof?.checks.map((c) => c.line)).toEqual(['npm test · failed (exit 1) · 0:04', 'npm test · timed out · 5:00'])
  expect(r.criteria.map((c) => c.check)).toEqual(['timed out', 'needs you'])
  const sections = reportSections(r)
  expect(sections.map((s) => s.heading).slice(0, 3)).toEqual(['Status', 'Proof of completion', 'Criteria'])
  const proof = sections[1]!.lines
  expect(proof[0]?.text).toMatch(/^Checked again at \d\d:\d\d:\d\d, on the working tree as it was then$/)
  expect(proof.slice(1)).toEqual([
    { text: `✗ tests · npm test · failed (exit 1) · 0:04 · log .spark/missions/${base.id}/checks/1.log`, tone: 'fail' },
    { text: `✗ criterion 1 · npm test · timed out · 5:00 · log .spark/missions/${base.id}/checks/2.log`, tone: 'fail' },
  ])
  expect(sections[0]!.lines[0]?.tone).toBe('fail')
})

test('a check that could not start says why; check rows show in the timeline', () => {
  const broke: MissionRecord[] = [{ at: 1, kind: 'verify', again: false }, { at: 2, kind: 'check', name: 'criterion 1', criterion: 0, command: 'npm test', status: 'fail', reason: 'spawn cmd ENOENT', ms: 5 }]
  expect(buildReport(done(), broke, { inRepo: false, now: 9 }).criteria[0]?.check).toBe('failed: spawn cmd ENOENT')
  expect(describe(broke[0]!)).toMatchObject({ tone: 'info', text: 'Spark ran its checks' })
  expect(describe({ at: 1, kind: 'verify', again: true })?.text).toBe('Spark checked again, on the working tree as it is now')
  expect(describe(verified.at(-2)!)).toMatchObject({ tone: 'warn', text: `lint not run: ${UNTRUSTED}` })
  expect(describe({ at: 1, kind: 'check', name: 'build', command: 'npm run build', status: 'fail', exit: 2, tail: 'error TS2304' })).toMatchObject({ tone: 'fail', text: 'build failed (exit 2)', detail: 'error TS2304' })
  const junk = { at: 1, kind: 'check', name: { x: 1 }, status: 'great' } as unknown as MissionRecord
  expect(() => describe(junk)).not.toThrow()
})

test('clock reads m:ss, or h:mm:ss past an hour', () => {
  expect(clock(50_000)).toBe('0:50')
  expect(clock(3_725_000)).toBe('1:02:05')
})

const tasks = [
  { id: 't1', title: 'Limiter', do: 'Add it', after: [], check: 'npm test -- limiter' },
  { id: 't2', title: 'Message', do: 'Say when', after: ['t1'] },
  { id: 't3', title: 'Docs', do: 'Write it up', after: ['t2'] },
]
const taskRecords: MissionRecord[] = [
  { at: 10, kind: 'task', id: 't1', event: 'started', attempt: 1 },
  { at: 20, kind: 'task', id: 't1', event: 'retry', attempt: 2, check: { name: 'task t1', status: 'fail', exit: 1, tail: 'not ok 1' } },
  { at: 30, kind: 'task', id: 't1', event: 'done', attempt: 2, files: [{ path: 'src/auth.js', added: 9, removed: 1 }], check: { name: 'task t1', status: 'pass', exit: 0 } },
  { at: 40, kind: 'task', id: 't2', event: 'started', attempt: 1 },
  { at: 50, kind: 'task', id: 't2', event: 'failed', attempt: 2, note: "task t2's check failed twice", check: { name: 'task t2', status: 'timed-out' } },
]

test("a planned mission's report lists each task: its state, attempts, check and changed files, from Spark's records", () => {
  const r = buildReport(done({ status: 'blocked', reason: "task t2's check failed twice", tasks }), [...records, ...taskRecords], { inRepo: true, endTree: T, now: 99_000 })
  expect(r.tasks?.map((t) => [t.id, t.state, t.attempts])).toEqual([
    ['t1', 'done', 2],
    ['t2', 'failed', 2],
    ['t3', 'not reached', 0],
  ])
  const section = reportSections(r).find((s) => s.heading === 'Tasks')!
  expect(section.lines).toEqual([
    { text: '✓ t1 Limiter · done · 2 attempts · check passed · 1 file changed', tone: 'ok' },
    { text: "✗ t2 Message · failed · 2 attempts · check timed out · task t2's check failed twice", tone: 'fail' },
    { text: '· t3 Docs · not reached', tone: 'warn' },
  ])
  expect(reportSections(buildReport(done(), records, { inRepo: true, endTree: T, now: 99_000 })).some((s) => s.heading === 'Tasks')).toBe(false)
})

test('task records become timeline rows', () => {
  expect(describe(taskRecords[0]!)).toMatchObject({ tone: 'info', text: 'task t1 started' })
  expect(describe(taskRecords[1]!)).toMatchObject({ tone: 'warn', text: 'task t1: check failed (exit 1), sent back (attempt 2)', detail: 'not ok 1' })
  expect(describe(taskRecords[2]!)).toMatchObject({ tone: 'ok', text: 'task t1 done · check passed' })
  expect(describe(taskRecords[4]!)).toMatchObject({ tone: 'fail', text: "task t2 failed: task t2's check failed twice" })
  expect(describe({ at: 1, kind: 'task', id: 't9', event: 'done', attempt: 1, note: "no check: Claude's word" })).toMatchObject({ text: "task t9 done · no check: Claude's word" })
})

test("the pass the runner ran wins over check records found on disk, which a check's own code could have written", () => {
  const forged: MissionRecord[] = [
    ...records,
    { at: 8000, kind: 'verify', again: false },
    { at: 8100, kind: 'check', name: 'tests', command: 'npm test', status: 'fail', exit: 1, log: '1.log' },
    { at: 8150, kind: 'verify', again: false },
    { at: 8160, kind: 'check', name: 'tests', command: 'npm test', status: 'pass', exit: 0 },
    { at: 8200, kind: 'check', name: 'criterion 1', criterion: 0, command: 'npm test', status: 'pass', exit: 0 },
  ]
  const ran = { at: 8000, again: false, checks: [{ name: 'tests', command: 'npm test', status: 'fail' as const, exit: 1, log: '1.log' }, { name: 'criterion 1', criterion: 0, command: 'npm test', status: 'pass' as const, exit: 0 }] }
  const onlyCommands = done({ criteria: [{ text: 'sixth login gets 429', how: 'npm test', by: 'claude' }] })
  expect(buildReport(onlyCommands, forged, { inRepo: true, endTree: T, now: 99_000 }).status).toBe('Finished · Verified')
  expect(buildReport(onlyCommands, forged, { inRepo: true, endTree: T, now: 99_000 }, ran).status).toBe('Finished · Checks failed')
})

test('a stopped or collided parallel task reads as such in the timeline, not as failed', () => {
  expect(describe({ at: 1, kind: 'task', id: 't2', event: 'stopped', attempt: 1, worker: true })).toMatchObject({ tone: 'warn', text: 'task t2 stopped; it runs again on Resume' })
  expect(describe({ at: 1, kind: 'task', id: 't3', event: 'collided', attempt: 1, worker: true, note: 'collided with t2: b.js' })).toMatchObject({ tone: 'warn', text: 'task t3 collided with t2: b.js; it runs again in the main tree' })
  expect(describe({ at: 1, kind: 'task', id: 't2', event: 'started', attempt: 1, worker: true })).toMatchObject({ text: 'task t2 started in its own worktree' })
})
