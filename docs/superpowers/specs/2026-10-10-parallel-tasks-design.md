# Parallel tasks: independent tasks of a plan run at the same time, each in its own worktree

A planned mission whose graph has independent tasks (tasks side by side in a layer) can run them at the same time. Each gets its own git worktree and its own Claude Code process. Spark checks each one in its worktree and brings its changes back to the working tree one by one. A task whose changes collide with another's runs again in the main tree after it. This is sub-project 6 of the command-center spec (`FutureAdd-onns_Prompt.txt`, sections 6.2 to 6.4). It is **off by default**: parallel work costs more and can collide, so the person turns it on per mission (§6.2: "Avoid unnecessary parallelism").

## Turning it on

The review card of a planned mission has **Run independent tasks at the same time (up to 3)**. It shows only when the plan has a layer with two or more tasks. It is off unless ticked, and the approval sends it as `parallel: true`. The mission keeps it.

## How a parallel layer runs

When the main thread reaches a point where two or more tasks are ready (all their dependencies done), and the mission is parallel:

1. **The base:** Spark pins the working tree as it is, `refs/spark/missions/<id>/layer-<n>`. Every worker starts from that commit, so each sees the earlier tasks' changes, uncommitted ones included.
2. **One worker per ready task, up to 3:**
   - a worktree at `%APPDATA%\spark\worktrees\<mission>-<task>`, on branch `spark/<mission>/<task>`, outside the repo so the project's own test runner never sees it
   - the main tree's `node_modules` linked in, as for Spark's agents
   - a Claude Code process with the same model and permission bridge as the window's
   - the task's message as its only turn

   More ready tasks than 3 wait for a free slot.
3. **When a worker's turn ends**, Spark runs the task's check in that worktree, by the verification engine's rules. A failure goes back to the worker once, with its tail, as in the main tree. A second failure fails the task, and the mission is blocked when the layer is done.
4. **Bringing a task back:** a task that passed (or has no check) is committed in its worktree, and its diff from the base is applied to the main working tree with `git apply`.
   - If the diff applies, the task is done, with its files.
   - If it doesn't (another worker changed the same lines first), the task is marked *collided*. It runs again in the main tree, in the normal one-turn way, once the layer's workers are done.
5. **Cleanup:** the worktree and branch are removed when the task is brought back or fails. A worker that never started leaves nothing.

The main Claude Code session takes no turns while a layer's workers run. After the layer, the mission carries on in the main tree with the next ready task.

**Stopping:** ■ or Cancel stops every worker's process, keeps their worktrees for inspection until the mission ends, and records each running task as stopped. Resume runs stopped tasks again.

## What the person sees

- **Permission cards:** a worker's cards are labelled with its task (*task t2 asks: Bash npm install*). The person's "always allow" answers apply to workers too.
- **The graph:** running tasks show *running in parallel*, and a collided task shows *collided, runs again after*.
- **The task panel:** for a parallel task, it shows its worktree path and its own timeline.
- **The report:** the Tasks section says which tasks ran in parallel and which collided.

## Records

Task records gain `worker: true` for a task run in a worktree, and the event `collided`. Worker events (tool calls, results, turns) are recorded with `task: <id>` so each task's timeline is its own.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/plan.ts` | `readyTasks(tasks, states)` (all, not just the first); `collided` in task states. |
| `plugin/hooks/mission.ts` | `Mission.parallel`; task records' `worker` and `task` fields. |
| `app/lib/workers.js` | Worktree setup, a worker's Claude Code process, its check, bringing it back by `git apply`, cleanup, stop. |
| `app/lib/mission-runner.js` | The layer loop: start workers, gather their ends, fall back to the main tree on a collision. |
| `app/main.js` | Workers' processes, their permission requests through the bridge, stop on ■ and on quit. |
| `app/renderer.js`, `missions-view.js` | The toggle, the labelled cards, and parallel states in the graph and panel. |

## Not covered

- The terminal: worker processes need the app's process management. Terminal missions keep running tasks one at a time.
- Competing implementations of one task (§6.4), and roles per task.
- Merging with git's three-way machinery. A diff that doesn't apply cleanly runs again in the main tree rather than being merged by hand.
