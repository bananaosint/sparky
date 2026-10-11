# Changes: checkpoints to inspect and restore, in the app

The app gets a **Changes** view, the window's counterpart of the terminal's `/spark-diff` and `/spark-restore`. It lists Spark's checkpoints:

- **Turn snapshots:** the 20 kept at `refs/spark/turn-N`, taken before each prompt, shell changes included.
- **Mission pins:** the snapshots missions pin at `refs/spark/missions/<id>/start`, `/task-<t>-<attempt>` and `/end`.

For any checkpoint it shows what changed since then, file by file with the diff, and whether the tests passed on exactly that code. It can restore the working tree to that checkpoint, after showing which files will change. The current state is saved first, so a restore can be undone. This is sub-project 5 of the command-center spec (`FutureAdd-onns_Prompt.txt`, sections 13 and 14: time-travel and the visual diff). Branches, commits and pull requests are not part of it.

## The list

Checkpoints come newest first, each with:
- **Its time.**
- **What it is:**
  - for a turn, *before: <the prompt's first 60 characters>*, redacted
  - for a mission pin, *Mission "<title>" started*, *task t2 of "<title>" ended (attempt 1)* or *Mission "<title>" ended*
- **A test mark:** *tests passed on this code* when a passing test-gate run in `.spark/gate.jsonl` has that checkpoint's tree; *tests failed on this code* when the last run on that tree failed. Nothing otherwise.

A folder outside git says *Checkpoints need a git repository; this folder isn't one.* A repo with none yet says that checkpoints appear once you send a prompt.

## A checkpoint

Selecting one shows **Since this checkpoint**: every file that differs between it and the working tree now.
- Each file has its kind (modified, new, deleted, binary, lockfile) and its +/− counts.
- A modified file opens to its diff, with lines colored by `+`, `−` and `@@`. Long diffs scroll.
- When nothing differs, it says *The working tree matches this checkpoint.*

## Restore

**Restore to this checkpoint** first shows a confirmation:
- **What changes:** "Restoring makes these N files match the checkpoint", then the list in three kinds:
  - files changed since are put back
  - files added since are deleted
  - files deleted since come back
- **The safety net:** "Spark saves the current state as a checkpoint first: restore that one to undo." Files git ignores are never touched.
- **The choices:** Restore or Cancel.

After a restore the view says which checkpoint holds the state from just before, with a button to restore it.

Restore is refused while any of these is going on, because each would race it: Claude is working on a turn, a mission is live or its checks run, or a marathon runs. The refusal names which one. A council's brief only reads files, so it doesn't block a restore.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/checkpoints.ts` | Pure: `checkpointList(snapshots, pins, missions, gates)` merges, labels and marks tests; `restorePlan(diffs)` gives the confirmation's three lists. |
| `plugin/hooks/snapshot.ts` | `restoreSnapshot` takes any checkpoint (a sha and a label), not only a turn snapshot. |
| `app/lib/checkpoints.js` | Git and file IO: list (turn refs, mission refs, `gate.jsonl`), changes (`fileDiffs`), restore (only a sha from the list). |
| `app/main.js`, `app/preload.cjs` | IPC `checkpoints`, `checkpoint-changes`, `checkpoint-restore`, and the busy refusal. |
| `app/lib/changes-view.js`, `app/index.html`, `app/styles.css` | The view. |

## Not covered

- Browsing whole files at a checkpoint (the diff shows what changed, with context).
- Branches, commit preparation, commit messages, pull requests and merge help (section 14's other items).
- Pruning mission pins. They stay until the person deletes them with git.
