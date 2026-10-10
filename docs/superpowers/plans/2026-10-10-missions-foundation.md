# Missions Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/mission <objective>` in the app (and the terminal): Claude drafts acceptance criteria read-only, you approve them, Claude works, and Spark records what really happened, ending with a report built from those records.

**Architecture:** Pure mission logic lives in `plugin/hooks/mission.ts` and `mission-report.ts`, shared by the app (loaded through Node's type stripping, as `app/lib/gate.js` loads `gate.ts`) and the terminal mod. The app adds a store (`.spark/missions/` JSONL) and a runner that sits on the Claude Code stream the way `marathon-runner.js` does. The plugin writes test-gate, build and halt outcomes to `.spark/gate.jsonl` so missions can report them.

**Tech Stack:** Electron 44 (Node 24 type stripping), vanilla JS renderer, Claude Code mod API (`claude-code`), `node:test`, `claude plugin test`, git.

**Spec:** `docs/superpowers/specs/2026-10-10-missions-foundation-design.md`

## Global Constraints

- No new dependencies. Node ≥ 24.
- Plugin modules the app imports use explicit `.ts` runtime import paths and only erasable TypeScript (no enums, namespaces, parameter properties).
- The renderer can't load `.ts`, so main formats timeline rows and report sections before they reach the window.
- Window text goes in with `textContent`. Markdown only goes through the existing `marked` + DOMPurify path.
- git runs with argument arrays, never through a shell. Values from `.spark/` files that reach git or `claude` are validated first: sha `^[0-9a-f]{40,64}$`, session id a UUID, mission id `^m-\d{8}-\d{6}-[0-9a-f]{4}$`.
- Every text field written to `.spark/` passes through `redact()` and is clipped. No file contents or full command output are stored.
- Copy follows Spark's prose rules: plain words, short sentences, none of the banned filler words.
- Checks: `npm test` (launcher + mod), `npm run check`, `cd app; npm test`. All green before each commit.

## Review Focus

1. A chat message typed while a mission is in `review`: the mission must not move, and the message is recorded as yours. Covered by the Task 7 test "a chat turn during review leaves the mission in review".
2. A Claude Code build that refuses `set_permission_mode`: the draft must stay read-only through the bridge, and the timeline must say plan mode was refused. Covered by the Task 7 test "a refused plan mode is recorded and the bridge still denies".
3. Resume after a session that can't be resumed (deleted or expired): the next Resume starts a fresh session instead of failing again. Covered by the Task 2 `resumeFailed` test and the Task 7 test "an exit interrupts; a resume that died starts fresh next time".
4. A repo that ships its own `.spark/` (hostile titles, a crafted `startSha` like `--output=x`, a fake `gate.jsonl` line): listed safely, sha and session id dropped, old gate lines ignored. Covered by the Task 6 tests and the Task 7 halt test.
5. Secrets and huge outputs in commands and tool errors: redacted, and clipped to their limits. Covered by the Task 2 test "records redact and clip".

---

### Task 1: Probe Claude Code's headless permission-mode control

Throwaway. It settles whether drafts get Claude Code's plan mode on top of the bridge denial.

**Files:**
- Create (outside the repo): `%TEMP%\spark-probe\probe.mjs`
- Modify: `docs/superpowers/specs/2026-10-10-missions-foundation-design.md` (Draft section, one sentence)

- [ ] **Step 1: Write the probe**

```js
// %TEMP%\spark-probe\probe.mjs: sends set_permission_mode twice and no user message, so no model call.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: process.env.TEMP, windowsHide: true });
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const timer = setTimeout(() => { console.log('timeout: no control_response'); child.kill(); }, 20000);
createInterface({ input: child.stdout }).on('line', (line) => {
  let j; try { j = JSON.parse(line); } catch { return; }
  if (j.type !== 'control_response') return;
  console.log(JSON.stringify(j.response));
  if (j.response.request_id === 'pm1') send({ type: 'control_request', request_id: 'pm2', request: { subtype: 'set_permission_mode', mode: 'default' } });
  else { clearTimeout(timer); child.kill(); }
});
send({ type: 'control_request', request_id: 'pm1', request: { subtype: 'set_permission_mode', mode: 'plan' } });
```

- [ ] **Step 2: Run it**

Run (PowerShell): `node "$env:TEMP\spark-probe\probe.mjs"`
Expected: two lines with `"subtype":"success"`, for `pm1` and `pm2`. If Spark's approval bridge refuses the command, ask the user to run it and paste the output.

- [ ] **Step 3: Record the result in the spec**

On success, replace the Draft section's sentences from "Plan Task 1 checks `set_permission_mode`" to "says so." with "Checked against Claude Code <version>: `set_permission_mode` to `plan` and back to `default` both succeed."

On failure, write the error there instead, and add to "Not covered": "Drafts are read-only through Spark's bridge alone: Claude Code <version> refuses `set_permission_mode`."

The runner sends the request either way, and a refusal is recorded (Task 7).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-10-missions-foundation-design.md
git commit -m "Missions spec: record the permission-mode probe"
```

---

### Task 2: Mission core (`plugin/hooks/mission.ts`)

**Files:**
- Create: `plugin/hooks/mission.ts`
- Test: `plugin/test/mission.test.ts`

**Interfaces:**
- Consumes: `redact(text)` from `plugin/hooks/redact.ts`; `endsInQuestion(text)` from `plugin/hooks/testgate.ts`.
- Produces (exact names used by Tasks 3, 6, 7 and 10):
  - types `Status`, `Criterion`, `Mission`, `Decision`, `GateCheck`, `GateRecord`, `MissionRecord`, `TurnEnd`
  - `FINAL`, `LIVE`, `EDIT_TOOLS`, `SHELL_TOOLS`, `DRAFT_DENIED` (`ReadonlySet`); `DRAFT_DENIAL` (string)
  - `move(m, to, reason, at) → { mission, record }`, which throws on a move the lifecycle table forbids
  - `missionId(at, hex4)`, `isMissionId(v)`, `isSessionId(v)`
  - `newMission(objective, at, hex4, gateOffset) → { mission, record }`
  - `target(input) → string`, `recordsFor(event, at) → MissionRecord[]`, `youRecord(text, at)`, `permissionRecord(tool, input, decision, at, gate?)`
  - `parseGateLines(text) → MissionRecord[]`, `parseMissionBlock(text) → { title, criteria } | undefined`, `approvedCriteria(drafted, sent) → Criterion[]`
  - `draftText(objective)`, `runText(m)`, `resumeText(m)`
  - `onTurnEnd(m, turn, halted) → TurnEnd`, `turnEnded(m, earlier, turn, gates, gateOffset, at) → { mission, records }`, `resumeFailed(records) → boolean`
  - `asMission(json) → Mission | undefined`, `asRecord(json) → MissionRecord | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
// plugin/test/mission.test.ts
import { test, expect } from 'claude-code/testing'
import {
  DRAFT_DENIED, approvedCriteria, asMission, draftText, isMissionId, isSessionId, missionId, move, newMission,
  onTurnEnd, parseGateLines, parseMissionBlock, recordsFor, resumeFailed, resumeText, runText, turnEnded,
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

test('drafts only read', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'ExitPlanMode']) expect(DRAFT_DENIED.has(tool)).toBe(true)
  for (const tool of ['Read', 'Grep', 'Glob']) expect(DRAFT_DENIED.has(tool)).toBe(false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugin`
Expected: FAIL in `mission.test.ts`: cannot resolve `../hooks/mission`.

- [ ] **Step 3: Write `plugin/hooks/mission.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test plugin`
Expected: the mission tests PASS, and the rest still PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npm run check`. Expected: no errors, "Validation passed".

```bash
git add plugin/hooks/mission.ts plugin/test/mission.test.ts
git commit -m "Missions: the pure core (lifecycle, records, criteria, texts)"
```

---

### Task 3: Report and timeline (`plugin/hooks/mission-report.ts`)

Do Task 4 first, or with this task: `mission-report.ts` imports `pinSnapshot`, `numstat` and `treeOf` from `snapshot.ts`, so the module won't load until they exist.

**Files:**
- Create: `plugin/hooks/mission-report.ts`
- Test: `plugin/test/mission-report.test.ts`

**Interfaces:**
- Consumes: the Task 2 types; `pinSnapshot`, `numstat`, `treeOf` and type `Run` from Task 4. Only `gitFacts` calls those, and Task 7 tests it with real git.
- Produces: types `FileStat`, `Facts`, `TestState`, `Report`, `Row`, `Section`; `testState(records, facts)`, `totals(records) → { usd?, tokens?, workedMs }`, `buildReport(m, records, facts) → Report`, `describe(record) → Row | undefined`, `reportSections(report: unknown) → Section[]`, `clock(ms)`, `gitFacts(run | undefined, m, now) → Promise<{ mission, facts }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// plugin/test/mission-report.test.ts
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
})

test('clock reads m:ss, or h:mm:ss past an hour', () => {
  expect(clock(50_000)).toBe('0:50')
  expect(clock(3_725_000)).toBe('1:02:05')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugin`
Expected: FAIL: cannot resolve `../hooks/mission-report`.

- [ ] **Step 3: Write `plugin/hooks/mission-report.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test plugin`. Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npm run check`. Expected: no errors.

```bash
git add plugin/hooks/mission-report.ts plugin/test/mission-report.test.ts
git commit -m "Missions: reports and timeline rows built from records"
```

---

### Task 4: Pinned snapshots, trees and numstat (`plugin/hooks/snapshot.ts`)

**Files:**
- Modify: `plugin/hooks/snapshot.ts` (`takeSnapshot` at lines 60-69, plus new exports)
- Test: `test/snapshot.test.js` (real git in temp folders)

**Interfaces:**
- Produces: `pinSnapshot(run, ref, label) → Promise<string>` (the sha), `treeNow(run) → Promise<string>`, `treeOf(run, commit) → Promise<string>`, `numstat(run, from, to) → Promise<FileStat[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/snapshot.test.js`, and change its import line to `import { takeSnapshot, listSnapshots, restoreSnapshot, fileDiffs, pinSnapshot, treeNow, treeOf, numstat } from '../plugin/hooks/snapshot.ts';`

```js
test('a pinned snapshot lives under its own ref and is never pruned with the turn snapshots', async () => {
  const { run, git, write } = repo();
  write('a.txt', 'two\n');
  const sha = await pinSnapshot(run, 'refs/spark/missions/m-20261010-180509-beef/start', 'mission start');
  assert.equal(git('rev-parse', 'refs/spark/missions/m-20261010-180509-beef/start').trim(), sha);
  for (let i = 0; i < 21; i++) await takeSnapshot(run, `turn ${i}`);
  assert.equal(git('rev-parse', 'refs/spark/missions/m-20261010-180509-beef/start').trim(), sha);
  assert.equal((await listSnapshots(run)).length, 20);
});

test('treeNow matches the tree of a snapshot of the same files, and numstat counts lines per file', async () => {
  const { run, write } = repo();
  const start = await pinSnapshot(run, 'refs/spark/missions/x/start', 'start');
  write('a.txt', 'one\nmore\n');
  write('new.txt', 'fresh\n');
  const tree = await treeNow(run);
  const end = await pinSnapshot(run, 'refs/spark/missions/x/end', 'end');
  assert.equal(await treeOf(run, end), tree);
  assert.deepEqual(
    (await numstat(run, start, end)).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'a.txt', added: 1, removed: 0 },
      { path: 'new.txt', added: 1, removed: 0 },
    ],
  );
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/snapshot.test.js`
Expected: FAIL: `pinSnapshot` is not exported.

- [ ] **Step 3: Implement** (in `plugin/hooks/snapshot.ts`)

Share the commit step between `takeSnapshot` and the new `pinSnapshot`:

```ts
// A commit of the working tree as it is, on top of HEAD when there is one.
async function snapshotCommit(run: Run, label: string) {
  const tree = await writeTree(run, await sparkIndex(run))
  const head = await run(['git', 'rev-parse', '--verify', '-q', 'HEAD'])
  const parent = head.exitCode === 0 ? ['-p', head.stdout.trim()] : []
  return (await git(run, ['commit-tree', tree, ...parent, '-m', label], { env: IDENTITY })).trim()
}

export async function takeSnapshot(run: Run, label: string): Promise<Snapshot> {
  const sha = await snapshotCommit(run, label)
  const existing = await listSnapshots(run)
  await git(run, ['update-ref', `${PREFIX}${(existing[0]?.n ?? 0) + 1}`, sha])
  for (const old of existing.slice(KEEP - 1)) await git(run, ['update-ref', '-d', `${PREFIX}${old.n}`])
  return (await listSnapshots(run))[0]!
}

// A snapshot kept under `ref`, outside the turn snapshots and their pruning: missions pin theirs.
export async function pinSnapshot(run: Run, ref: string, label: string): Promise<string> {
  const sha = await snapshotCommit(run, label)
  await git(run, ['update-ref', ref, sha])
  return sha
}

// The working tree's hash, seen the way snapshots see it. The test gate records it with each run.
export const treeNow = async (run: Run) => writeTree(run, await sparkIndex(run))

export const treeOf = async (run: Run, commit: string) => (await git(run, ['rev-parse', `${commit}^{tree}`])).trim()

// Lines added and removed per file between two snapshots; binary files count as 0.
export async function numstat(run: Run, from: string, to: string) {
  const out = await git(run, ['diff', '--numstat', '--no-renames', from, to])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added = '', removed = '', ...path] = line.split('\t')
      return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }
    })
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/snapshot.test.js` and `claude plugin test plugin`.
Expected: PASS, including the existing snapshot tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/snapshot.ts test/snapshot.test.js
git commit -m "Snapshots: pinned refs, tree hashes and numstat for missions"
```

---

### Task 5: Gate records and `.spark/` protection (plugin)

**Files:**
- Modify: `plugin/hooks/testgate.ts` (return `exit` and `tree`)
- Modify: `plugin/hooks/halt.ts` (`inSparkDir`, `SPARK_DIR_REASON`)
- Modify: `plugin/hooks/gate.ts` (the `SECRETS` list at line 94 and its check at line 299: block commands that name the records)
- Modify: `plugin/hooks/register.tsx` (`recordGate`, the Stop hook, build counting, the `tool.call` denial)
- Test: `plugin/test/missiongate.test.ts`, plus additions to `plugin/test/gate.test.ts` and `plugin/test/halt.test.ts`

**Interfaces:**
- Consumes: `treeNow` (Task 4).
- Produces:
  - `.spark/gate.jsonl` lines `{"at":<ms>,"check":"tests"|"build"|"halt","ok":<bool>,"exit"?:<int>,"tree"?:<sha>}`, read by Task 6's store and Task 10's terminal mission.
  - `GateResult` becomes `{ ok: true; tree: string } | { ok: false; block: string; exit: number; tree: string }`.
  - `inSparkDir(file, top)`.

- [ ] **Step 1: Write the failing tests**

```ts
// plugin/test/missiongate.test.ts
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { isBuild } from '../hooks/halt'
import { fakeRepo, startTurn, stop } from './fake'

function capture(on: any) {
  const written = new Map<string, string>()
  on('fs.write', (_$: unknown, e: any) => {
    written.set(String(e.path).replace(/\//g, '\\'), e.text)
    return { value: undefined }
  })
  const gate = () => (written.get('C:\\app\\.spark\\gate.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { written, gate }
}

function tools(on: any) {
  on('tool.call', (_$: unknown, e: any) =>
    e.tool === 'Bash' && isBuild(e.command) ? { isError: true, result: 'Exit code 2', text: 'Exit code 2' } : { result: { stdout: '', stderr: '', interrupted: false } },
  )
}

test('each test-gate run goes to .spark/gate.jsonl with the tree it saw, and a halt adds its own line', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate, written } = capture(on)
  await startTurn($)
  await stop($)
  await stop($)
  // fakeRepo's fs.read refuses everything but package.json, so each write starts the file over:
  // the last write holds the halt alone, and the second run's line came just before it.
  expect(gate().map((l) => [l.check, l.ok, l.tree])).toEqual([['halt', false, 'tree1']])
  expect(written.get('C:\\app\\.git\\info\\exclude')).toBe('.spark/\n')
})

test('a failing test run is written with its exit code', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate } = capture(on)
  await startTurn($)
  await stop($)
  expect(gate()).toEqual([{ at: expect.any(Number), check: 'tests', ok: false, exit: 1, tree: 'tree1' }])
})

test('a counted build is written too', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate } = capture(on)
  await startTurn($)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as any)
  expect(gate().map((l) => [l.check, l.ok])).toEqual([['build', false]])
})

test('Claude never edits .spark/', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  await startTurn($)
  const denied: any = await $.tool.call({ tool: 'Write', file_path: 'C:\\app\\.spark\\gate.jsonl', content: '{}' } as any)
  expect(denied.deny).toBe("✦ .spark/ holds Spark's own records; it isn't edited")
  const sneaky: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/../.spark/missions/x/mission.json', old_string: 'a', new_string: 'b' } as any)
  expect(sneaky.deny).toBeDefined()
})
```

If `expect.any` isn't supported by `claude-code/testing`, assert the fields one by one instead. If the harness's `fs.read` serves what the test's `fs.write` stored, the first test sees every line (`tests`, `tests`, `halt`). Read the code path and assert what really happens; don't bend the assertion just to get a pass.

Add to `plugin/test/gate.test.ts` (it already imports `classify`):

```ts
test('commands that name Spark mission records are blocked', () => {
  const ctx = { repo: 'C:/app', home: 'C:/Users/me' }
  for (const [c, shell] of [['echo {} >> .spark/gate.jsonl', 'bash'], ['Remove-Item .spark\\missions -Recurse', 'powershell'], ['cat ".spark/gate.jsonl"', 'bash']] as const) {
    const v = classify(c, shell, ctx)
    expect(v?.kind).toBe('deny')
    expect(v?.reason).toContain('mission records')
  }
  expect(classify('cat .spark/out/toolu_1.txt', 'bash', ctx)?.kind).not.toBe('deny')
})
```

Add to `plugin/test/halt.test.ts` (and add `inSparkDir` to its `../hooks/halt` import):

```ts
test('.spark/ paths are recognised however they are written', () => {
  expect(inSparkDir('C:\\app\\.spark\\gate.jsonl', 'C:/app')).toBe(true)
  expect(inSparkDir('.spark/missions/m/mission.json', 'C:/app')).toBe(true)
  expect(inSparkDir('C:/app/src/../.spark/x', 'C:/app')).toBe(true)
  expect(inSparkDir('C:/app/src/spark.js', 'C:/app')).toBe(false)
  expect(inSparkDir('C:/app/.sparkle/x', 'C:/app')).toBe(false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugin`
Expected: FAIL: no `gate.jsonl` writes, `inSparkDir` missing, no deny.

- [ ] **Step 3: Implement**

`plugin/hooks/testgate.ts`: import `treeNow` and return what the run saw.

```ts
import { changedSince, treeNow } from './snapshot.ts'
// …
export type GateResult = { ok: true; tree: string } | { ok: false; block: string; exit: number; tree: string }
// … at the end of testGate, replacing its last three lines:
  if (!argv) return undefined
  // The tree the tests run on, so a mission's report can tell whether the final code is what passed.
  const tree = await treeNow(io.run)
  const r = await io.run(argv, { cwd: top, timeoutMs: TIMEOUT_MS })
  if (r.exitCode === 0) return { ok: true, tree }
  return { ok: false, exit: r.exitCode, tree, block: `✦ tests failed (exit ${r.exitCode})\n${trimOutput(`${r.stdout}\n${r.stderr}`, TAIL_LINES)}` }
```

`plugin/hooks/halt.ts`: replace `editAllowedWhileHalted` with a shared path check (keep `resolved`).

```ts
// Whether `file` is under `dir` at the repo top, with `..` and `.` folded away so a path can't climb out.
const under = (file: string, top: string, dir: string) =>
  resolved(/^([a-z]:)?[\\/]/i.test(file) ? file : `${top}/${file}`).startsWith(`${resolved(top)}/${dir}/`)

export const editAllowedWhileHalted = (file: string, top: string) => under(file, top, 'docs/postmortems')

export const SPARK_DIR_REASON = "✦ .spark/ holds Spark's own records; it isn't edited"
// Spark's saved outputs and mission records: a forged test result there would be reported as real.
export const inSparkDir = (file: string, top: string) => under(file, top, '.spark')
```

`plugin/hooks/gate.ts`: next to `SECRETS`:

```ts
// Spark's mission records: a forged line there would be reported as a real test result.
const RECORDS = /\.spark[\\/]+["']?(gate\.jsonl|missions)\b/i
```

and right after the `SECRETS` check in `classify`:

```ts
  if (RECORDS.test(command)) return { kind: 'deny', reason: `${BLOCKED}it touches Spark's mission records` }
```

`plugin/hooks/register.tsx`:

1. Imports: add `inSparkDir, SPARK_DIR_REASON` to the `./halt` import, `treeNow` to the `./snapshot` import, and `import type { GateCheck } from './mission'`.
2. After `ignoreSparkDir`:

```ts
const GATE_LOG = '.spark/gate.jsonl'

// F4 and F10 outcomes, one line each in .spark/gate.jsonl at the repo top, for mission reports.
// `tree` is what the check ran on, so a report can tell whether the final code is what passed.
async function recordGate($: EngineInterface, check: GateCheck, ok: boolean, more: { exit?: number; tree?: string } = {}) {
  if (!inRepo) return
  const path = `${await repoTop($)}/${GATE_LOG}`
  const tree = more.tree ?? (await treeNow(runner($)).catch(() => undefined))
  const line = JSON.stringify({ at: await $.clock.now(), check, ok, ...(more.exit === undefined ? {} : { exit: more.exit }), ...(tree ? { tree } : {}) })
  const before = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, `${before}${line}\n`)
  await ignoreSparkDir($)
}
```

3. In `countOutcome`, record the halt it sets:

```ts
  await $.state.set(HALT, { at: await $.clock.now() })
  await recordGate($, 'halt', false).catch(() => {})
  $.ui.toast(HALT_REASON)
  return true
```

4. In the Stop hook, record the run before it is counted:

```ts
      const gate = await testGate(gateIo($), { base: turn.base, answer: e.last_assistant_message ?? '' }, await sparkConfig($), { untrusted })
      if (gate) await recordGate($, 'tests', gate.ok, gate.ok ? { tree: gate.tree } : { exit: gate.exit, tree: gate.tree }).catch(() => {})
      if (gate && !(await countOutcome($, gate.ok)) && !gate.ok) return { ...done, block: gate.block }
```

5. In `tool.call`, as the first check after `const file = …`:

```ts
    if (EDIT_TOOLS.has(e.tool) && typeof file === 'string' && inSparkDir(file, await repoTop($))) return { deny: SPARK_DIR_REASON }
```

and the build branch becomes:

```ts
    if (shell && !e.agentId && typeof input.command === 'string' && isBuild(input.command) && !result.deny) {
      await recordGate($, 'build', !result.isError).catch(() => {})
      if (await countOutcome($, !result.isError)) out = { ...result, context: [...(result.context ?? []), HALT_REASON] } as typeof result
    }
```

- [ ] **Step 4: Run all checks**

Run: `claude plugin test plugin`, `npm run test:launcher`, `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/testgate.ts plugin/hooks/halt.ts plugin/hooks/gate.ts plugin/hooks/register.tsx plugin/test/missiongate.test.ts plugin/test/gate.test.ts plugin/test/halt.test.ts
git commit -m "Gate outcomes go to .spark/gate.jsonl; .spark/ can't be edited by Claude"
```

---

### Task 6: Mission store (`app/lib/mission-store.js`)

**Files:**
- Create: `app/lib/mission-store.js`
- Test: `app/test/mission-store.test.js`

**Interfaces:**
- Consumes: `asMission`, `asRecord`, `isMissionId`, `parseGateLines` (Task 2), through `../staged/plugin/hooks/mission.ts`.
- Produces:
  - `createStore(root)`, returning:
    - `save(m)`, `append(id, record)`, `saveReport(id, report)`
    - `list() → (Mission | { id, unreadable: true })[]`
    - `read(id) → { mission, records, report } | undefined`
    - `gateSize() → number`, `gateSince(offset) → { records, offset }`
  - `excludeSpark(excludeFile)`.

- [ ] **Step 1: Write the failing tests**

```js
// app/test/mission-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, excludeSpark } from '../lib/mission-store.js';
import { newMission } from '../staged/plugin/hooks/mission.ts';

const folder = () => mkdtempSync(join(tmpdir(), 'spark-store-'));
const made = (at = new Date(2026, 9, 10, 12).getTime(), hex = 'beef') => newMission('rate-limit login', at, hex, 0);

test('a mission and its records round-trip, and no temp file is left behind', () => {
  const root = folder();
  const store = createStore(root);
  const { mission, record } = made();
  store.save(mission);
  store.append(mission.id, record);
  store.append(mission.id, { at: 5, kind: 'you', text: 'per account, please' });
  const back = store.read(mission.id);
  assert.deepEqual(back.mission, mission);
  assert.deepEqual(back.records, [record, { at: 5, kind: 'you', text: 'per account, please' }]);
  assert.deepEqual(readdirSync(join(root, '.spark', 'missions', mission.id)).sort(), ['events.jsonl', 'mission.json']);
});

test('list is newest first, and broken or mismatched folders are listed as unreadable', () => {
  const root = folder();
  const store = createStore(root);
  const older = made(new Date(2026, 9, 9, 12).getTime(), 'aaaa').mission;
  const newer = made(new Date(2026, 9, 10, 12).getTime(), 'bbbb').mission;
  store.save(older);
  store.save(newer);
  const broken = 'm-20261008-120000-cccc';
  mkdirSync(join(root, '.spark', 'missions', broken), { recursive: true });
  writeFileSync(join(root, '.spark', 'missions', broken, 'mission.json'), '{ nope');
  const moved = 'm-20261007-120000-dddd';
  mkdirSync(join(root, '.spark', 'missions', moved), { recursive: true });
  writeFileSync(join(root, '.spark', 'missions', moved, 'mission.json'), JSON.stringify(newer));
  mkdirSync(join(root, '.spark', 'missions', 'not-a-mission'), { recursive: true });
  assert.deepEqual(
    store.list().map((m) => [m.id, Boolean(m.unreadable)]),
    [
      [newer.id, false],
      [older.id, false],
      [broken, true],
      [moved, true],
    ],
  );
});

test('ids that are not mission ids never reach the disk', () => {
  const store = createStore(folder());
  assert.equal(store.read('..\\..\\x'), undefined);
  assert.throws(() => store.append('../x', { at: 1, kind: 'you', text: 'x' }), /not a mission id/);
});

test('a shipped mission.json is cleaned: a hostile sha or session id is dropped', () => {
  const root = folder();
  const { mission } = made();
  mkdirSync(join(root, '.spark', 'missions', mission.id), { recursive: true });
  writeFileSync(
    join(root, '.spark', 'missions', mission.id, 'mission.json'),
    JSON.stringify({ ...mission, title: '<img src=x onerror=alert(1)>', startSha: '--output=C:/x', sessionId: 'x; rm -rf /' }),
  );
  const back = createStore(root).read(mission.id).mission;
  assert.equal(back.title, '<img src=x onerror=alert(1)>');
  assert.equal(back.startSha, undefined);
  assert.equal(back.sessionId, undefined);
});

test('gateSince reads only whole lines after the offset, and starts over if the file shrank', () => {
  const root = folder();
  const store = createStore(root);
  assert.equal(store.gateSize(), 0);
  mkdirSync(join(root, '.spark'), { recursive: true });
  const file = join(root, '.spark', 'gate.jsonl');
  writeFileSync(file, `${JSON.stringify({ at: 1, check: 'tests', ok: true })}\n`);
  const offset = store.gateSize();
  appendFileSync(file, `${JSON.stringify({ at: 2, check: 'tests', ok: false, exit: 1 })}\n{"at":3,"check":"te`);
  const first = store.gateSince(offset);
  assert.deepEqual(first.records, [{ at: 2, kind: 'gate', check: 'tests', ok: false, exit: 1 }]);
  appendFileSync(file, 'sts","ok":true}\n');
  assert.deepEqual(store.gateSince(first.offset).records, [{ at: 3, kind: 'gate', check: 'tests', ok: true }]);
  writeFileSync(file, `${JSON.stringify({ at: 9, check: 'halt', ok: false })}\n`);
  assert.deepEqual(store.gateSince(first.offset + 500).records, [{ at: 9, kind: 'gate', check: 'halt', ok: false }]);
});

test('excludeSpark adds .spark/ once', () => {
  const file = join(folder(), 'info', 'exclude');
  excludeSpark(file);
  excludeSpark(file);
  assert.equal(readFileSync(file, 'utf8'), '.spark/\n');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd app; npm test`
Expected: FAIL: cannot find `../lib/mission-store.js`.

- [ ] **Step 3: Write `app/lib/mission-store.js`**

```js
// Missions on disk, under the folder's .spark/: missions/<id>/{mission.json,events.jsonl,report.json}
// and the plugin's gate.jsonl. A repo can ship its own .spark/, so whatever is read back is
// checked before it is used.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asMission, asRecord, isMissionId, parseGateLines } from '../staged/plugin/hooks/mission.ts';

const json = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

const records = (path) =>
  (existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []).flatMap((line) => {
    try {
      const r = asRecord(JSON.parse(line));
      return r ? [r] : [];
    } catch {
      return [];
    }
  });

export function createStore(root) {
  const missions = join(root, '.spark', 'missions');
  const gateFile = join(root, '.spark', 'gate.jsonl');
  const dir = (id) => {
    if (!isMissionId(id)) throw new Error(`not a mission id: ${id}`);
    return join(missions, id);
  };
  // A crash mid-write leaves the old file, never half of the new one.
  const replace = (path, text) => {
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  };
  const load = (id) => {
    const mission = asMission(json(join(missions, id, 'mission.json')));
    return mission?.id === id ? mission : undefined;
  };

  return {
    save(mission) {
      mkdirSync(dir(mission.id), { recursive: true });
      replace(join(dir(mission.id), 'mission.json'), `${JSON.stringify(mission, null, 2)}\n`);
    },
    append(id, record) {
      mkdirSync(dir(id), { recursive: true });
      appendFileSync(join(dir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`);
    },
    saveReport(id, report) {
      replace(join(dir(id), 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    },
    // Newest first, since ids start with the date. A folder whose mission.json doesn't check out
    // is listed as unreadable rather than hidden.
    list() {
      const ids = existsSync(missions) ? readdirSync(missions).filter(isMissionId) : [];
      return ids.sort((a, b) => b.localeCompare(a)).map((id) => load(id) ?? { id, unreadable: true });
    },
    read(id) {
      if (!isMissionId(id)) return undefined;
      const mission = load(id);
      if (!mission) return undefined;
      const report = json(join(missions, id, 'report.json'));
      return { mission, records: records(join(missions, id, 'events.jsonl')), report: report && typeof report === 'object' ? report : undefined };
    },
    gateSize: () => (existsSync(gateFile) ? statSync(gateFile).size : 0),
    // Lines the plugin added since `offset`. A half-written last line waits for the next look; a
    // file that shrank was started over, so it is read from the top.
    gateSince(offset) {
      if (!existsSync(gateFile)) return { records: [], offset };
      const size = statSync(gateFile).size;
      const from = size < offset ? 0 : offset;
      if (size === from) return { records: [], offset: from };
      const buffer = Buffer.alloc(size - from);
      const fd = openSync(gateFile, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, from);
      } finally {
        closeSync(fd);
      }
      const text = buffer.toString('utf8');
      const whole = text.slice(0, text.lastIndexOf('\n') + 1);
      return { records: parseGateLines(whole), offset: from + Buffer.byteLength(whole) };
    },
  };
}

// .spark/ stays out of git, as the plugin does for .spark/out.
export function excludeSpark(excludeFile) {
  const now = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (now.split(/\r?\n/).includes('.spark/')) return;
  mkdirSync(dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, `${now}${now && !now.endsWith('\n') ? '\n' : ''}.spark/\n`);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app; npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/mission-store.js app/test/mission-store.test.js
git commit -m "Missions: the .spark/missions store, checked on the way back in"
```

---

### Task 7: Mission runner (`app/lib/mission-runner.js`)

**Files:**
- Modify: `app/lib/stream.js` (add `setPermissionMode`)
- Create: `app/lib/mission-runner.js`
- Test: `app/test/mission-runner.test.js`, plus one test in `app/test/core.test.js`

**Interfaces:**
- Consumes: Task 2 (`mission.ts`), Task 3 (`mission-report.ts`), Task 4 (`pinSnapshot`, plus `treeNow` in the tests), Task 6 (`createStore`).
- Produces:
  - `setPermissionMode(id, mode) → string`
  - `createMissionRunner({ store, write, notify, run, now, hex4 })`, returning:
    - `busy()`, `idle() → Promise`, `list()`, `recover()`
    - `start(objective, { sessionId }) → { mission } | { error }`
    - `onEvent(event)`, `draftDenial(tool, input) → string | undefined`, `permission(tool, input, decision, gate?)`, `you(text)`
    - `approve(id, criteria) → Promise<{ mission } | { error }>`
    - `stopped()`, `interrupted(reason, { detach })`, `exited(code, error)`
    - `cancel(id) → { mission, stop } | { error }`, `resume(id, restart) → { mission } | { error }`
    - `view(id) → { mission, rows, totals, sections?, active } | undefined`
  - Window messages (`notify`): `{ kind: 'state', mission, active }`, `{ kind: 'row', id, row }`, `{ kind: 'review', mission }`, `{ kind: 'report', id, mission, sections }`, `{ kind: 'error', id, error }`.

- [ ] **Step 1: Write the failing tests**

In `app/test/core.test.js`, add `setPermissionMode` to the `stream.js` import and add:

```js
test('setPermissionMode is a control request Claude Code answers by id', () => {
  assert.deepEqual(JSON.parse(setPermissionMode('mission-plan', 'plan')), { type: 'control_request', request_id: 'mission-plan', request: { subtype: 'set_permission_mode', mode: 'plan' } });
});
```

```js
// app/test/mission-runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/mission-store.js';
import { createMissionRunner } from '../lib/mission-runner.js';
import { treeNow } from '../staged/plugin/hooks/snapshot.ts';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DRAFT = 'I read src/auth.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"A sixth failed login gets 429","how":"npm test"}]}\n```';
const result = (text, over = {}) => ({ kind: 'result', ok: true, text, costUsd: 0.1, durationMs: 2000, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 300 }, ...over });

// A runner with Claude Code and the window replaced by arrays, on a real store in a temp folder.
function rig({ run, root = mkdtempSync(join(tmpdir(), 'spark-runner-')) } = {}) {
  let clock = new Date(2026, 9, 10, 18, 0, 0).getTime();
  const lines = [];
  const told = [];
  const store = createStore(root);
  const r = createMissionRunner({ store, write: (l) => lines.push(JSON.parse(l)), notify: (m) => told.push(m), run, now: () => (clock += 1000), hex4: () => 'beef' });
  const texts = () => lines.filter((l) => l.type === 'user').map((l) => l.message.content[0].text);
  const modes = () => lines.filter((l) => l.type === 'control_request').map((l) => l.request.mode);
  return { r, store, root, lines, told, texts, modes };
}

function drafted(over) {
  const t = rig(over);
  t.r.onEvent({ kind: 'init', sessionId: SESSION, model: 'claude-opus-5-5', skills: [] });
  const { mission } = t.r.start('rate-limit the login route', { sessionId: SESSION });
  t.r.onEvent(result(DRAFT));
  return { ...t, id: mission.id };
}

async function approved(over) {
  const t = drafted(over);
  const out = await t.r.approve(t.id, [
    { text: 'A sixth failed login gets 429', how: 'npm test' },
    { text: 'Locked users see when to retry', how: 'manual' },
  ]);
  return { ...t, mission: out.mission };
}

test('start switches to plan mode and asks for the draft; the draft turn moves to review and puts the mode back', () => {
  const t = drafted();
  assert.deepEqual(t.modes(), ['plan', 'default']);
  assert.match(t.texts()[0], /^Mission: rate-limit the login route/);
  const m = t.store.read(t.id).mission;
  assert.equal(m.status, 'review');
  assert.equal(m.title, 'Rate-limit login');
  assert.equal(m.sessionId, SESSION);
  assert.deepEqual(t.told.filter((x) => x.kind === 'review').map((x) => x.mission.criteria.length), [1]);
  assert.equal(t.r.busy(), false);
});

test('while drafting, writes and shell commands are refused and recorded; after approval they go through', async () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  assert.match(t.r.draftDenial('Edit', { file_path: 'C:/app/src/auth.js' }), /being drafted/);
  assert.equal(t.r.draftDenial('Read', { file_path: 'C:/app/src/auth.js' }), undefined);
  t.r.onEvent(result(DRAFT));
  await t.r.approve(mission.id, [{ text: 'A sixth failed login gets 429', how: 'npm test' }]);
  assert.equal(t.r.draftDenial('Edit', { file_path: 'C:/app/src/auth.js' }), undefined);
  assert.deepEqual(
    t.store.read(mission.id).records.filter((x) => x.kind === 'permission').map((x) => [x.tool, x.decision]),
    [['Edit', 'auto-denied']],
  );
});

test('approve sends the criteria and marks edited rows as yours; a finished turn writes a report', async () => {
  const t = await approved();
  assert.match(t.texts().at(-1), /1\. A sixth failed login gets 429 \(check: npm test\)\n2\. Locked users see when to retry \(check: manual\)/);
  assert.deepEqual(t.mission.criteria.map((c) => c.by), ['claude', 'you']);
  t.r.onEvent({ kind: 'tool', id: 't1', name: 'Edit', input: { file_path: 'C:/app/src/auth.js' } });
  t.r.onEvent({ kind: 'tool-result', id: 't1', output: 'ok', isError: false });
  t.r.onEvent(result('Changed auth.js.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.mission.status, 'finished');
  assert.equal(back.report.status, 'Finished · tests not run on the final code');
  assert.deepEqual(back.report.files, [{ path: 'C:/app/src/auth.js' }]);
  assert.equal(t.told.filter((x) => x.kind === 'report').length, 1);
  assert.equal(t.r.start('another one').mission.status, 'draft');
});

test('a question waits for you, and your answer puts it back to running', async () => {
  const t = await approved();
  t.r.onEvent(result('Per IP or per account?'));
  assert.equal(t.store.read(t.id).mission.status, 'waiting');
  t.r.you('per account');
  assert.equal(t.store.read(t.id).mission.status, 'running');
  assert.deepEqual(t.store.read(t.id).records.filter((x) => x.kind === 'you').map((x) => x.text), ['per account']);
});

test('a chat turn during review leaves the mission in review', () => {
  const t = drafted();
  t.r.you('what does 429 mean?');
  t.r.onEvent(result('Too Many Requests.'));
  assert.equal(t.store.read(t.id).mission.status, 'review');
});

test('stop pauses; resume restarts on the mission session and sends the resume text', async () => {
  const t = await approved();
  t.r.stopped();
  assert.equal(t.store.read(t.id).mission.status, 'paused');
  const restarts = [];
  const out = t.r.resume(t.id, (sessionId) => restarts.push(sessionId));
  assert.equal(out.mission.status, 'running');
  assert.deepEqual(restarts, [SESSION]);
  assert.match(t.texts().at(-1), /^Resuming mission: Rate-limit login/);
});

test('an exit interrupts; a resume that died starts fresh next time', async () => {
  const t = await approved();
  t.r.exited(1, 'boom');
  assert.equal(t.store.read(t.id).mission.status, 'interrupted');
  const restarts = [];
  t.r.resume(t.id, (s) => restarts.push(s));
  t.r.exited(1, 'No conversation found with session ID');
  t.r.resume(t.id, (s) => restarts.push(s));
  assert.deepEqual(restarts, [SESSION, undefined]);
});

test('an interrupted draft drafts again on resume', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  t.r.exited(1);
  t.r.resume(mission.id, () => {});
  assert.equal(t.store.read(mission.id).mission.status, 'draft');
  assert.deepEqual(t.modes(), ['plan', 'plan']);
});

test('opening the folder again marks missions that were live as interrupted', async () => {
  const t = await approved();
  const again = createMissionRunner({ store: createStore(t.root), write: () => {}, notify: () => {}, now: () => Date.now(), hex4: () => 'cafe' });
  again.recover();
  assert.equal(t.store.read(t.id).mission.status, 'interrupted');
  assert.equal(t.store.read(t.id).mission.reason, 'Spark closed while it ran');
});

test('a halt after approval blocks, and gate lines from before the mission are ignored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runner-'));
  mkdirSync(join(root, '.spark'));
  writeFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: 1, check: 'halt', ok: false })}\n`);
  const t = await approved({ root });
  appendFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: Date.now() + 10 ** 9, check: 'halt', ok: false })}\n`);
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.mission.status, 'blocked');
  assert.equal(back.records.filter((x) => x.kind === 'gate').length, 1);
});

test('a refused plan mode is recorded and the bridge still denies', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  t.r.onEvent({ kind: 'control', id: 'mission-plan', ok: false, error: 'unknown subtype' });
  assert.ok(t.r.draftDenial('Bash', { command: 'npm i' }));
  assert.ok(t.store.read(mission.id).records.some((x) => x.kind === 'process' && x.event === 'plan-mode-refused'));
});

test('cancel ends a live mission and asks main to stop the turn; a final mission cannot be cancelled', () => {
  const t = rig();
  const { mission } = t.r.start('rate-limit the login route');
  const out = t.r.cancel(mission.id);
  assert.equal(out.stop, true);
  assert.equal(out.mission.status, 'cancelled');
  assert.match(t.r.cancel(mission.id).error, /already over/);
  assert.equal(t.r.busy(), false);
});

test('in a git repo: start and end are pinned, files come from numstat, tests passed on this code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-runner-git-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  writeFileSync(join(root, '.gitignore'), '.spark/\n');
  writeFileSync(join(root, 'auth.js'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? root, env: { ...process.env, ...init.env }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const t = await approved({ run, root });
  assert.match(t.mission.startSha, /^[0-9a-f]{40}$/);
  writeFileSync(join(root, 'auth.js'), 'one\ntwo\n');
  mkdirSync(join(root, '.spark'), { recursive: true });
  appendFileSync(join(root, '.spark', 'gate.jsonl'), `${JSON.stringify({ at: Date.now(), check: 'tests', ok: true, tree: await treeNow(run) })}\n`);
  t.r.onEvent(result('Done.'));
  await t.r.idle();
  const back = t.store.read(t.id);
  assert.equal(back.report.status, 'Finished · tests passed on this code');
  assert.deepEqual(back.report.files, [{ path: 'auth.js', added: 1, removed: 0 }]);
  assert.equal(git('rev-parse', `refs/spark/missions/${t.id}/end`).stdout.trim(), back.mission.endSha);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd app; npm test`
Expected: FAIL: `setPermissionMode` isn't exported, and `mission-runner.js` is missing.

- [ ] **Step 3: Implement**

`app/lib/stream.js`, after `setModel`:

```js
// Switches the running session's permission mode: missions draft in 'plan' and go back to 'default'.
export const setPermissionMode = (id, mode) => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode } });
```

`app/lib/mission-runner.js`:

```js
// Runs missions against the live Claude Code process, as marathon-runner.js runs marathons:
// mission.ts decides, the store keeps the records, and the process, git and clock come in from
// main.js, so none of this needs Electron to be tested.
import { setPermissionMode, userMessage } from './stream.js';
import {
  DRAFT_DENIAL,
  DRAFT_DENIED,
  FINAL,
  LIVE,
  approvedCriteria,
  draftText,
  isSessionId,
  move,
  newMission,
  permissionRecord,
  recordsFor,
  resumeFailed,
  resumeText,
  runText,
  turnEnded,
  youRecord,
} from '../staged/plugin/hooks/mission.ts';
import { buildReport, describe, gitFacts, reportSections, totals } from '../staged/plugin/hooks/mission-report.ts';
import { pinSnapshot } from '../staged/plugin/hooks/snapshot.ts';

// The id of the plan-mode request, so its refusal can be told apart from other control answers.
const PLAN = 'mission-plan';

// `store`: lib/mission-store.js for the folder. `write`: one line for Claude Code's stdin.
// `notify`: one message for the window. `run`: git in the repo (snapshot.ts's Run), or undefined
// outside one. `now`: the clock in ms. `hex4`: four random hex digits for ids.
export function createMissionRunner({ store, write, notify, run, now, hex4 }) {
  // The mission this window runs, until it ends or the window moves on.
  let active = null;
  // Reports wait on git; they run one after another so records stay in order.
  let queue = Promise.resolve();

  function record(mission, records) {
    for (const r of records) {
      store.append(mission.id, r);
      const row = describe(r);
      if (row) notify({ kind: 'row', id: mission.id, row });
    }
  }

  function commit(mission, records = []) {
    store.save(mission);
    record(mission, records);
    if (active?.id === mission.id) active = FINAL.has(mission.status) ? null : mission;
    notify({ kind: 'state', mission, active: active?.id === mission.id });
    return mission;
  }

  function step(mission, to, reason, more = {}) {
    const moved = move(mission, to, reason, now());
    return commit({ ...moved.mission, ...more }, [moved.record]);
  }

  async function report(mission) {
    const { mission: ended, facts } = await gitFacts(run, mission, now());
    store.save(ended);
    const built = buildReport(ended, store.read(ended.id).records, facts);
    store.saveReport(ended.id, built);
    notify({ kind: 'report', id: ended.id, mission: ended, sections: reportSections(built) });
  }

  function later(mission) {
    queue = queue.then(() => report(mission)).catch((err) => notify({ kind: 'error', id: mission.id, error: err.message }));
  }

  function draft(objective) {
    write(setPermissionMode(PLAN, 'plan'));
    write(userMessage({ text: draftText(objective) }));
  }

  function turnEnd(event) {
    const m = active;
    if (m.status !== 'draft' && m.status !== 'running') return;
    const gates = store.gateSince(m.gateOffset);
    const done = turnEnded(m, store.read(m.id).records, { ok: event.ok, text: event.text }, gates.records, gates.offset, now());
    commit(done.mission, done.records);
    if (m.status === 'draft') {
      write(setPermissionMode('mission-default', 'default'));
      notify({ kind: 'review', mission: done.mission });
    }
    if (FINAL.has(done.mission.status)) later(done.mission);
  }

  function interrupted(reason, { detach = false } = {}) {
    if (active && LIVE.has(active.status)) step(active, 'interrupted', reason);
    if (detach) active = null;
  }

  return {
    busy: () => Boolean(active && LIVE.has(active.status)),
    idle: () => queue,

    start(objective, { sessionId } = {}) {
      if (active) return { error: `mission "${active.title}" is ${active.status}: cancel it first` };
      if (!objective.trim()) return { error: 'a mission needs an objective: /mission <what should be true when it is done>' };
      const { mission, record: first } = newMission(objective, now(), hex4(), store.gateSize());
      active = { ...mission, ...(isSessionId(sessionId) ? { sessionId } : {}) };
      commit(active, [first]);
      draft(objective);
      return { mission: active };
    },

    onEvent(event) {
      if (!active) return;
      if (event.kind === 'init' && (event.sessionId !== active.sessionId || event.model !== active.model))
        commit({ ...active, ...(isSessionId(event.sessionId) ? { sessionId: event.sessionId } : {}), ...(event.model ? { model: event.model } : {}) });
      if (event.kind === 'control' && event.id === PLAN && !event.ok)
        record(active, [{ at: now(), kind: 'process', event: 'plan-mode-refused', error: String(event.error ?? '') }]);
      record(active, recordsFor(event, now()));
      if (event.kind === 'result') turnEnd(event);
    },

    // The bridge asks before a tool runs: a draft only reads, whatever "always allow" says.
    draftDenial(tool, input) {
      if (active?.status !== 'draft' || !DRAFT_DENIED.has(tool)) return undefined;
      record(active, [permissionRecord(tool, input, 'auto-denied', now())]);
      return DRAFT_DENIAL;
    },

    permission(tool, input, decision, gate) {
      if (active) record(active, [permissionRecord(tool, input, decision, now(), gate)]);
    },

    you(text) {
      if (!active) return;
      record(active, [youRecord(text, now())]);
      if (active.status === 'waiting' || active.status === 'paused') step(active, 'running', 'you wrote to Claude');
    },

    async approve(id, sent) {
      if (active?.id !== id || active.status !== 'review') return { error: 'that mission is not waiting for approval' };
      const criteria = approvedCriteria(active.criteria, sent);
      if (!criteria.length) return { error: 'a mission needs at least one criterion' };
      const startSha = run ? await pinSnapshot(run, `refs/spark/missions/${id}/start`, `mission ${id} start`).catch(() => undefined) : undefined;
      if (active?.id !== id || active.status !== 'review') return { error: 'the mission changed while its snapshot was taken' };
      const m = step({ ...active, criteria }, 'running', `you approved ${criteria.length} criteria`, { approvedAt: now(), ...(startSha ? { startSha } : {}) });
      write(userMessage({ text: runText(m) }));
      return { mission: m };
    },

    // ■: the turn is stopped, and the mission waits for Resume or for you to write.
    stopped() {
      if (active?.status === 'running' || active?.status === 'waiting') step(active, 'paused', 'you pressed stop');
      else if (active?.status === 'draft') step(active, 'interrupted', 'you pressed stop while it drafted');
    },

    interrupted,

    exited(code, error) {
      if (!active) return;
      record(active, [{ at: now(), kind: 'process', event: 'exited', ...(typeof code === 'number' ? { code } : {}), ...(error ? { error: String(error).slice(-500) } : {}) }]);
      interrupted('Claude Code stopped');
    },

    cancel(id) {
      const m = active?.id === id ? active : store.read(id)?.mission;
      if (!m || FINAL.has(m.status)) return { error: 'that mission is already over' };
      const stop = active?.id === id && LIVE.has(m.status);
      const ended = step(m, 'cancelled', 'you cancelled it');
      later(ended);
      return { mission: ended, stop };
    },

    // `restart(sessionId)` starts Claude Code on that session, or a fresh one when it is undefined.
    resume(id, restart) {
      if (active && active.id !== id) return { error: `mission "${active.title}" is ${active.status}: finish or cancel it first` };
      const found = store.read(id);
      const m = active?.id === id ? active : found?.mission;
      if (!m || (m.status !== 'paused' && m.status !== 'interrupted')) return { error: 'only a paused or interrupted mission resumes' };
      const fresh = !isSessionId(m.sessionId) || resumeFailed(found?.records ?? []);
      active = m;
      restart(fresh ? undefined : m.sessionId);
      record(m, [{ at: now(), kind: 'process', event: fresh ? 'started' : 'resumed' }]);
      if (m.approvedAt === undefined) {
        const next = step(m, 'draft', 'drafting again');
        draft(next.objective);
        return { mission: next };
      }
      const next = step(m, 'running', fresh ? 'resumed in a fresh session' : 'resumed');
      write(userMessage({ text: resumeText(next) }));
      return { mission: next };
    },

    // On opening a folder nothing runs yet, so a mission still marked live was cut off.
    recover() {
      for (const m of store.list()) if (!m.unreadable && LIVE.has(m.status)) step(m, 'interrupted', 'Spark closed while it ran');
    },

    list: () => store.list(),

    view(id) {
      const found = store.read(id);
      if (!found) return undefined;
      return {
        mission: found.mission,
        rows: found.records.map(describe).filter(Boolean),
        totals: totals(found.records),
        sections: found.report ? reportSections(found.report) : undefined,
        active: active?.id === id,
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app; npm test`, then the root `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stream.js app/lib/mission-runner.js app/test/mission-runner.test.js app/test/core.test.js
git commit -m "Missions: the runner on the live Claude Code stream"
```

---

### Task 8: Wire missions into the app (main, preload, commands)

**Files:**
- Modify: `app/lib/commands.js` (`/mission`)
- Modify: `app/main.js` (a store and runner per folder, the bridge, events, IPC)
- Modify: `app/preload.cjs`
- Modify: `app/renderer.js` (the permission answer no longer names the tool)
- Test: `app/test/core.test.js` (command parsing)

**Interfaces:**
- Consumes: Task 6 (`createStore`, `excludeSpark`) and Task 7 (the runner).
- Produces:
  - Renderer API: `spark.mission(request) → Promise<{ mission } | { error }>`, where `request` is one of:
    - `{ action: 'start', objective }`
    - `{ action: 'approve', id, criteria }`
    - `{ action: 'cancel', id }`
    - `{ action: 'resume', id }`
  - `spark.missions() → Promise<list>`, `spark.missionView(id) → Promise<view | undefined>`, and channel `'mission'` carrying the Task 7 messages.
  - `parseCommand('/mission …') → { kind: 'mission', args }`.

- [ ] **Step 1: Write the failing test** (in `app/test/core.test.js`)

```js
test('/mission becomes a mission command with its arguments', () => {
  assert.deepEqual(parseCommand('/mission rate-limit the login route'), { kind: 'mission', args: 'rate-limit the login route' });
  assert.deepEqual(parseCommand('/mission'), { kind: 'mission', args: '' });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd app; npm test`
Expected: FAIL: it returns `{ kind: 'passthrough' }`.

- [ ] **Step 3: Implement**

`app/lib/commands.js`: after the marathon line, add `if (name === 'mission') return { kind: 'mission', args: arg.trim() };` and name `/mission` in the header comment.

`app/preload.cjs`, add:

```js
  mission: (request) => ipcRenderer.invoke('mission', request),
  missions: () => ipcRenderer.invoke('missions'),
  missionView: (id) => ipcRenderer.invoke('mission-view', id),
```

`app/renderer.js`: in the permission card, `spark.answerPermission({ id, tool, allow, always })` becomes `spark.answerPermission({ id, allow, always })`.

`app/main.js`:

1. Imports: `import { execFile, spawn } from 'node:child_process';`, `import { createStore, excludeSpark } from './lib/mission-store.js';`, `import { createMissionRunner } from './lib/mission-runner.js';`.
2. State, after `autoChildren`:

```js
// Missions for the open folder (lib/mission-runner.js), made again when the folder changes.
let missions;
```

3. Before `startBridge`:

```js
// git in `dir`, the way snapshot.ts runs commands. No shell: arguments go as given.
const gitIn = (dir) => (argv, init = {}) =>
  new Promise((done) =>
    execFile(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, timeout: init.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

// Missions live at the repo top (the folder itself outside a repo), next to the plugin's gate.jsonl.
async function openMissions() {
  const run = gitIn(cwd);
  const top = await run(['git', 'rev-parse', '--show-toplevel']);
  const inRepo = top.exitCode === 0;
  const root = inRepo ? top.stdout.trim() : cwd;
  if (inRepo) {
    const exclude = await run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    if (exclude.exitCode === 0) excludeSpark(exclude.stdout.trim());
  }
  missions = createMissionRunner({
    store: createStore(root),
    write: (line) => claude?.stdin.write(`${line}\n`),
    notify: (message) => send('mission', message),
    run: inRepo ? gitIn(root) : undefined,
    now: Date.now,
    hex4: () => randomBytes(2).toString('hex'),
  });
  missions.recover();
}
```

4. In `startBridge`, after `const answer = …`:

```js
      const held = missions?.draftDenial(tool, input);
      if (held) return answer({ allow: false, message: held });
      // A command Spark's gate holds is asked about every time: "always" can't cover it.
      const note = gateNote(tool, input, { repo: cwd, home: homedir() });
      if (!note && (alwaysAllow.has(tool) || (EDIT_TOOLS.has(tool) && settings().autoEdits))) {
        missions?.permission(tool, input, 'auto-allowed');
        return answer({ allow: true });
      }
      const id = randomBytes(6).toString('hex');
      pending.set(id, { answer, tool, input, note });
      send('permission', { id, tool, input, note });
```

5. `stopClaude`: answer what is pending with `for (const { answer } of pending.values()) answer({ allow: false, message: 'Stopped from Spark.' });`. After `marathon.restarted();`, add `missions?.interrupted('Claude Code restarted');`.
6. In the stdout loop, after `marathon.onEvent(event);`, add `missions?.onEvent(event);`.
7. In `child.on('error', …)`, before `send('exit', …)`, add `missions?.exited(undefined, err.message);`. In `child.on('exit', …)`, after `marathon.end(…)`, add `missions?.exited(code, errors.trim() || undefined);`.
8. `ready`: `if (!folderMode) return app.quit(); await openMissions(); startClaude();`
9. `open-folder`: before `cwd = folder;` add `missions?.interrupted('you opened another folder', { detach: true });`, and replace `startClaude();` with `await openMissions(); startClaude();`.
10. `new-chat`: before `startClaude();` add `missions?.interrupted('you started a new chat', { detach: true });`.
11. `stop`: the first line becomes `missions?.stopped();`.
12. `send-message`: after `turnEdited = false;`, add `missions?.you(message.text ?? '');`.
13. The `marathon` start path: before `marathon.start(…)`, add `if (missions?.busy()) return send('marathon', { kind: 'end', reason: 'a mission is running', summary: '' });`.
14. `permission-answer`: main uses the tool it asked about, not one the window names.

```js
ipcMain.on('permission-answer', (_e, { id, allow, always }) => {
  const ask = pending.get(id);
  if (!ask) return;
  pending.delete(id);
  if (allow && always) alwaysAllow.add(ask.tool);
  missions?.permission(ask.tool, ask.input, allow ? (always ? 'always' : 'allowed') : 'denied', ask.note);
  ask.answer({ allow });
});
```

15. Mission IPC, after the `marathon` handler:

```js
ipcMain.handle('missions', () => missions?.list() ?? []);
ipcMain.handle('mission-view', (_e, id) => missions?.view(id));
ipcMain.handle('mission', async (_e, request = {}) => {
  if (!missions) return { error: 'no folder is open' };
  if (request.action === 'start') {
    if (['gemini', 'auto'].includes(settings().model)) return { error: 'a mission needs Claude Code: pick a Claude model or UltraCode first' };
    if (marathon.running()) return { error: 'a marathon is running: /marathon stop ends it first' };
    if (!claude) startClaude({ resume: sessionId, keepBusy: true });
    fromUser = false;
    turnEdited = false;
    return missions.start(String(request.objective ?? ''), { sessionId });
  }
  if (request.action === 'approve') {
    fromUser = false;
    return missions.approve(request.id, request.criteria);
  }
  if (request.action === 'cancel') {
    const out = missions.cancel(request.id);
    if (out.stop) startClaude({ resume: sessionId });
    return out;
  }
  if (request.action === 'resume') {
    fromUser = false;
    return missions.resume(request.id, (resume) => startClaude({ resume, keepBusy: true }));
  }
  return { error: 'unknown mission action' };
});
```

- [ ] **Step 4: Run all checks**

Run: `cd app; npm test`, then the root `npm test` and `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commands.js app/main.js app/preload.cjs app/renderer.js app/test/core.test.js
git commit -m "Missions: wire the runner into the app (bridge, stream, stop, folders, IPC)"
```

---

### Task 9: Criteria card, header status and the Missions view

Load `spark:ui-taste` and `ui-ux-pro-max` before this task and follow them. The markup and CSS below are where to start, not the finished look.

**Files:**
- Create: `app/lib/missions-view.js`
- Modify: `app/index.html`, `app/styles.css`, `app/renderer.js`

**Interfaces:**
- Consumes: Task 8's renderer API and `'mission'` messages, plus Task 3's shapes:
  - rows: `{ at, glyph, tone, text, detail? }`
  - sections: `{ heading, lines: [{ text, tone? }], markdown? }`
- Produces: `createMissionsView({ spark, el, markdown, onStart, onToggle })`, returning `{ open(id?), close(), isOpen(), update(mission), addRow(id, row), showReport(id), tick() }`.

- [ ] **Step 1: Markup** (`app/index.html`)

In `nav.actions`, before `＋ New`:

```html
        <button id="missions-open" title="Missions: work toward criteria you approve, with a recorded report">Missions</button>
```

After `</main>`:

```html
    <section id="missions" hidden aria-label="Missions">
      <aside class="mission-list">
        <form id="mission-new" autocomplete="off">
          <input id="mission-objective" placeholder="New mission: what should be true when it's done?" aria-label="New mission objective" />
        </form>
        <ol id="mission-items"></ol>
      </aside>
      <article id="mission-detail" class="mission-detail" aria-live="polite"></article>
    </section>
```

Add `/mission` to the composer placeholder's list of commands.

- [ ] **Step 2: The view module** (`app/lib/missions-view.js`)

```js
// The Missions view: this folder's missions on the left, the chosen one on the right. Main sends
// ready-made timeline rows and report sections (mission-report.ts), so this only lays them out.
const LIVE = new Set(['draft', 'running', 'waiting']);
const OVER = new Set(['finished', 'blocked', 'cancelled']);
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const age = (at) => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

export function createMissionsView({ spark, el, markdown, onStart, onToggle }) {
  const root = document.getElementById('missions');
  const items = document.getElementById('mission-items');
  const detail = document.getElementById('mission-detail');
  const objective = document.getElementById('mission-objective');
  let selected = null;
  let timeline = null;

  const pill = (status) => el('span', `pill ${status}`, status);

  async function renderList() {
    const missions = await spark.missions();
    if (!missions.length) {
      items.replaceChildren(el('li', 'empty', 'No missions in this folder yet. Say what should be true when the work is done, and Claude drafts criteria for you to approve.'));
      return;
    }
    items.replaceChildren(
      ...missions.map((m) => {
        const li = el('li', `item${m.id === selected ? ' selected' : ''}`);
        const button = el('button');
        button.type = 'button';
        if (m.unreadable) button.append(el('span', 'title', m.id), el('span', 'meta', 'unreadable mission file'));
        else button.append(el('span', 'title', m.title), el('span', 'meta', age(m.createdAt)), pill(m.status));
        button.addEventListener('click', () => show(m.id));
        li.append(button);
        return li;
      }),
    );
  }

  function header(view) {
    const m = view.mission;
    const head = el('header', 'mission-head');
    const started = m.approvedAt ?? m.createdAt;
    const elapsed = el('span', 'elapsed', mmss((m.endedAt ?? Date.now()) - started));
    elapsed.dataset.since = String(started);
    elapsed.dataset.live = String(LIVE.has(m.status));
    const cost = view.totals.usd === undefined ? 'cost not reported' : `$${view.totals.usd.toFixed(2)} at API rates`;
    const tokens = view.totals.tokens === undefined ? '' : ` · ${Math.round(view.totals.tokens / 1000)}k tokens`;
    const facts = el('div', 'facts');
    facts.append(pill(m.status), el('span', '', m.reason), elapsed, el('span', '', `${cost}${tokens}`));
    const actions = el('div', 'actions');
    const button = (label, cls, action) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        const out = await spark.mission({ action, id: m.id });
        if (out.error) actions.append(el('span', 'error', out.error));
      });
      return b;
    };
    if (m.status === 'paused' || m.status === 'interrupted') actions.append(button('Resume', 'yes', 'resume'));
    if (!OVER.has(m.status)) actions.append(button('Cancel', 'no', 'cancel'));
    const back = el('button', 'ghost', 'Back to chat');
    back.type = 'button';
    back.addEventListener('click', () => onToggle(false));
    actions.append(back);
    head.append(el('h2', '', m.title), el('p', 'objective', m.objective), facts, actions);
    return head;
  }

  function rowNode(row) {
    const li = el('li', `row ${row.tone}`);
    li.append(el('time', '', time(row.at)), el('span', 'glyph', row.glyph), el('span', 'text', row.text));
    if (row.detail) {
      const more = el('details');
      more.append(el('summary', '', 'output'), el('pre', '', row.detail));
      li.append(more);
    }
    return li;
  }

  function reportNode(sections) {
    const box = el('section', 'report');
    box.append(el('h3', '', 'Report'));
    for (const s of sections) {
      const part = el('div', 'part');
      part.append(el('h4', '', s.heading));
      if (s.markdown) {
        const body = el('div', 'claude');
        body.innerHTML = markdown(s.lines[0]?.text ?? '');
        part.append(body);
      } else if (!s.lines.length) part.append(el('p', 'none', 'none'));
      else {
        const ul = el('ul');
        for (const line of s.lines) ul.append(el('li', line.tone ?? '', line.text));
        part.append(ul);
      }
      box.append(part);
    }
    return box;
  }

  async function show(id) {
    selected = id;
    const view = id ? await spark.missionView(id) : undefined;
    if (!view) {
      detail.replaceChildren(el('p', 'empty', 'Pick a mission, or start one on the left.'));
      timeline = null;
    } else {
      const criteria = el('section', 'criteria-list');
      criteria.append(el('h3', '', 'Criteria'));
      if (!view.mission.criteria.length) criteria.append(el('p', 'none', 'none yet'));
      const ol = el('ol');
      for (const c of view.mission.criteria) ol.append(el('li', '', `${c.text} · ${c.how}${c.by === 'you' ? ' · yours' : ''}`));
      criteria.append(ol);
      const log = el('section', 'timeline');
      log.append(el('h3', '', 'Timeline'));
      timeline = el('ol');
      timeline.append(...view.rows.map(rowNode));
      log.append(timeline);
      detail.replaceChildren(header(view), ...(view.sections ? [reportNode(view.sections)] : []), criteria, log);
    }
    renderList();
  }

  document.getElementById('mission-new').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = objective.value.trim();
    if (!text) return;
    objective.value = '';
    onStart(text);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onToggle(false);
  });

  return {
    isOpen: () => !root.hidden,
    async open(id) {
      onToggle(true);
      await show(id ?? selected ?? (await spark.missions()).find((m) => !m.unreadable)?.id ?? null);
      objective.focus();
    },
    close: () => onToggle(false),
    update(mission) {
      if (root.hidden) return;
      if (mission.id === selected) show(selected);
      else renderList();
    },
    addRow(id, row) {
      if (!root.hidden && id === selected && timeline) timeline.append(rowNode(row));
    },
    showReport(id) {
      if (!root.hidden && id === selected) show(id);
    },
    tick() {
      const node = detail.querySelector('.elapsed[data-live="true"]');
      if (node) node.textContent = mmss(Date.now() - Number(node.dataset.since));
    },
  };
}
```

- [ ] **Step 3: Renderer wiring** (`app/renderer.js`)

Add the import and state, then the functions:

```js
import { createMissionsView } from './lib/missions-view.js';
// …state, beside marathonState:
// The mission this window runs, as main last reported it, for the header.
let activeMission = null;
```

```js
const missionsView = createMissionsView({
  spark,
  el,
  markdown,
  onStart: (objective) => startMission(objective),
  onToggle(open) {
    $('missions').hidden = !open;
    list.hidden = open;
    composer.hidden = open;
    $('missions-open').classList.toggle('on', open);
    if (!open) input.focus();
  },
});
$('missions-open').addEventListener('click', () => (missionsView.isOpen() ? missionsView.close() : missionsView.open(activeMission?.id)));

async function startMission(objective) {
  if (busy) return note('Sparky is still working: wait, or press ■ to stop.');
  if (marathonState) return note('a marathon is running: /marathon stop ends it first');
  const out = await spark.mission({ action: 'start', objective });
  if (out.error) return note(out.error);
  missionsView.close();
  $('welcome').hidden = true;
  const card = el('div', 'mission-card drafting');
  card.append(
    el('div', 'mission-kicker', 'Mission'),
    el('div', 'mission-title', out.mission.objective),
    el('p', 'mission-note', 'Claude is reading the project to draft acceptance criteria. Nothing changes while it drafts.'),
  );
  append(card);
  turnTools = 0;
  setBusy(true);
}

function missionCommand(args) {
  input.value = '';
  autosize();
  if (!args) return missionsView.open(activeMission?.id);
  if (args === 'cancel') {
    if (!activeMission) return note('no mission running');
    return spark.mission({ action: 'cancel', id: activeMission.id }).then((out) => out.error && note(out.error));
  }
  startMission(args);
}

function criteriaCard(mission) {
  const card = el('div', 'mission-card');
  card.append(el('div', 'mission-kicker', 'Mission · approve the criteria'), el('div', 'mission-title', mission.title));
  if (!mission.criteria.length) card.append(el('p', 'mission-warn', mission.reason));
  const rows = el('ol', 'criteria');
  const addRow = (c = { text: '', how: '' }) => {
    const li = el('li', 'criterion');
    const text = el('input');
    text.value = c.text;
    text.placeholder = 'One outcome someone can check';
    text.setAttribute('aria-label', 'Criterion');
    const how = el('input', 'how');
    how.value = c.how;
    how.placeholder = 'test, command, or manual';
    how.setAttribute('aria-label', 'How it is checked');
    const x = el('button', 'remove', '×');
    x.type = 'button';
    x.title = 'Remove this criterion';
    x.addEventListener('click', () => li.remove());
    li.append(text, how, x);
    rows.append(li);
    return text;
  };
  (mission.criteria.length ? mission.criteria : [undefined]).forEach((c) => addRow(c));
  const add = el('button', 'ghost', '+ criterion');
  add.type = 'button';
  add.addEventListener('click', () => addRow().focus());
  const bar = el('div', 'buttons');
  const go = el('button', 'yes', 'Approve and start');
  const cancel = el('button', 'no', 'Cancel mission');
  go.type = cancel.type = 'button';
  const settle = (cls, text) => {
    bar.replaceWith(el('div', `answered ${cls}`, text));
    add.remove();
    for (const n of rows.querySelectorAll('input, button')) n.disabled = true;
  };
  go.addEventListener('click', async () => {
    const criteria = [...rows.children].map((li) => ({ text: li.children[0].value, how: li.children[1].value }));
    const out = await spark.mission({ action: 'approve', id: mission.id, criteria });
    if (out.error) return note(out.error);
    settle('allowed', `Approved ${out.mission.criteria.length} criteria`);
    turnTools = 0;
    setBusy(true);
  });
  cancel.addEventListener('click', async () => {
    const out = await spark.mission({ action: 'cancel', id: mission.id });
    if (out.error) return note(out.error);
    settle('denied', 'Mission cancelled');
  });
  bar.append(go, cancel);
  card.append(rows, add, bar);
  return card;
}

spark.on('mission', (m) => {
  if (m.kind === 'state') {
    if (m.active) activeMission = m.mission;
    else if (activeMission?.id === m.mission.id) activeMission = null;
    renderStatus();
    missionsView.update(m.mission);
  }
  if (m.kind === 'row') missionsView.addRow(m.id, m.row);
  if (m.kind === 'review') {
    setBusy(false);
    append(criteriaCard(m.mission));
  }
  if (m.kind === 'report') {
    const status = m.sections[0]?.lines[0]?.text || m.mission.status;
    const line = el('div', m.mission.status === 'finished' ? 'result' : 'result failed', `◆ mission ${status} · `);
    const open = el('button', 'link', 'open the report');
    open.type = 'button';
    open.addEventListener('click', () => missionsView.open(m.id));
    line.append(open);
    append(line);
    missionsView.showReport(m.id);
  }
  if (m.kind === 'error') append(el('div', 'result failed', `✗ mission: ${m.error}`));
});
setInterval(() => {
  if (activeMission) renderStatus();
  missionsView.tick();
}, 1000);
```

In `renderStatus`, after the `marathon` line:

```js
  const mission = activeMission ? ` · mission ${activeMission.status} ${elapsed(Date.now() - (activeMission.approvedAt ?? activeMission.createdAt))}` : '';
```

and put `${mission}` right after `${marathon}` in the status text. In `runCommand`, before the `mode` branch:

```js
  if (command.kind === 'mission') {
    missionCommand(command.args);
    return true;
  }
```

In `marathonCommand`, after the gemini/auto check, add `if (activeMission) return note('a mission is running: finish or cancel it first');`.

- [ ] **Step 4: Styles** (append to `app/styles.css`; `spark:ui-taste` sets the final values)

```css
#bar .actions button.on { background: color-mix(in srgb, var(--c2) 28%, transparent); }

#missions { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: 16px; padding: 16px 24px 24px; min-height: 0; flex: 1; overflow: hidden; }
.mission-list { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.mission-list input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--c2) 40%, transparent); background: var(--panel); color: inherit; font: inherit; }
#mission-items { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
#mission-items .item button { width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; background: color-mix(in srgb, var(--panel) 80%, transparent); color: inherit; cursor: pointer; }
#mission-items .item.selected button { border-color: var(--c2); }
#mission-items .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mission-items .meta { grid-row: 2; font-size: 12px; opacity: 0.7; }
#mission-items .pill { grid-row: 1 / span 2; align-self: center; }
.mission-list .empty, .mission-detail .empty { opacity: 0.75; line-height: 1.5; }

.pill { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--c3) 30%, transparent); }
.pill.finished { background: color-mix(in srgb, #55e6a5 30%, transparent); }
.pill.blocked, .pill.interrupted { background: color-mix(in srgb, #ff7a8a 30%, transparent); }
.pill.waiting, .pill.review, .pill.paused { background: color-mix(in srgb, #ffc66d 30%, transparent); }
.pill.cancelled { background: color-mix(in srgb, #9aa3b5 25%, transparent); }

.mission-detail { overflow-y: auto; min-height: 0; padding-right: 8px; display: flex; flex-direction: column; gap: 20px; }
.mission-head h2 { margin: 0 0 4px; font-size: 20px; }
.mission-head .objective { margin: 0 0 8px; opacity: 0.8; }
.mission-head .facts { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 13px; }
.mission-head .actions { display: flex; gap: 8px; margin-top: 10px; }
.mission-detail h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.7; }
.mission-detail h4 { margin: 12px 0 4px; font-size: 14px; }
.timeline ol { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.timeline .row { display: grid; grid-template-columns: 76px 22px 1fr; gap: 6px; padding: 4px 0; border-bottom: 1px solid color-mix(in srgb, var(--c2) 12%, transparent); }
.timeline .row details { grid-column: 3; }
.timeline .row pre { white-space: pre-wrap; font-size: 12px; max-height: 240px; overflow: auto; }
.timeline time { opacity: 0.6; font-variant-numeric: tabular-nums; }
.row.ok .glyph, .report li.ok { color: #55e6a5; }
.row.fail .glyph, .report li.fail { color: #ff7a8a; }
.row.warn .glyph, .report li.warn { color: #ffc66d; }

.mission-card { border: 1px solid color-mix(in srgb, var(--c2) 45%, transparent); border-radius: 14px; padding: 14px 16px; background: var(--panel); display: flex; flex-direction: column; gap: 10px; }
.mission-kicker { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.75; }
.mission-title { font-weight: 600; font-size: 16px; }
.mission-card .criteria { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.mission-card .criterion { display: grid; grid-template-columns: 1fr minmax(120px, 30%) 28px; gap: 6px; }
.mission-card input { padding: 7px 9px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--c2) 35%, transparent); background: transparent; color: inherit; font: inherit; }
.mission-card .mission-warn { color: #ffc66d; margin: 0; }
button.link { background: none; border: 0; padding: 0; color: var(--c1); text-decoration: underline; cursor: pointer; font: inherit; }

@media (max-width: 860px) {
  #missions { grid-template-columns: 1fr; }
  .mission-list { max-height: 35vh; }
}
```

- [ ] **Step 5: Screenshot check**

Open `app/index.html` in Playwright (`file://`, after `cd app; npm run stage`). Before the page scripts run, inject a stub `window.spark` with these canned answers:
- `missions()`: one finished mission with a report, and one running.
- `missionView()`: a view for each, the running one with a 60-row timeline.
- `on`: records handlers, so the test can fire a `review` message.

Open the view, then fire `review` to show the criteria card. Take screenshots at 720 and 1440 px wide in both themes (`body.ultraviolet`, `body.teal`).

Check them against `spark:ui-taste`: hierarchy, spacing, contrast, the empty state, long titles. Fix what's off.

- [ ] **Step 6: Run all checks and commit**

Run: `cd app; npm test`, then the root `npm test` and `npm run check`. Expected: PASS.

```bash
git add app/lib/missions-view.js app/index.html app/styles.css app/renderer.js
git commit -m "Missions: criteria card, header status and the Missions view"
```

---

### Task 10: `/mission` in the terminal

**Files:**
- Modify: `plugin/hooks/register.tsx`, `plugin/types/index.d.ts`
- Test: `plugin/test/mission-terminal.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `/mission <objective> | approve | cancel`, the `spark:mission` pane, and the state key `spark.mission: { id: string; root: string; status: Status } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// plugin/test/mission-terminal.test.ts
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const
const mission = ($: Engine, args = '') => $.command.run({ command: 'mission', args, origin: composer, presentation })
const DRAFT = 'Read it.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"sixth login gets 429","how":"npm test"}]}\n```'
const key = (p: string) => String(p).replace(/\//g, '\\')

// A session at C:/app with an in-memory disk, git that answers what snapshots ask, and a prompt box.
function terminal(on: any) {
  const disk = new Map<string, string>()
  let box = ''
  mock.env(on, {})
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }))
  on('prompt.fill', (_$: unknown, e: any) => {
    box = e.text
    return { isFilled: true }
  })
  on('fs.write', (_$: unknown, e: any) => {
    disk.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_$: unknown, e: any) => (disk.has(key(e.path)) ? { value: disk.get(key(e.path)) } : { deny: 'no such file' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: disk.has(key(e.path)) }))
  on('process.run', (_$: unknown, e: any) => {
    const a: string[] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.includes('--show-toplevel')) return out('C:/app\n')
    if (a.includes('--git-path')) return out(`C:/app/.git/${a.at(-1)}\n`)
    if (a.includes('write-tree')) return out(`${'f'.repeat(40)}\n`)
    if (a.includes('commit-tree')) return out(`${'a'.repeat(40)}\n`)
    if (a.includes('--numstat')) return out('3\t1\tsrc/auth.js\n')
    if (a.some((x) => x.endsWith('^{tree}'))) return out(`${'f'.repeat(40)}\n`)
    if (a.includes('--verify')) return out('head1\n')
    return out('')
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const files = (name: string) => [...disk.entries()].filter(([k]) => k.endsWith(name))
  const saved = () => JSON.parse(files('mission.json')[0]![1])
  return { disk, clock, box: () => box, saved, files }
}

const turnComplete = ($: Engine, answer: string) => $.turn.complete({ answer, turnId: 't1' } as any)

test('/mission drafts read-only, approve fills the run message, and a finished turn writes the report', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  expect((await mission($, 'rate-limit the login route')).text).toContain('Enter sends the draft request')
  await t.clock.advance(50)
  expect(t.box()).toMatch(/^\\Mission: rate-limit the login route/)
  const denied: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/auth.js', old_string: 'a', new_string: 'b' } as any)
  expect(denied.deny).toContain('being drafted')
  await turnComplete($, DRAFT)
  await t.clock.advance(50)
  expect(t.saved()).toMatchObject({ status: 'review', title: 'Rate-limit login' })
  expect((await mission($, 'approve')).text).toBe('✦ approved: Enter sends the mission to Claude')
  await t.clock.advance(50)
  expect(t.box()).toContain('1. sixth login gets 429 (check: npm test)')
  expect(t.saved().startSha).toBe('a'.repeat(40))
  await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/auth.js', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as any)
  await turnComplete($, 'Changed auth.js.')
  await t.clock.advance(50)
  expect(t.saved().status).toBe('finished')
  const report = JSON.parse(t.files('report.json')[0]![1])
  expect(report.files).toEqual([{ path: 'src/auth.js', added: 3, removed: 1 }])
  expect(report.cost).toEqual({})
  const events = t.files('events.jsonl')[0]![1].trim().split('\n').map((l: string) => JSON.parse(l))
  expect(events.some((e: any) => e.kind === 'tool' && e.name === 'Edit')).toBe(true)
})

test('/mission refuses a second mission while one is live, and cancel ends it', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  await mission($, 'rate-limit the login route')
  expect((await mission($, 'something else')).text).toBe('✦ a mission is draft: /mission cancel ends it first')
  expect((await mission($, 'cancel')).text).toBe('✦ mission cancelled')
  expect(t.saved().status).toBe('cancelled')
  expect((await mission($, 'something else')).text).toContain('Enter sends the draft request')
})
```

Before writing these, look at how `plugin/test/register.test.ts` drives `turn.complete` and how panes are opened in tests (`ui.open`). If either shape differs from the calls above, match the existing tests. Mission work after `turn.complete` runs off the hook's path, so the tests advance the fake clock and await before asserting.

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugin`
Expected: FAIL: `/mission` is unknown.

- [ ] **Step 3: Implement**

`plugin/types/index.d.ts`: add `import type { Status } from '../hooks/mission'` at the top, and in `PluginState.spark` add `mission: { id: string; root: string; status: Status } | null`.

`plugin/hooks/register.tsx`:

1. Imports:

```ts
import {
  DRAFT_DENIAL, DRAFT_DENIED, FINAL, asMission, asRecord, draftText, move, newMission, parseGateLines, recordsFor, runText, turnEnded, youRecord,
} from './mission'
import type { Mission, MissionRecord } from './mission'
import { buildReport, describe, gitFacts, reportSections } from './mission-report'
import type { Row } from './mission-report'
// and add pinSnapshot to the existing './snapshot' import
```

2. Constants, next to the others:

```ts
const MISSION = { plugin: 'spark', key: 'mission' } as const
const MISSION_PANE = 'spark:mission'
const TONE: Record<Row['tone'], string | undefined> = { ok: '#4ADE80', fail: ERROR, warn: '#FACC15', info: undefined }
```

and in `COMMANDS`:

```ts
  { name: 'mission', description: 'Spark: work toward criteria you approve, with a recorded report', argumentHint: '<objective> | approve | cancel' },
```

3. Helpers, after `recordGate`:

```ts
// Terminal missions keep the app's files: .spark/missions/<id>/{mission.json,events.jsonl,report.json}.
const missionFile = (root: string, id: string, name: string) => `${root}/.spark/missions/${id}/${name}`
const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
// After a command the engine clears the box; fill it once that has happened.
const fillLater = ($: EngineInterface, text: string) => void $.clock.sleep(30).then(() => $.prompt.fill({ text })).catch(() => {})

async function loadMission($: EngineInterface, at: { id: string; root: string }) {
  const m = asMission(JSON.parse(await $.fs.read(missionFile(at.root, at.id, 'mission.json'))))
  if (!m || m.id !== at.id) throw new Error('the mission file is unreadable')
  return m
}

async function missionRecords($: EngineInterface, at: { id: string; root: string }) {
  const text = await $.fs.read(missionFile(at.root, at.id, 'events.jsonl')).catch(() => '')
  return text.split('\n').flatMap((line): MissionRecord[] => {
    try {
      const r = asRecord(JSON.parse(line))
      return r ? [r] : []
    } catch {
      return []
    }
  })
}

async function saveMission($: EngineInterface, root: string, m: Mission, records: MissionRecord[] = []) {
  await $.fs.write(missionFile(root, m.id, 'mission.json'), `${JSON.stringify(m, null, 2)}\n`)
  if (records.length) {
    const path = missionFile(root, m.id, 'events.jsonl')
    const before = await $.fs.read(path).catch(() => '')
    await $.fs.write(path, before + records.map((r) => `${JSON.stringify(r)}\n`).join(''))
  }
  await $.state.set(MISSION, { id: m.id, root, status: m.status })
  $.ui.invalidate('ui.render')
}

async function missionReport($: EngineInterface, root: string, m: Mission) {
  const { mission, facts } = await gitFacts(inRepo ? runner($) : undefined, m, await $.clock.now())
  const report = buildReport(mission, await missionRecords($, { id: m.id, root }), facts)
  await $.fs.write(missionFile(root, m.id, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await saveMission($, root, mission)
  await openPane($, MISSION_PANE, 'mission')
}

async function missionAction($: EngineInterface, at: { id: string; root: string }, action: 'approve' | 'cancel') {
  const m = await loadMission($, at)
  const now = await $.clock.now()
  if (action === 'cancel') {
    if (FINAL.has(m.status)) return `✦ the mission is already ${m.status}`
    const moved = move(m, 'cancelled', 'you cancelled it', now)
    await saveMission($, at.root, moved.mission, [moved.record])
    await missionReport($, at.root, moved.mission)
    return '✦ mission cancelled'
  }
  if (m.status !== 'review') return `✦ the mission is ${m.status}, not waiting for approval`
  if (!m.criteria.length) return '✦ no criteria came back: /mission cancel and draft again, or edit them in the app'
  const startSha = inRepo ? await pinSnapshot(runner($), `refs/spark/missions/${m.id}/start`, `mission ${m.id} start`).catch(() => undefined) : undefined
  const moved = move(m, 'running', `you approved ${m.criteria.length} criteria`, now)
  const running: Mission = { ...moved.mission, approvedAt: now, ...(startSha ? { startSha } : {}) }
  await saveMission($, at.root, running, [moved.record])
  fillLater($, `\\${runText(running)}`)
  return '✦ approved: Enter sends the mission to Claude'
}

// A prompt sent while a mission runs or waits is yours; one that answers a question resumes it.
async function missionPrompt($: EngineInterface, text: string) {
  const at = await read($, MISSION)
  if (!at || !text || (at.status !== 'running' && at.status !== 'waiting')) return
  const m = await loadMission($, at)
  const now = await $.clock.now()
  const you = youRecord(text, now)
  if (m.status !== 'waiting') return saveMission($, at.root, m, [you])
  const moved = move(m, 'running', 'you answered', now)
  await saveMission($, at.root, moved.mission, [you, moved.record])
}

async function missionTool($: EngineInterface, at: { id: string; root: string }, e: { tool: string; tool_use_id?: string }, result: { isError?: boolean; deny?: string; text?: unknown }) {
  const now = await $.clock.now()
  const id = e.tool_use_id ?? String(now)
  await saveMission($, at.root, await loadMission($, at), [
    ...recordsFor({ kind: 'tool', id, name: e.tool, input: e as unknown as Record<string, unknown> }, now),
    ...recordsFor({ kind: 'tool-result', id, isError: Boolean(result.isError || result.deny), output: String(result.text ?? result.deny ?? '') }, now),
  ])
}

async function missionTurn($: EngineInterface, answer: string) {
  const at = await read($, MISSION)
  if (!at || (at.status !== 'draft' && at.status !== 'running')) return
  const m = await loadMission($, at)
  const now = await $.clock.now()
  const log = await $.fs.read(`${at.root}/${GATE_LOG}`).catch(() => '')
  const done = turnEnded(m, await missionRecords($, at), { ok: true, text: answer }, parseGateLines(log.slice(m.gateOffset)), log.length, now)
  await saveMission($, at.root, done.mission, [...recordsFor({ kind: 'result', ok: true, text: answer }, now), ...done.records])
  if (done.mission.status === 'review') {
    $.ui.toast(`✦ ${done.mission.criteria.length} criteria drafted: /mission shows them, /mission approve starts`)
    await openPane($, MISSION_PANE, 'mission')
  }
  if (FINAL.has(done.mission.status)) await missionReport($, at.root, done.mission)
}
```

4. Hooks:
   - `turn.start`: before `return next(e)`, add `void missionPrompt($, e.text).catch(() => {})`.
   - `tool.call`: right after the `.spark/` denial, add `const missionAt = e.agentId ? null : await read($, MISSION)` and `if (missionAt?.status === 'draft' && DRAFT_DENIED.has(e.tool)) return { deny: DRAFT_DENIAL }`. Before `return out`, add `if (missionAt && (missionAt.status === 'draft' || missionAt.status === 'running')) await missionTool($, missionAt, e, result as { isError?: boolean; deny?: string; text?: unknown }).catch(() => {})`.
   - `turn.complete`: inside `if (!e.agentId)`, chain `.then(() => missionTurn($, e.answer)).catch(() => {})` after `reviewGoal`.
   - The command and the pane:

```tsx
  on('command.run', { command: 'mission' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const at = await read($, MISSION)
    try {
      if (!args) {
        if (!at) return { text: '✦ no mission. /mission <what should be true when it is done>' }
        await openPane($, MISSION_PANE, 'mission')
        return { text: '✦ mission pane open' }
      }
      if (args === 'approve' || args === 'cancel') return { text: at ? await missionAction($, at, args) : '✦ no mission' }
      if (at && !FINAL.has(at.status)) return { text: `✦ a mission is ${at.status}: /mission cancel ends it first` }
      const root = await repoTop($)
      const gateOffset = (await $.fs.read(`${root}/${GATE_LOG}`).catch(() => '')).length
      const { mission, record } = newMission(args, await $.clock.now(), hex4(), gateOffset)
      await saveMission($, root, mission, [record])
      if (inRepo) await ignoreSparkDir($)
      fillLater($, `\\${draftText(args)}`)
      return { text: '✦ mission created: Enter sends the draft request (Claude only reads). Then /mission approve.' }
    } catch (err) {
      return { text: `✦ ${message(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: MISSION_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const at = await read($, MISSION)
    if (!at) return <Text dimColor>no mission</Text>
    const m = await loadMission($, at).catch(() => undefined)
    if (!m) return <Text color={ERROR}>the mission file is unreadable</Text>
    const rows = (await missionRecords($, at)).map(describe).filter((r): r is Row => r !== undefined).slice(-30)
    const report = await $.fs.read(missionFile(at.root, at.id, 'report.json')).then((t) => JSON.parse(t) as unknown).catch(() => undefined)
    return (
      <Box flexDirection="column">
        <Text bold>{m.title}</Text>
        <Text dimColor>
          {m.status} · {m.reason}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>criteria</Text>
          {m.criteria.length ? null : <Text dimColor>none yet</Text>}
          {m.criteria.map((c, i) => (
            <Text>{`${i + 1}. ${c.text} · ${c.how}`}</Text>
          ))}
        </Box>
        {report
          ? reportSections(report).map((s) => (
              <Box marginTop={1} flexDirection="column">
                <Text bold>{s.heading}</Text>
                {s.lines.length ? s.lines.map((l) => <Text color={l.tone ? TONE[l.tone] : undefined}>{l.text}</Text>) : <Text dimColor>none</Text>}
              </Box>
            ))
          : null}
        <Box marginTop={1} flexDirection="column">
          <Text bold>timeline</Text>
          {rows.map((r) => (
            <Text color={TONE[r.tone]}>{`${r.glyph} ${r.text}`}</Text>
          ))}
        </Box>
      </Box>
    )
  })
```

- [ ] **Step 4: Run all checks**

Run: `claude plugin test plugin`, `npm run check`, the root `npm test`, and `cd app; npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/register.tsx plugin/types/index.d.ts plugin/test/mission-terminal.test.ts
git commit -m "Missions: /mission in the terminal with the same records and report"
```

---

### Task 11: README, end-to-end run, final verification

**Files:**
- Modify: `README.md`: the app's feature list, a `## Missions` section after `## Marathons`, `/mission` in the terminal command table, and `.spark/gate.jsonl` under Guardrails.
- Modify: `docs/superpowers/specs/2026-10-10-missions-foundation-design.md`: update anything the build changed from what it says.
- Create (outside the repo): `%TEMP%\spark-e2e\mission-e2e.mjs`

- [ ] **Step 1: README**

Add to "The app" list:

```markdown
- **Missions:** `/mission <objective>` (or **Missions** in the header) has Claude read the project and draft acceptance criteria without changing anything. You edit and approve them, Claude does the work, and Spark records what happened: tool calls, your approvals, test-gate runs, builds, halts and cost. The mission ends with a report built from those records, next to Claude's own account, which is marked unverified. See [Missions](#missions).
```

Add this section after Marathons:

```markdown
## Missions

`/mission rate-limit the login route` starts one. The draft step runs in plan mode, and Spark refuses edits and shell commands until you approve. The criteria card lets you edit, add or remove criteria; **Approve and start** sends them to Claude.

- **Records** go to `.spark/missions/<id>/` in the repo, kept out of git: `mission.json`, `events.jsonl` and, at the end, `report.json`. Secrets are redacted, and only error tails are kept.
- **The report** covers:
  - whether the tests passed on exactly the code the mission ended with
  - which files changed, from snapshots pinned at `refs/spark/missions/<id>/start` and `/end`
  - the commands run, and every test-gate run and build
  - what you allowed and denied
  - the time and cost Claude Code reported

  Spark doesn't check the criteria themselves yet: each one says "not checked by Spark", or "needs you" if it's manual.
- **Stopping:** ■ pauses a mission, and Resume continues it on the same session. Closing Spark, New chat or opening another folder interrupts it; Resume picks it up later. If a Claude Code session can't be resumed, the next Resume starts a fresh one.
- **In the terminal:** `/mission <objective>`, then `/mission approve` or `/mission cancel`; `/mission` alone opens the pane. The terminal can't see costs or your permission answers, and has no criteria editor.
```

Under Guardrails, add to both Test gate (F4) and Halt (F10): "Each run, counted build and halt is also written to `.spark/gate.jsonl` for mission reports. Claude can't edit `.spark/`, and commands that name its records are blocked."

- [ ] **Step 2: End-to-end run (real Claude Code, haiku)**

Write `%TEMP%\spark-e2e\mission-e2e.mjs`. It does this:

1. Makes a scratch git repo in `%TEMP%` with `add.js`, `add.test.js` (one failing test) and `package.json` (`"test": "node --test"`).
2. Starts `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --plugin-dir <repo>/plugin` in that repo.
3. Creates `createStore` and `createMissionRunner` from `app/lib/`, imported by absolute path after `cd app; npm run stage`.
4. Feeds `parseLine` events into `onEvent`.
5. Starts a mission ("make the add test pass") and approves the drafted criteria when the `review` message arrives.
6. Waits up to 10 minutes for the `report` message.
7. Prints `mission.json`, the gate lines and the report sections.

Run: `node "$env:TEMP\spark-e2e\mission-e2e.mjs"`

Expected:
- status `finished`
- at least one `tests` gate line
- report status `Finished · tests passed on this code`
- `add.js` listed under Changed files

Compare every report line by hand with `events.jsonl` and the repo's `git diff`.

- [ ] **Step 3: The window, for real**

Run: `cd app; npm start`. In the scratch repo:
- run a mission end to end
- press ■ during a run: it pauses, then Resume continues it
- close and reopen the app mid-run: it's interrupted, then Resume picks it up
- look at the Missions view in both themes

Write down anything that doesn't match the spec, and fix it test first.

- [ ] **Step 4: Full verification**

Run: the root `npm test`, `npm run check`, and `cd app; npm test`.
Expected: all pass, with counts above the baseline (launcher 79, mod 117, app 85).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-10-missions-foundation-design.md
git commit -m "Missions: README, spec updated to what was built"
```
