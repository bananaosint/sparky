# Marathon sessions: work for a set time or token budget

`/marathon <task> [--time 1.5h] [--tokens 2m]` keeps Claude working on a task in short review passes until the time or token budget is spent, even when the task looks finished. When passes stop finding anything, Spark moves Claude to the next stronger model.

## What the user asked for

- A set work duration (1.5 hours) with Claude refining and reviewing until the time is up, even if the task looks done.
- A token budget (up to 2 million).
- Automatic switching to a higher-tier model when needed.

Decided with the user: the rules go in Spark's always-on rules (`misp.ts`) and the budgets in a new `/marathon` command, in the app and the terminal. Models step up one tier at a time, never down; Fable is opt-in.

## Behavior

- **Time** is a minimum of work: Claude is kept going until it runs out. A pass already running is not cut off; the limit is checked when a turn ends.
- **Tokens** are a cap. The marathon ends at the end of the turn that crosses it. Counted as `/goal` counts them: input + output + cache writes, never cache reads.
- The first limit reached ends it. A missing flag uses the `/goal` default (30m, 500k). Same flag grammar as `/goal`: `90s`, `45m`, `1.5h`; `200k`, `2m`.
- **Passes.** When a turn ends, Spark sends the next pass: one narrow review lens (requirements, bugs, tests and build, simplify, attack, docs and names, then around again). A pass changes code only for a requirement or a failing test, and answers `Nothing found.` otherwise. Open-ended "keep improving" would fight Spark's own YAGNI rule.
- **Questions.** If Claude's last message ends with `?`, no pass is sent. The marathon resumes at the end of the turn after the user answers.
- **Step up.** A pass with no edit-tool calls is idle. After 2 idle passes in a row, with at least half of both budgets left, Spark switches to the next tier: haiku, sonnet, opus, then fable only if `marathonTop` is `"fable"` in `%APPDATA%\spark\config.json`. Never down. A failed switch is reported and the marathon carries on. When the marathon ends, the model selected before it is restored.
- **Backoff.** A real run on haiku with nothing left to find sent 22 passes in 90 seconds, 78k tokens of "Nothing found." At that rate 2M tokens would end a 90-minute marathon at about 30 minutes. So idle passes that cannot step up (already on the strongest model allowed, or under half the budget left) wait 15s, then 30s, 60s and so on, at most 5 minutes, and the wait never runs past the time limit. An edit, a step-up or a user message starts the pace over.
- **Ends** at a limit, on a failed turn, on ■, on New chat or a folder change, or when Claude Code exits.
- **Cost, stated plainly.** Every switch re-reads the whole conversation at full price, because the prompt cache belongs to one model. Passes on an unchanged project cost money and find nothing; the time limit is the only bound on them.

## Where it lives

| Piece | Role |
|---|---|
| `app/lib/marathon.js` | Pure policy: parse, state, what to do when a turn ends, the pass and session texts. No I/O. |
| `app/lib/stream.js` | `control_response` lines become `control` events. |
| `app/lib/commands.js` | `/marathon` becomes a `marathon` command. |
| `app/lib/marathon-runner.js` | Runs the policy against a live process: reads the stream, writes passes and `set_model` requests, schedules the backoff, tells the window. Process, window and clock are injected, so it is tested without Electron. |
| `app/main.js` | Creates the runner and hands it the stream, the user's messages and restarts. |
| `app/renderer.js` | Starts and stops it, shows time and tokens left in the header, notes each pass. |
| `plugin/hooks/misp.ts` | Rule that explains `<spark-session>`. |

`set_model` is Claude Code's headless control request (`{"type":"control_request","request_id":"..","request":{"subtype":"set_model","model":"opus"}}`). Checked against Claude Code 2.1.296: `opus`, `haiku`, `fable`, `default` and no model at all succeed; an unknown model returns an error. No restart and no lost conversation.

## Not covered

- Time spent waiting on a permission card counts. With auto-accept edits off, an unattended run stalls at the first approval.
- Shell commands that change files are not seen as edits, so a pass that only formatted files counts as idle.
- A Spark halt (two failures) is not visible to the app, so a halted marathon keeps sending passes that find nothing.
- The terminal has no `/marathon`. The plugin API has no call that switches the main model (only `PreModelSwitch` and `PostModelSwitch` hooks that watch a switch), and `$.prompt.fill` does nothing headless. A terminal version would need a probe of `$.command.run({command: 'model'})` and `$.prompt.submit` in a live session first.

## Tests

`app/test/marathon.test.js` for the policy, `core.test.js` for the stream and command parsing, `plugin/test/` for the rules text. A real headless run on haiku with a one-minute budget proves the loop end to end.
