# Verification engine: Spark runs the checks itself

When a mission ends, Spark runs the project's checks and each approved criterion's command itself, records what really happened, and turns the report's "not checked by Spark" into pass, fail, or not run with the reason. This is sub-project 3 of the command-center spec (`FutureAdd-onns_Prompt.txt`, sections 5.3 and 9). It closes the gap missions left open: the test gate's records come from a hook Claude's shell could in principle imitate, while these checks run from the app (and the mod) directly.

## Behavior

**When.** A mission that ends `finished` or `blocked` gets a verification pass before its report. The Missions view has **Check again** for any ended mission, which verifies the working tree as it is now and says so.

**What runs.** Two kinds of check, planned by a pure function from the repo's files, Spark's config and the mission's criteria:

| Check | Command | Runs when |
|---|---|---|
| Tests | the person's `repos[<path>].test`, else what the test gate picks (`npm test`, `cargo test`, `go test ./...`, `python -m pytest`, …) | always, as the test gate does |
| Type check | `repos[<path>].typecheck`, else `npm run typecheck` (or `check`) when package.json has that script | the script or setting exists |
| Lint | `repos[<path>].lint`, else `npm run lint` | the script or setting exists |
| Build | `repos[<path>].build`, else `npm run build` | the script or setting exists |
| Each criterion whose `how` is a command | the `how` text | see below |

A criterion's `how` counts as a command when its first word is a known runner: `npm`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `python`, `python3`, `py`, `pytest`, `cargo`, `go`, `dotnet`, `make`, `mvn`, `gradle`, `tsc`, `vitest`, `jest`, `mocha`. `npx` is not on the list, because it can download and run packages. Anything else, such as `manual` or "a new test in test/auth.test.js", is a check for the person.

**What never runs.**
- In a folder opened safely (untrusted), only the person's own configured commands run. The folder's own scripts and the criteria's commands are shown as *not run: the folder is untrusted*. This is the test gate's rule.
- A command Spark's gate would block or ask about is *not run: the gate would ask (reason)*: network, installs, deletes, chains with any of those. The person approved the criteria, but not a command the gate flags.
- A package.json script that changed during the mission (the start snapshot against the files as they are when the checks run, `pre` and `post` scripts included) is *not run: the script changed during the mission*. That covers a criterion whose command runs the script too, such as `npm test -- auth`.
- With no start snapshot (not a git repo), Spark can't tell whether a script changed, so the folder's scripts are *not run: Spark can't tell whether the script changed*. The person's configured commands still run.

**How it runs.** One check at a time, in the repo top folder, through `cmd /d /s /c`, with 5 minutes each. It records the exit code, the time taken, the tree hash it ran on, and the last 40 lines of output, redacted. The full output, redacted, goes to `.spark/missions/<id>/checks/<n>.log`. Checks append `check` records to the mission's timeline: `{ at, kind: 'check', name, command, status: pass|fail|timed-out|not-run, exit?, ms?, tree?, reason?, tail? }`.

## The report

A **Proof of completion** section at the top lists each check with its status and a link to its log. The criteria lines change from *not checked by Spark* to:
- *passed (`npm test -- auth`)*
- *failed (exit 1)*
- *not run: <reason>*
- *needs you*, for manual criteria

The status line gets a verdict, computed from the checks only:

| Verdict | When |
|---|---|
| **Verified** | every planned project check passed, every command criterion passed, and no criterion needs a person |
| **Needs review** | everything that ran passed, but something didn't run or a criterion needs a person |
| **Checks failed** | any check failed or timed out |
| **Not verified** | nothing could run |

The verdict never comes from Claude's account, and "Verified" still means only that these checks passed.

## Terminal

The mod runs the same plan through `$.process.run` when a terminal mission ends, and the pane shows the same section.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/verify.ts` | Pure: `planChecks(files, packageJson, config, criteria, { trusted, changedScripts, classify })`, `isCommandHow`, `verdict(results, criteria)`, the check record and row. |
| `plugin/hooks/mission-report.ts` | The Proof of completion section, criteria states and the verdict in the status line. |
| `app/lib/verify-run.js` | Runs a plan with a timeout per check, saves the logs. |
| `app/lib/mission-runner.js` | Verifies before the report, and Check again. |
| `plugin/hooks/register.tsx` | The same for terminal missions. |

## Not covered

- Checks run one after another, so a slow suite makes the report wait. Its timeout bounds that.
- Spark doesn't judge whether a criterion's command actually tests what the criterion says; the person approved that pairing.
- An independent code review (spec 9.2's "Independent code review") is out of this pass.
