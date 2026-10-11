# Mission plans: a task graph Spark drives

A substantial mission gets a short spec and a task graph at the draft, reviewed with its criteria at the one approval gate. Spark then drives the tasks one at a time: it sends one task per turn, records what each changed, runs the task's own check, retries a failed check once, and moves to the next task whose dependencies are done. The Missions view draws the graph, and selecting a task shows its instructions, inputs, changes, check and timeline. This is sub-project 4 of the command-center spec (`FutureAdd-onns_Prompt.txt`, sections 4.3, 5.1, 8.3 and 16). Parallel workers are sub-project 6. Here the graph says what *could* run in parallel, and Spark runs it in order.

## The draft

The draft request asks for two optional fields next to the criteria:

- `spec`: a short technical note of 1,500 characters at most. It covers requirements, constraints, risks and data or API changes, whichever apply.
- `tasks`: 2 to 10 tasks. Each has an `id` (`t1`, `t2`, …), a `title`, `do` (the instructions), `after` (the ids it depends on) and an optional `check` (a command that shows the task is done).

Claude is told to leave both out when the change is small, such as one or two files with an obvious approach. A mission without tasks runs exactly as it does today. Simple work stays fast.

**Validation** is pure (`plugin/hooks/plan.ts`):
- Ids must be unique, and `after` must name earlier tasks only. That rules out cycles by construction.
- There can be at most 10 tasks, and every text is redacted and clipped.
- A `check` that isn't a command (by `isCommandHow`) is dropped. The task then has no check.

A plan that fails validation is dropped whole. The review card then says why, and that the mission will run as one piece.

## The review

The criteria card also shows the spec and the tasks, each with what it waits for. You can edit a task's instructions or check, or remove a task. A removed task's dependents then wait for what it waited for. **Run as one piece** drops the plan. Approve sends criteria and tasks together.

## Running

When the approved mission has tasks, Spark drives them:

1. **The run message** carries the objective, the criteria, the spec and the whole plan for context. It ends with "Do only task t1 now: …; end your turn when it is done."
2. **When a task's turn ends normally:**
   - Spark records the task's changed files. These come from a snapshot pinned when the task started, compared against the tree now.
   - Spark runs the task's check. It uses the same rules and runner as the verification engine: the person's trust, the gate, scripts changed during the mission, 5 minutes, and a redacted log.
   - **Passed, or no check:** the task is *done*. A task with no check says "done (no check: Claude's word)".
   - **Failed on the first attempt:** Spark sends "Task t2's check failed (exit 1): <tail>. Fix it, then end your turn." That is attempt 2.
   - **Failed on the second attempt:** the task is *failed*, and the mission is *blocked* with "task t2's check failed twice". Recovery is bounded (§8.3).
   - **A check that doesn't run** (untrusted folder, the gate would ask, a changed script) leaves the task *done (check not run: reason)*. The final verification pass shows the same reason.
3. **The next task** is the first one, in plan order, whose dependencies are all done. When none is left, the mission is *finished*. Spark's verification pass and the report follow, as today.
4. **Other turn endings behave as today:** a question puts the mission in waiting (the task stays running); a failed turn or a halt blocks it; ■ pauses it. Resume re-sends the current task with the resume text.

**Records:** `{ at, kind: 'task', id, event: 'started' | 'retry' | 'done' | 'failed', attempt, files?, check? }`. Task states come from these records alone, through a pure `taskStates(tasks, records)`. Nothing else stores them.

## The report and the view

- **The report** gets a **Tasks** section: each task's state, attempts, changed files and check result.
- **The Missions view** draws the graph in layers. Layer *n* holds the tasks whose longest chain of dependencies has length *n*. Each task is a box with its state (queued, running, done, failed, not reached), and lines show what it waits for. Tasks in the same layer could run in parallel, and the view says so.
- **Selecting a task** shows its instructions, what it waits for, its attempts, files changed, its check with a link to the log, and the timeline rows from its turns.

## Terminal

The mod drives the same plan:
- When a task's turn ends, the mod runs the check through `$.process.run` and fills the prompt box with the next task's message. The person presses Enter, as with `/mission approve`.
- The pane lists tasks with their states.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/plan.ts` | Pure. `parsePlan` (from the mission block), `validatePlan`, `removeTask`, `layers`, `nextTask`, `taskStates`, and the task message texts. |
| `plugin/hooks/mission.ts` | `Mission.spec` and `Mission.tasks`; the draft text asks for them; `asMission` validates them; task records. |
| `plugin/hooks/mission-report.ts` | The Tasks section, and timeline rows for task records. |
| `app/lib/mission-runner.js` | Drives tasks: snapshots, checks, retries, next task. |
| `app/lib/missions-view.js`, `app/renderer.js` | The plan in the review card, the graph and the task panel. |
| `plugin/hooks/register.tsx` | The same for terminal missions. |

## Not covered

- Running independent tasks at the same time, agent roles per task, and a model per task (sub-project 6).
- Editing dependencies in the card (only removing a task, which rewires them).
- Spark doesn't check that Claude did only the task it was asked for. A task's changed files show what it actually touched.
