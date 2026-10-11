# Missions: recorded, reviewable work in the app

`/mission <objective>` has Claude read the project and draft acceptance criteria, you edit and approve them, then Claude does the work while Spark records what actually happens. The mission ends with a report built only from those records. Missions survive an app restart and can be resumed.

This is sub-project 1 of the command-center spec (`FutureAdd-onns_Prompt.txt`). Later sub-projects build on its records: Council mode, a verification engine that runs checks itself, a planner with a task graph, a changes and checkpoints panel, and parallel workers.

## What the user asked for

- From the spec: a mission with an objective, acceptance criteria, a status and a final report; a persistent timeline fed by real execution events; history that survives restarts; cancellation that really stops the work; no invented progress, results or costs.
- Decided with the user: the app first, and the terminal gets what the plugin API allows. Missions start explicitly (`/mission`, or the Missions view); plain chat is unchanged. Claude drafts the criteria in a read-only turn; you edit and approve them. `/marathon` and `/goal` stay as they are. Records are JSONL under `.spark/` in the repo, with no database and no new dependencies.

## Behavior

### Lifecycle

| Status | Meaning | Moves to |
|---|---|---|
| `draft` | Claude is reading the project and drafting criteria. Read-only. | `review` when its turn ends; `interrupted` |
| `review` | The criteria card waits for you. | `running` (Approve), `cancelled` |
| `running` | Claude is working. | `waiting`, `paused`, `finished`, `blocked`, `cancelled`, `interrupted` |
| `waiting` | Claude's last message ended in a question. | `running` when you answer in the chat; `paused`, `cancelled`, `interrupted` |
| `paused` | You pressed ■. | `running` (Resume, or you write to Claude), `cancelled` |
| `interrupted` | Claude Code exited, New chat, a folder change, or the app closed mid-mission. | `running` (Resume), `draft` (Resume of a mission that was never approved), `cancelled` |
| `finished`, `blocked`, `cancelled` | Final. | none |

One mission is active per window. `/mission` while one is active, or while a marathon runs, says so and does nothing; a marathon can't start during a mission either. Missions need Claude Code: with Gemini or Auto picked, `/mission` asks you to pick a Claude model or UltraCode.

### Draft

Spark switches the running session to plan mode with Claude Code's `set_permission_mode` control request. While the mission is in `draft`, the permission bridge also denies edit tools, Bash, PowerShell and `ExitPlanMode`, whatever "always allow" or auto-accept edits say. The bridge is only asked about what Claude Code would ask about: the end-to-end run showed plan mode letting a read-only `git ls-files` through without asking, which is fine for a draft that only reads. Plan mode is Claude Code's own enforcement, and the bridge is Spark's. Checked against Claude Code 2.1.296: `set_permission_mode` to `plan` and back to `default` both succeed without a restart. If a later version refuses it, the bridge rule holds alone and the timeline records the refusal.

The draft message gives the objective and asks for a short interpretation, then a fenced `mission` block:

````
```mission
{"title": "Rate-limit the login route",
 "criteria": [{"text": "A sixth failed login within a minute returns 429", "how": "a new test in test/auth.test.js"},
              {"text": "Existing auth tests still pass", "how": "npm test"}]}
```
````

Each criterion needs a `how`: a test, a command, or `manual` when it needs a person to judge. When the draft turn ends, the session goes back to the default permission mode and the mission moves to `review`.

### Review

A card in the chat shows the title and an editable criteria list (text and `how`, add, remove), with **Approve and start** and **Cancel**. If no valid `mission` block came back, the card says so and opens with one empty row; Claude's text is still in the chat above it. Your edits are saved, and edited criteria are marked as yours.

### Running

In a git repo, Approve snapshots the working tree and pins it as `refs/spark/missions/<id>/start`, outside the 20-turn pruning. It then sends the run message: the objective, the approved criteria, and how to end. Claude ends by listing what it changed, what it ran, and which criteria it believes are met and how. That list goes into the report labeled as Claude's account, not as verified.

Every event from the stream is turned into a record (see Records). You can still type in the chat during a mission; your messages are recorded too. When a turn ends:

- the turn failed (`result.ok` false): `blocked`, reason "the turn failed: <text>";
- a halt was recorded since the mission started: `blocked`, reason "halted after two failed test or build runs";
- the last message ends in a question: `waiting`;
- otherwise: `finished`. Spark snapshots the tree as `refs/spark/missions/<id>/end`, builds the report and posts a result line in the chat that links to it.

### The report

The report is built from records only. Claude's own summary appears in its own section, labeled as unverified.

- **Status line.** Finished, blocked, cancelled or interrupted, with the reason. For a finished mission, the test state:
  - *tests passed on this code*: the last test-gate run passed, and its tree equals the end snapshot's tree;
  - *tests failing*: the last test-gate run failed;
  - *tests not run on the final code*: no run, or files changed after the last run;
  - *tests passed; Spark can't tell whether files changed after*: outside a git repo.
- **Criteria.** Each criterion with its `how`, marked *not checked by Spark*. The verification sub-project will check `how` commands; this one doesn't run anything itself. Criteria with `how: manual` are marked *needs you*.
- **Changed files.** `git diff --stat start end` in a repo. Outside a repo, only the files edit tools touched, with a note that shell changes aren't seen.
- **Commands run.** Each command with its exit state.
- **Checks.** Every test-gate run and build with its time and result, plus any halt.
- **Approvals.** How many permission cards appeared, which you allowed and which you denied.
- **Time and cost.** Wall time from approval to the end, the time Claude worked (the sum of turn durations), and the sum of turn costs (at API rates) and tokens as Claude Code reports them. Values Claude Code doesn't report are shown as *not reported*.

### Missions view

A **Missions** button in the header swaps the chat for the Missions view; the button, or Esc, swaps back. The chat isn't touched.

- **Left:** a **New mission** field (an objective; Enter starts the draft, same as `/mission`), then this folder's missions, newest first. Each shows its title, a status pill and its age.
- **Right:** the selected mission.
  - **Header:** objective, status, elapsed time (live while active), tokens and cost so far.
  - **Sections:** Criteria, Timeline (every record with its time; failures expand to their output tail) and Report (once there is one).
  - **Actions:** Cancel, Resume (paused or interrupted) and Back to chat.
- An active mission updates live. With the chat showing, the header status line adds `mission <status> mm:ss`, the way a marathon adds its countdown.

### Restart, stop and resume

- **On opening a folder:** Spark lists its missions. Any in `draft`, `running` or `waiting` that this window isn't running is marked `interrupted` ("Spark closed while it ran"). A `review` mission stays in `review`, since it needs no process.
- **■ during a mission:** stops the turn as today and marks the mission `paused`.
- **New chat or a folder change:** marks the mission `interrupted`.
- **Resume:** restarts Claude Code with `--resume <the mission's session id>` and sends a resume message: the objective, the criteria, "check the current state before doing more; don't redo finished work". A `draft` mission is drafted again instead. If the session can't be resumed, Spark starts a fresh one with the same message and records that it did.
- **Cancel:** stops a turn in flight through the existing stop path, denies any open permission cards, puts the permission mode back, and marks the mission `cancelled`.

### Terminal

The plugin gets `/mission` too, within what the mod API allows. The plugin can't submit a prompt or switch permission mode by itself (see the marathon spec).

- `/mission <objective>` creates the mission and fills the prompt box with the draft message, prefixed with `\` so Gemini doesn't rewrite it. While it's in `draft`, the mod denies edit tools, Bash and PowerShell, as the app's bridge does.
- When the draft turn ends, a pane shows the parsed criteria. `/mission approve` pins the start snapshot and fills the run message.
- Records come from `tool.call` (the tool, its target, ok or failed) and `turn.complete`. The terminal can't see costs, tokens or permission answers, so its report says *not reported* for them.
- `/mission` opens a pane with the status, timeline and report. `/mission cancel` cancels the mission. There is no Resume in the terminal: a terminal mission lives in one session.
- To edit criteria, use the app. In the terminal you approve the draft as it is, or cancel and draft again.

## Records

`.spark/missions/<id>/` holds:

- `mission.json`: id, title, objective, criteria (`text`, `how`, `by`: `claude` or `you`), status, reason, createdAt, approvedAt, endedAt, sessionId, model, startSha, endSha (the pinned snapshot commits), gateOffset;
- `events.jsonl`: one record per line;
- `report.json`: written when the mission ends.

Writes go to a temp file that is then renamed, so a crash can't leave `mission.json` half-written. Spark adds `.spark/` to `.git/info/exclude` the first time it writes there. The plugin already does this for `.spark/out`.

A record is `{ "at": <ms>, "kind": ..., ... }`:

| kind | fields |
|---|---|
| `status` | `from`, `to`, `reason` |
| `you` | `text` (first 500 characters) |
| `tool` | `id`, `name`, `target`: the file path, the command (first 300 characters), the pattern, or the URL |
| `tool-result` | `id`, `ok`; on failure, `tail`: the last 20 lines |
| `permission` | `tool`, `target`, `decision` (`allowed`, `always`, `denied`, or `auto-allowed` / `auto-denied` when Spark answered without a card), `gate`: the gate's reason, if it asked |
| `turn` | `ok`, `durationMs`, `costUsd`, `tokens`, `text` (the final message, first 8000 characters) |
| `gate` | `check` (`tests`, `build`, `halt`), `ok`, `exit`, `tree` |
| `model` | `model` |
| `process` | `event` (`started`, `resumed`, `exited`), `code`, `error` |

Every text field passes through `redact()` (`plugin/hooks/redact.ts`) before it is written, and stays redacted: the placeholders are never swapped back. Spark doesn't keep file contents or full command output.

**Gate records.** The plugin appends each test-gate run, each counted build and each halt to `<repo>/.spark/gate.jsonl` as `{at, check, ok, exit, tree}`. `tree` is the working-tree hash the run saw, from the same private index snapshots use. Spark stores the file's length when a mission starts and reads only lines added after it, so a `gate.jsonl` that shipped with the repo is ignored.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/mission.ts` | Pure and shared by the app and the mod: ids, status moves, record builders (redact and truncate), the `mission` block parser, the draft, run and resume texts, and the report builder. No I/O. |
| `plugin/hooks/snapshot.ts` | `pinSnapshot(run, ref, label)` and `treeNow(run)`. |
| `plugin/hooks/register.tsx` | Writes gate records. Denies edits under `.spark/` at all times. `/mission` in the terminal, with edit tools, Bash and PowerShell denied while a mission is in `draft`. |
| `plugin/hooks/gate.ts` | Commands that name `.spark/gate.jsonl` or `.spark/missions` are blocked, like Spark's config. |
| `app/lib/mission-store.js` | Reads and writes `.spark/missions` and reads new `gate.jsonl` lines. Takes a root folder, so it is tested against temp folders. |
| `app/lib/mission-runner.js` | Runs the lifecycle against the live process, like `marathon-runner.js`: takes stream events, writes messages and control requests, tells the window. Process, store and clock are injected. |
| `app/lib/stream.js` | `setPermissionMode(id, mode)`. |
| `app/lib/commands.js` | `/mission` becomes a `mission` command. |
| `app/main.js`, `app/preload.cjs` | Wire the runner to the stream, the bridge (draft denials, permission records), ■, New chat, folder changes and `mission` IPC. |
| `app/renderer.js`, `index.html`, `styles.css` | The criteria card, the Missions view, the header status. |

## Security

| Input that triggers it | Impact | Handling |
|---|---|---|
| A repo that ships `.spark/missions/x/mission.json` with HTML or odd fields | Script in the window, or a crash | Mission files are validated against the schema; anything else is listed as unreadable. Text is rendered with `textContent`. Claude's summary goes through the same DOMPurify path as chat. |
| A mission id like `..\..\x` sent over IPC | Reads or writes outside `.spark/missions` | Ids must match `^m-\d{8}-\d{6}-[0-9a-f]{4}$`, and IPC acts only on ids the store lists. |
| A crafted `sessionId` in `mission.json` | Odd arguments passed to `claude` | It must be a UUID, or Resume starts a fresh session. `spawn` takes an argument array, with no shell. |
| Claude appends a fake passing line to `gate.jsonl` | The report claims tests passed | Edits under `.spark/` are denied, and commands naming the file are blocked. The gate reads text, so an obfuscated command can still get through (see Not covered). |
| Secrets in commands, tool output or messages | Secrets kept on disk in `.spark/` | `redact()` runs on every text field. Only error tails are kept, never full output. |
| A draft turn that writes anyway | Changes before approval | Plan mode plus bridge denials. Changes made before approval fall inside the start snapshot, so they show only as tool records in the timeline, not under Changed files. |

## Not covered

- Spark checks no criterion itself. The verification sub-project runs `how` commands from the app, which also closes the fake-gate-record gap.
- A shell command written to get past the text-reading gate could still append to `gate.jsonl`.
- The plugin appends to `gate.jsonl` by reading the file and writing it back. That is safe because the plugin is its only writer and the app reads only after the Stop hook has returned. A second concurrent writer would need a real append.
- Restoring a mission's start snapshot from the window is part of the changes and checkpoints sub-project. The refs are kept for it.
- Missions are per folder; there is no cross-project list.
- Terminal missions have no cost, token or permission records, no criteria editor, and no Resume.
- Time spent on a permission card counts toward the elapsed time.
- The end snapshot is taken just after the last turn. A chat message queued right behind it can change files before the snapshot runs. The report then errs to "tests not run on the final code".
- Test-gate runs from chat turns while the criteria wait for approval count toward the mission's Checks.

## Tests

- `plugin/test/mission.test.ts`: status moves, record builders (redaction, truncation), the `mission` block parser (valid, missing, malformed, extra text), report building for each test-state case, and the draft, run and resume texts.
- `plugin/test/` for gate records, the `.spark/` blocks and terminal `/mission`, using the fake engine already in `plugin/test/fake.ts`.
- `app/test/mission-store.test.js` against temp folders: atomic writes, listing, unreadable files, the gate offset, id checks.
- `app/test/mission-runner.test.js` with a fake process and clock: draft → review → running → finished, question → waiting, ■ → paused, exit → interrupted, halt → blocked, cancel, resume with an invalid session id.
- End to end: a headless mission on haiku in a scratch repo with one failing test. Its records, `gate.jsonl` lines and report are checked by hand against what happened.
- The Missions view: screenshots at 720 and 1440 px wide, per `spark:ui-taste`.
