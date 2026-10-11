import { test, expect } from 'claude-code/testing'
import {
  DRAFT_DENIED, approvedCriteria, approvedPlan, asMission, asRecord, criteriaCount, draftText, isMissionId, isSessionId, missionId, move, newMission,
  onTurnEnd, parseGateLines, parseMissionBlock, processRecord, recordsFor, resumeFailed, resumeText, runText, turnEnded,
} from '../hooks/mission'
import type { Mission, MissionRecord } from '../hooks/mission'

const AT = new Date(2026, 9, 10, 18, 5, 9).getTime()
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SHA = 'a'.repeat(40)
const DRAFT = 'I read src/auth.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"A sixth failed login in a minute gets 429","how":"npm test"},{"text":"The lockout message reads well","how":""}]}\n```'
const mission = (over: Partial<Mission> = {}): Mission => ({ ...newMission('rate-limit the login route', AT, 'beef', 0).mission, ...over })

test('ids are dated and checked, and session ids must be UUIDs', () => {
  expect(missionId(AT, 'beef')).toBe('m-20261010-180509-beef')
  expect(isMissionId('m-20261010-180509-beef')).toBe(true)
  for (const bad of ['..\\..\\x', 'm-20261010-180509-BEEF', 'm-1-2-beef', 42]) expect(isMissionId(bad)).toBe(false)
  expect(isSessionId(SESSION)).toBe(true)
  expect(isSessionId('--dangerously-skip-permissions')).toBe(false)
})

test('a new mission is a draft that remembers where gate.jsonl ended', () => {
  const { mission: m, record } = newMission('  rate-limit the login route ', AT, 'beef', 120)
  expect(m).toMatchObject({ id: 'm-20261010-180509-beef', title: 'rate-limit the login route', status: 'draft', criteria: [], gateOffset: 120 })
  expect(record).toEqual({ at: AT, kind: 'status', to: 'draft', reason: 'mission created' })
})

test('moves follow the lifecycle table, and a final mission stays final', () => {
  const m = mission({ status: 'review' })
  const { mission: running, record } = move(m, 'running', 'you approved 2 criteria', AT + 1)
  expect(running.status).toBe('running')
  expect(record).toEqual({ at: AT + 1, kind: 'status', from: 'review', to: 'running', reason: 'you approved 2 criteria' })
  expect(move(running, 'finished', 'done', AT + 2).mission.endedAt).toBe(AT + 2)
  expect(() => move(m, 'finished', 'skip', AT)).toThrow("a review mission can't become finished")
  expect(() => move(mission({ status: 'cancelled' }), 'running', 'again', AT)).toThrow()
})

test('records redact and clip: secrets never reach .spark/, error tails keep 20 lines', () => {
  const [tool] = recordsFor({ kind: 'tool', id: 't1', name: 'Bash', input: { command: `curl -H "token=ghp_${'a'.repeat(36)}" ${'x'.repeat(400)}` } }, AT)
  expect(tool).toMatchObject({ kind: 'tool', id: 't1', name: 'Bash' })
  expect((tool as { target: string }).target).not.toContain('ghp_')
  expect((tool as { target: string }).target.length).toBeLessThanOrEqual(301)
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const [failed] = recordsFor({ kind: 'tool-result', id: 't1', isError: true, output: lines }, AT)
  expect((failed as { tail: string }).tail.split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 30}`))
  expect(recordsFor({ kind: 'tool-result', id: 't2', isError: false, output: 'fine' }, AT)).toEqual([{ at: AT, kind: 'tool-result', id: 't2', ok: true }])
  const [turn] = recordsFor({ kind: 'result', ok: true, text: 'done', durationMs: 2000, costUsd: 0.25, usage: { input: 1000, output: 200, cacheWrite: 300 } }, AT)
  expect(turn).toEqual({ at: AT, kind: 'turn', ok: true, text: 'done', durationMs: 2000, costUsd: 0.25, tokens: 1500 })
  // The terminal knows no cost or duration: those stay out rather than read as zero.
  expect(recordsFor({ kind: 'result', ok: true, text: 'done' }, AT)).toEqual([{ at: AT, kind: 'turn', ok: true, text: 'done' }])
  expect(recordsFor({ kind: 'delta', text: 'x' }, AT)).toEqual([])
})

test('the mission block: the last one counts, how defaults to manual, anything malformed is no block', () => {
  expect(parseMissionBlock(DRAFT)).toEqual({
    title: 'Rate-limit login',
    criteria: [
      { text: 'A sixth failed login in a minute gets 429', how: 'npm test', by: 'claude' },
      { text: 'The lockout message reads well', how: 'manual', by: 'claude' },
    ],
  })
  expect(parseMissionBlock(`${DRAFT}\nRevised:\n\`\`\`mission\n{"title":"v2","criteria":[{"text":"x","how":"y"}]}\n\`\`\``)?.title).toBe('v2')
  for (const bad of ['no block', '```mission\n{not json}\n```', '```mission\n{"criteria":[]}\n```', '```mission\n{"criteria":[{"how":"x"}]}\n```'])
    expect(parseMissionBlock(bad)).toBeUndefined()
})

test("approved criteria: rows kept as drafted stay Claude's, edited rows are yours, blank rows go", () => {
  const drafted = parseMissionBlock(DRAFT)!.criteria
  expect(approvedCriteria(drafted, [{ text: drafted[0]!.text, how: 'npm test' }, { text: 'Locked users see when to retry', how: 'manual' }, { text: '  ', how: 'x' }, 'junk'])).toEqual([
    { text: drafted[0]!.text, how: 'npm test', by: 'claude' },
    { text: 'Locked users see when to retry', how: 'manual', by: 'you' },
  ])
  expect(approvedCriteria(drafted, 'not a list')).toEqual([])
})

test('gate lines: only well-formed ones become records', () => {
  const text = [
    JSON.stringify({ at: 5, check: 'tests', ok: true, tree: 'b'.repeat(40) }),
    JSON.stringify({ at: 6, check: 'build', ok: false, exit: 2 }),
    JSON.stringify({ at: 7, check: 'deploy', ok: true }),
    JSON.stringify({ at: 8, check: 'tests', ok: true, tree: '--output=x' }),
    'not json',
    '',
  ].join('\n')
  expect(parseGateLines(text)).toEqual([
    { at: 5, kind: 'gate', check: 'tests', ok: true, tree: 'b'.repeat(40) },
    { at: 6, kind: 'gate', check: 'build', ok: false, exit: 2 },
    { at: 8, kind: 'gate', check: 'tests', ok: true },
  ])
})

test('texts: the draft asks for the block and no changes; run and resume carry the criteria', () => {
  expect(draftText('rate-limit the login route')).toContain('```mission')
  expect(draftText('rate-limit the login route')).toContain("don't change anything")
  const m = mission({ criteria: parseMissionBlock(DRAFT)!.criteria })
  expect(runText(m)).toContain('1. A sixth failed login in a minute gets 429 (check: npm test)')
  expect(resumeText(m)).toContain("don't redo finished work")
})

test('turn ends: draft goes to review; then finished, waiting on a question, or blocked on a failure or a halt', () => {
  const draft = mission()
  expect(onTurnEnd(draft, { ok: true, text: DRAFT }, false)).toMatchObject({ to: 'review', reason: '2 criteria drafted' })
  expect(onTurnEnd(draft, { ok: true, text: 'no block' }, false)).toEqual({ to: 'review', reason: 'no mission block came back; write the criteria' })
  expect(onTurnEnd(draft, { ok: true, text: '```mission\n{"criteria":[{"text":"x","how":"y"}]}\n```' }, false).reason).toBe('1 criterion drafted')
  expect(criteriaCount(1)).toBe('1 criterion')
  expect(criteriaCount(3)).toBe('3 criteria')
  const running = mission({ status: 'running', approvedAt: AT })
  expect(onTurnEnd(running, { ok: true, text: 'Done.' }, false).to).toBe('finished')
  expect(onTurnEnd(running, { ok: true, text: 'Should lockouts be per IP or per account?' }, false).to).toBe('waiting')
  expect(onTurnEnd(running, { ok: false, text: 'API error' }, false)).toEqual({ to: 'blocked', reason: 'the turn failed: API error' })
  expect(onTurnEnd(running, { ok: true, text: 'Done.' }, true)).toEqual({ to: 'blocked', reason: 'halted after two failed test or build runs' })
})

test('turnEnded takes the drafted criteria, the gate lines and the new offset; halts before approval do not count', () => {
  const draftDone = turnEnded(mission(), [], { ok: true, text: DRAFT }, [], 40, AT + 5)
  expect(draftDone.mission).toMatchObject({ status: 'review', title: 'Rate-limit login', gateOffset: 40 })
  expect(draftDone.mission.criteria).toHaveLength(2)
  const halt: MissionRecord = { at: AT + 10, kind: 'gate', check: 'halt', ok: false }
  const running = mission({ status: 'running', approvedAt: AT + 5 })
  const blocked = turnEnded(running, [], { ok: true, text: 'Done.' }, [halt], 90, AT + 20)
  expect(blocked.mission.status).toBe('blocked')
  expect(blocked.records[0]).toEqual(halt)
  expect(blocked.records[1]).toMatchObject({ kind: 'status', to: 'blocked' })
  const early: MissionRecord = { at: AT + 1, kind: 'gate', check: 'halt', ok: false }
  expect(turnEnded(running, [early], { ok: true, text: 'Done.' }, [], 90, AT + 20).mission.status).toBe('finished')
})

test('a resume whose process died before Claude Code said which model it runs has failed', () => {
  const resumed: MissionRecord = { at: 1, kind: 'process', event: 'resumed' }
  const exited: MissionRecord = { at: 2, kind: 'process', event: 'exited', code: 1 }
  expect(resumeFailed([resumed, exited])).toBe(true)
  expect(resumeFailed([resumed, { at: 2, kind: 'model', model: 'claude-opus-5-5' }, exited])).toBe(false)
  expect(resumeFailed([exited])).toBe(false)
})

test('mission.json from disk: hostile values are dropped, not passed on', () => {
  const ok = mission({ sessionId: SESSION, startSha: SHA })
  expect(asMission(JSON.parse(JSON.stringify(ok)))).toEqual(ok)
  const hostile = asMission({ ...ok, title: '<img src=x onerror=alert(1)>', sessionId: '--resume=x', startSha: '--output=C:/x', criteria: [{ text: 1 }, { text: 'a', how: 'b', by: 'admin' }] })
  expect(hostile?.title).toBe('<img src=x onerror=alert(1)>')
  expect(hostile?.sessionId).toBeUndefined()
  expect(hostile?.startSha).toBeUndefined()
  expect(hostile?.criteria).toEqual([{ text: 'a', how: 'b', by: 'claude' }])
  for (const bad of [null, 'x', { ...ok, id: '../x' }, { ...ok, status: 'won' }]) expect(asMission(bad)).toBeUndefined()
})

test('failure reasons and process errors are redacted before they are kept', () => {
  const key = `sk-${'a'.repeat(30)}`
  const running = mission({ status: 'running', approvedAt: AT })
  expect(onTurnEnd(running, { ok: false, text: `401: bad key ${key}` }, false).reason).not.toContain(key)
  const r = processRecord('exited', AT, { code: 1, error: `auth failed for ${key}\n${'x'.repeat(900)}` })
  expect(r).toMatchObject({ at: AT, kind: 'process', event: 'exited', code: 1 })
  expect((r as { error: string }).error).not.toContain(key)
  expect((r as { error: string }).error.length).toBeLessThanOrEqual(501)
  expect(processRecord('plan-mode-refused', AT, { error: '' })).toEqual({ at: AT, kind: 'process', event: 'plan-mode-refused' })
})

test('drafts only read', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'ExitPlanMode']) expect(DRAFT_DENIED.has(tool)).toBe(true)
  for (const tool of ['Read', 'Grep', 'Glob']) expect(DRAFT_DENIED.has(tool)).toBe(false)
})

test('a mission from a council plan starts in review with its criteria, and its run text carries the plan', () => {
  const criteria = [{ text: 'p95 under 50 ms', how: 'npm run bench', by: 'claude' as const }]
  const { mission: m, record } = newMission('speed up the cache', AT, 'beef', 0, { criteria, plan: '## Decision\nhybrid of A and C' })
  expect(m).toMatchObject({ status: 'review', reason: 'criteria from Council', criteria, plan: '## Decision\nhybrid of A and C' })
  expect(record).toMatchObject({ kind: 'status', to: 'review' })
  expect(runText(m)).toContain('Plan (from Council):\n## Decision\nhybrid of A and C')
  expect(asMission({ ...m, plan: 'x'.repeat(30_000) })!.plan!.length).toBeLessThanOrEqual(20_001)
  expect(asMission({ ...m, plan: 42 })!.plan).toBeUndefined()
})

const PLANNED = `I read it.\n\`\`\`mission\n${JSON.stringify({
  title: 'Rate-limit login',
  spec: `Per account, 15 minutes. token=ghp_${'d'.repeat(36)}`,
  criteria: [{ text: 'sixth login gets 429', how: 'npm test -- auth' }],
  tasks: [
    { id: 't1', title: 'Limiter', do: 'Add it', after: [], check: 'npm test -- limiter' },
    { id: 't2', title: 'Message', do: 'Say when', after: ['t1'] },
    { id: 't3', title: 'Docs', do: 'Write it up', after: ['t2'], check: 'npm run docs' },
  ],
})}\n\`\`\``
const planned = parseMissionBlock(PLANNED)!

test('a draft may carry a short spec and a task plan; a plan that does not hold together is dropped, and the reason says so', () => {
  expect(planned.spec).toContain('Per account')
  expect(planned.spec).not.toContain('ghp_')
  expect(planned.tasks!.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  const broken = PLANNED.replace('"after":["t1"]', '"after":["t9"]')
  const bad = parseMissionBlock(broken)!
  expect(bad.tasks).toBeUndefined()
  expect(bad.planError).toBe('task t2 waits for t9, which is not an earlier task')
  expect(bad.criteria).toHaveLength(1)
  const done = turnEnded(mission(), [], { ok: true, text: PLANNED }, [], 0, AT + 5)
  expect(done.mission.status).toBe('review')
  expect(done.mission.spec).toContain('Per account')
  expect(done.mission.tasks).toHaveLength(3)
  expect(done.records.at(-1)).toMatchObject({ reason: '1 criterion and 3 tasks drafted' })
  expect(turnEnded(mission(), [], { ok: true, text: broken }, [], 0, AT + 5).records.at(-1)).toMatchObject({
    reason: '1 criterion drafted; the task plan was dropped: task t2 waits for t9, which is not an earlier task',
  })
  expect(draftText('x')).toContain('"tasks"')
})

test('with tasks, the run text carries the spec and the plan and asks for the first task only; resume names the current task', () => {
  const m = mission({ status: 'running', approvedAt: AT, criteria: planned.criteria, spec: planned.spec!, tasks: planned.tasks! })
  const text = runText(m)
  expect(text).toContain('Spec:\nPer account')
  expect(text).toContain('t2. Message (after t1)')
  expect(text).toContain('t1. Limiter (check: npm test -- limiter)')
  expect(text.endsWith('Do only task t1 (Limiter) now: Add it\nIts check: npm test -- limiter. End your turn when it is done.')).toBe(true)
  expect(resumeText(m, m.tasks![1])).toContain('Do only task t2 (Message) now: Say when')
  expect(runText(mission({ criteria: planned.criteria }))).not.toContain('Do only task')
})

test('approvedPlan: edits stay, a removed task is rewired around, a check that is not a command is dropped, under 2 tasks is no plan', () => {
  const kept = approvedPlan(planned.tasks!, [
    { id: 't1', do: 'Add it per account', check: 'npm test -- limiter' },
    { id: 't3', do: 'Write it up', check: 'look at it' },
  ])
  expect(kept.map((t) => [t.id, t.do, t.after, t.check])).toEqual([
    ['t1', 'Add it per account', [], 'npm test -- limiter'],
    ['t3', 'Write it up', ['t1'], undefined],
  ])
  expect(approvedPlan(planned.tasks!, [{ id: 't1', do: 'x' }])).toEqual([])
  expect(approvedPlan(planned.tasks!, [{ id: 't1', do: 'x' }, { id: 'zz', do: 'new' }])).toEqual([])
  expect(approvedPlan(planned.tasks!, 'nope')).toEqual([])
})

test('a plan and task records from disk: a hostile plan is dropped, a long spec clipped, task records must be well-formed', () => {
  const ok = mission({ spec: 'short', tasks: planned.tasks! })
  expect(asMission(JSON.parse(JSON.stringify(ok)))).toEqual(ok)
  expect(asMission({ ...ok, tasks: [{ id: '../x', title: 'x', do: 'x', after: [] }, { id: 't2', title: 'x', do: 'x', after: ['t2'] }] })!.tasks).toBeUndefined()
  // 1500 characters and the ellipsis clip() adds, as the Council plan is clipped.
  expect(asMission({ ...ok, spec: 'x'.repeat(5000) })!.spec!.length).toBeLessThanOrEqual(1501)
  expect(asRecord({ at: 1, kind: 'task', id: 't1', event: 'done', attempt: 1 })).toBeDefined()
  for (const bad of [{ at: 1, kind: 'task', id: 't1', event: 'won', attempt: 1 }, { at: 1, kind: 'task', id: '../x', event: 'done', attempt: 1 }]) expect(asRecord(bad)).toBeUndefined()
})
