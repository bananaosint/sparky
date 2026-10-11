# Mission Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Executed inline by the spec's author, test first. Each task names its tests; they are written and seen failing before the code.

**Goal:** a substantial mission drafts a short spec and a task graph, approved with its criteria. Spark then drives the tasks one turn at a time, with a check and one retry per task. The view draws the graph.

**Architecture:**
- **Pure core:** `plugin/hooks/plan.ts`, plus `mission.ts`, `mission-report.ts`.
- **Drivers:** the app runner (`app/lib/mission-runner.js`) and the terminal mod (`register.tsx`). Both reuse the verification engine's check runner.

**Spec:** `docs/superpowers/specs/2026-10-10-mission-plans-design.md`

## Global Constraints

- No new dependencies.
- Plugin modules the app loads use `.ts` runtime imports and erasable TypeScript only.
- Window text uses `textContent`. Markdown only goes through DOMPurify.
- Task states come from task records alone. Nothing stores them elsewhere.
- A mission without tasks behaves exactly as before.

## Review Focus

1. A task whose check can't run (untrusted, gate, changed script) must not loop: it is done with the reason.
2. ■, an exit or a question in the middle of a task must not lose the task. Resume re-sends the current task.
3. A plan from a hostile `.spark/missions/<id>/mission.json` (ids like `../x`, cycles) is dropped by `asMission`.
4. A retry after a failed check sends the failing tail, redacted.
5. Removing tasks in the card can't leave a dependency on a removed task.

---

### Task 1: `plan.ts` (done: 01063cb)
`validatePlan`, `removeTask`, `layers`, `taskStates`, `nextTask`, `taskText`, `retryText`; 6 tests.

### Task 2: Mission fields, draft and parse (`mission.ts`)
**Produces:**
- `Mission.spec?: string` and `Mission.tasks?: Task[]`.
- `parseMissionBlock` returns `{ title, criteria, spec?, tasks?, planError? }`.
- The draft text asks for the optional `spec` and `tasks`.
- `runText` includes the spec and the plan and ends with `taskText(first)` when there are tasks.
- `resumeText` names the current task.
- The `task` record kind in `MissionRecord`; `asRecord` validates task records.
- `asMission` re-validates `tasks` through `validatePlan` and clips `spec`.
- `approvedPlan(drafted, sent)` builds the tasks the window sends back on Approve: edits and removals, re-validated.

- [ ] Tests (`plugin/test/mission.test.ts`):
  - a block with a spec and tasks parses
  - a bad plan comes back as `planError` with the criteria kept
  - a hostile `mission.json` plan is dropped
  - the run text ends with task t1
  - the resume text names the current task
  - approvedPlan applies edits and removals

### Task 3: Turn ends with tasks (`plan.ts` / `mission.ts`)
**Produces:** `taskTurnEnded(m, records, turn, now) → { decision: 'next' | 'check' | ..., ... }`, or the runner composes it from `nextTask` and `taskStates`. A running mission with tasks doesn't finish on a turn end while tasks remain. `onTurnEnd` gets `{ tasksLeft: boolean }`, so a normal end with tasks left becomes `{ to: 'running', reason: 'task done' }` (no status move: the mission stays running).

- [ ] Tests:
  - a normal turn end with tasks left keeps the mission running
  - the last task's end finishes it
  - a question waits
  - a failed turn blocks

### Task 4: App runner drives tasks (`mission-runner.js`)
**Produces:**
- On approve with tasks: a `task started` record for t1, with a snapshot pinned at `refs/spark/missions/<id>/task-t1`.
- On each turn end with a task running:
  - numstat from the task snapshot to now, giving `files`
  - the task's check through `verify(mission, onResult, { only: check })`
  - pass, or no check, or a check that didn't run: record `done` and start the next task (`started` record, snapshot, send `taskText`)
  - a failed check on attempt 1: `retry`, and send `retryText`
  - a failed check on attempt 2: `failed`, and the mission is blocked
- No next task: the mission finishes, then the verification pass and the report.
- `verify` gets an optional single-check form: `checkTask(mission, task, onResult)`, built in `mission-open.js` from `planChecks`' rules for one command.

- [ ] Tests (`app/test/mission-runner.test.js`, fake verify):
  - tasks run in order
  - a failed check retries once with the tail, then blocks
  - a check that didn't run leaves the task done with the reason
  - ■ during a task, then Resume, re-sends that task
  - a mission without tasks is unchanged

### Task 5: Report and timeline (`mission-report.ts`)
**Produces:**
- A `Tasks` section listing state, attempts, files and check per task.
- `describe` rows for task records.
- `report.tasks` for the view.

- [ ] Tests: the section lines; the rows.

### Task 6: Window (`missions-view.js`, `renderer.js`, `styles.css`)
**Produces:**
- The review card shows the spec and the tasks, with edit, remove and Run as one piece.
- The Missions view draws the graph in layers, and a task panel on select.
- `mission-view` returns `tasks` and `taskStates`.

- [ ] Browser check with a stubbed bridge at 720 and 1440 px.

### Task 7: Terminal (`register.tsx`)
**Produces:** the mod drives tasks. At a task's turn end it runs the check with `runCheck`, records it, and fills the prompt with the next task's or the retry's message. The pane lists tasks and their states.

- [ ] Test (`plugin/test/mission-terminal.test.ts`): a two-task mission fills t2's message after t1 and finishes after t2.

### Task 8: README, a full suite run, an end-to-end two-task mission with haiku in a scratch repo, then a fresh review
