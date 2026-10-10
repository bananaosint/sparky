# Sparky

Spark is a standalone Windows app for coding with Claude: its own vibrant window, not a terminal. Claude Code does the work underneath; Spark gives it a new face.

![Sparky](assets/sparky.png)

## Why Spark

Claude Code does the work. Spark handles what's around it:

- **Clearer prompts:** Gemini turns a rough prompt into a clear one and lists what Claude should ask before starting. You see and edit every rewrite before it's sent.
- **Rules that stick:** Spark's rules (ask before guessing, test first, build only what was asked, no filler) go with every request, not just the first.
- **Undo that covers the shell:** before each prompt Spark snapshots the working tree, including files that shell commands changed, which Claude Code's `/rewind` misses.
- **Changes you can see:** the diff pane and band show what each turn changed; `/sandbox` ends every turn with keep or revert.
- **Failures one key away:** a command that fails under `spark try` in your own terminal lands in the prompt box with secrets stripped.
- **Contained subagents:** at most two at a time, no nesting, and a worktree merges only after its tests pass.

## Install

One line in PowerShell:

```
irm https://raw.githubusercontent.com/bananaosint/sparky/main/install.ps1 | iex
```

It installs Claude Code too if it's missing, downloads the latest Spark installer from [Releases](https://github.com/bananaosint/sparky/releases), installs it for your user (no admin rights; Start Menu and desktop shortcuts) and opens it. If Claude Code is new on the machine, run `claude` once in a terminal to sign in. Or download `Spark-Setup-<version>.exe` from Releases and run it.

## The app

- **Its own look:** pixel-art Sparky assembles on the welcome screen and stays alive: his eyes follow your mouse and watch you type, he works with crackling antennas while Claude runs, cheers when a turn lands, goes ×_× and smokes when one fails, jumps at permission questions, swirls while Gemini cooks, dozes off with floating z’s when left alone, and giggles when you click him (five quick clicks overloads him). He wears the hat of the model answering: a crown for Opus, a beret for Sonnet, a blossom for Haiku, a star for Gemini. Ultraviolet or teal gradient themes (◐ in the header), glass panels, glowing composer.
- **Chat, not a terminal:** Claude's answers stream in as formatted text; every tool call is a card (shell commands, edits as diffs, file writes, searches, to-do lists) you can open for details and output.
- **You approve tools:** when Claude wants to run a command or change a file, a card asks: Allow, Always allow (that tool, this chat), or Deny. Settings can let file edits through without asking.
- **Gemini cooks your prompt:** Enter sends your words to Gemini, which rewrites them clearly (with a suitably dramatic role); the rewrite lands in the box to edit, Enter again sends it, Esc restores yours, a leading `\` skips it. Add a Gemini API key in ⚙ settings ([free key](https://aistudio.google.com/apikey)); it's stored encrypted for your Windows account.
- **Images:** Ctrl+V pastes a screenshot into the message, or drag an image in.
- **Skills:** Gemini (flash-lite) picks which of your installed skills Claude should use; they show as chips above the box and ride along in a `Skills:` line.
- **Models:** the **Power Core** next to the box picks who answers: Auto, Claude Opus, Sonnet or Haiku, each a card with its own Sparky, or **Gemini · quick answers** for fast replies that never touch your files or your Claude plan. Drag the effort bar from low to max (arrow keys work; hovering previews how charged Sparky gets); `/model sonnet` and `/effort high` still work. Every switch charges Sparky up.
- **Modes:** `/antislop` (also `/red-team`, `/grillme`) turns a Spark mode on for every message; its chip turns it off. Other `/commands` go straight to Claude Code.
- **What it costs, and who pays:** after each turn: the API-rate price Claude Code reports, the model, tokens in and out, tool calls, and whether it counts toward your Claude plan (not billed per message) or is billed to an API key. Gemini answers say they run on your Gemini key's project.
- **Header:** the folder you're in, the model answering, the effort level.
- **Settings:** turn off Gemini's rewriting, its skill picks, or both.
- **Folders and chats:** the header button opens another project folder; ＋ New starts a fresh chat; ■ stops Claude mid-turn and keeps the conversation.

Spark keeps Claude Code's own configuration, sign-in, and Spark's guardrails (MISP rules, snapshots) underneath.

## Terminal version

The `spark` command runs Claude Code in your terminal with the same Gemini cooking, modes and Sparky look:

```
npm install -g github:bananaosint/sparky
spark install      # Windows Terminal profile and shortcuts
spark key set      # your Gemini API key
spark              # in any project folder
```

Use a key from a billing-enabled Google project. On the free tier, Google may use prompts to improve its products and human reviewers may read them.

## Use

Run `spark` in any project folder. Claude Code starts as usual, with Spark loaded.

1. Type a prompt and press **Enter**. The band above the prompt shows `cooking`.
   - Gemini rewrites the prompt and opens it with a role for Claude, wildly exaggerated but on topic: "Act as a senior web developer with 200 years of programming and UI/UX development."
   - The rewrite tries `gemini-3.6-flash`, `3.5-flash`, `3-flash-preview`, `3.1-flash-lite`, `gemma-4-31b-it`, then the slow `3.7-flash` and `3.8-flash`, moving on when one is out of quota or failing. The band says which one answered.
   - `gemini-3.5-flash-lite` (then `gemini-3.1-flash-lite`) picks up to seven of your installed skills, or none. If the work needs a skill you don't have, it searches [skills.sh](https://skills.sh/) (the registry behind `npx skills find`) and suggests up to three with 1K+ installs.
   - Both run at once. Each model gets three tries of up to 10 seconds (the timeout) before the next one is asked; press Enter any time to send your prompt as typed instead.
2. The rewrite replaces your text in the prompt box. The role is the first line. Any open questions appear as "Ask me before starting:" lines, chosen skills as a `Skills:` line, and suggested installs as an "Install these skills first" list that Claude installs with `npx skills add <id> -g -y`. Delete any you don't want. Edit anything.
3. Press **Enter** again to send it to Claude.

Images: copy one and press **Ctrl+V** (or Claude Code's own **Alt+V**); Spark turns Ctrl+V into an image paste when the clipboard holds an image. When you send a prompt with an image, Spark asks whether to promptify it with Gemini: pick Promptify and you get Gemini's version to send or skip; either way the image stays attached. Gemini sees only your text, not the image.

These prompts are sent as typed instead:
- prompts that start with `\`
- Enter while the prompt is still cooking
- prompts under 4 words
- slash commands
- prompts typed while Claude is working
- prompts with pasted text

| Command | Effect |
|---|---|
| `/spark-diff` | Pane with what this turn changed, per file |
| `/sandbox` | Toggle: each turn ends with keep or revert for everything it changed |
| `/spark-restore [N]` | List turn snapshots, or restore one (asks first; the current state is snapshotted, so it can be undone) |
| `/spark-fix` | Send the last failed `spark try` command to Claude |
| `/goal <goal> [--time 30m] [--tokens 500k]` | Work toward a goal: after each turn Gemini compares the changes with the goal and puts the next step in the prompt box (Enter sends it, or edit it). Ends when you press `6` (goal met) or `7` (stop), or at the time or token limit, counted across the whole goal. `/goal` shows progress, `/goal stop` ends it |
| `/spark-agents` | Pane with subagents and worktrees; test a worktree, then merge it once its tests pass |
| `/spark-unhalt` | Lift a halt once the post-mortem is written (see Guardrails) |
| `/thinking-red-team` | Toggle adversarial security review of proposed changes |
| `/grillme` | Toggle grill mode (also runs your grillme skill) |
| `/anti-slop` | Toggle removal of needless abstractions and filler |
| `/spark-modes` | Show active modes; `/spark-modes off` clears them |
| `/plan` | Claude Code's plan mode |

The model chains (comma-separated, tried in order), thinking level, skills.sh search, word threshold and timeout are in `/config` under spark.

### Sparky in the band

The band above the prompt starts with Sparky's face, which changes with the session: `ϟ(◕▾◕)ϟ` idle, `ϟ(◕ω◕)ϟ` cooking, `ϟ(^▾^)ϟ` cooked, `ϟ(◔▾◔)ϟ` working, `ϟ(◉_◉)ϟ` waiting for your keep/revert, `ϟ(×_×)ϟ` a failed command. It changes only when the state does, so it never redraws on a timer. `--plain` and `NO_COLOR` show `✦ spark` instead. After a turn, the band also shows `n files +a −d`.

Band buttons answer a bare digit typed into the empty prompt: `1` keep, `2` revert, `3` diff (sandbox review); `4` send to Claude, `5` dismiss (failed command).

### Snapshots

Before each prompt in a git repo, Spark saves the whole working tree, untracked files included, as `refs/spark/turn-N`. It uses its own index (`.git/spark-index`), so your staging area, stash and branches are untouched, and it keeps the last 20. Unlike Claude Code's `/rewind`, this covers files changed by shell commands. Database or network side effects can't be undone.

### Failed commands from your own terminal

```
spark try npm test
```

runs the command with its output as usual. If it fails, Spark records it in `.git/spark-failure.json` and the band turns red within two seconds: `✗ npm test failed (exit 1)`. Press `4` (or run `/spark-fix`) and the failure lands in the prompt box with colors, passing tests and secrets stripped, ready to cook. A passing run clears it.

### Agents and worktrees

`/spark-agents` lists subagents with their status and the repo's other worktrees. `test` links the main tree's `node_modules` into the worktree if it has none and runs its test command (npm, pnpm, yarn, bun, cargo, go or pytest, picked from the files there). `merge` appears once tests pass; it refuses if the worktree changed since, commits what the agent left uncommitted, and merges its branch with `--no-ff`. A conflicting merge is aborted.

Launcher flags:
- `--plain`: no banner, theme or spinner verbs
- `--no-gemini`: send every prompt as typed this session
- `--no-tests`: don't run the tests when Claude ends a turn that changed files
- `--direct`: run Claude Code without Spark's terminal layer (its own mascot shows again)
- `--no-anim`: skip Sparky's startup animation

Two looks: `spark theme` shows the current one, `spark theme teal` switches to teal and electric green, `spark theme ultraviolet` switches back. The choice is saved in `%APPDATA%\spark\config.json` and colors the intro, Sparky in the header, the band and the Claude Code theme from the next `spark`; the Windows Terminal background changes after Windows Terminal restarts.
- Anything else, or everything after `--`, goes to `claude`. For example, `spark -c` continues the last session.

## What it protects and what it doesn't

- **On disk:** a key you store with `spark key set` is encrypted with DPAPI, so other Windows accounts can't read it.
- **In the session:** the mod unsets the key from Claude Code's environment at startup, so shell commands Claude runs don't inherit it. Neither measure stops a process running as you.
- **What leaves your machine for Gemini:** your typed prompt, with secrets swapped for `«secret-N»` placeholders, and your skills' names and descriptions. The placeholders are swapped back before the rewrite lands in the box.
- **What leaves your machine for skills.sh:** up to two short keyword queries (60 characters at most) that Gemini writes from your redacted prompt, such as `playwright e2e`. Not the prompt itself. Turn it off with "Search skills.sh" in `/config`.

## Guardrails

These run in every Spark session, in the terminal and in the app. The design is `docs/design/2026-10-09--spark--design.md`.

- **Command gate (F1):** before a Bash or PowerShell command runs, Spark reads every command in it: quotes respected, each part of a `&&`, `;` or `|` chain, and the string inside `bash -c` or `powershell -Command`.
  - **Blocked:** recursive deletes outside the repo or of your home folder or a drive root, force pushes to main or master, downloads piped into a shell, encoded PowerShell, `Set-ExecutionPolicy`, registry writes (`reg add`/`reg delete`, HKLM), `format`/`diskpart`/`bcdedit`, and anything that touches Spark's config or Claude Code's credentials.
  - **Asked first, with a dry run where one exists:** deletes and moves (how many files, and the first ten), `git clean` (`git clean -n`), `git reset --hard`, `git checkout -- .` and `git restore` (`git diff --stat HEAD`), rebases, pushes and `git branch -D` (the commits at stake), package installs, network commands, and `-Force`. Each dry run gets 1.5 seconds; past that you see the raw command.
  - The gate never allows anything itself: what it lets through still meets Claude Code's own permissions. It reads text, so an obfuscated command can get past it. In the app, the approval card shows why the gate asks (not the dry run), and "Always allow" never covers a command the gate asks about. In Claude Code's auto mode, the auto-mode classifier answers the gate's questions instead of you.
- **Test gate (F4):** when Claude ends a turn that changed files (shell commands' changes included) and its last message isn't a question, Spark runs the tests. A failure sends Claude back with the last 60 lines of output. The command is your own from `repos` in `%APPDATA%\spark\config.json`, keyed by the repo's path and never read from the repo itself; otherwise the repo's files pick one (npm, pnpm, yarn, bun, cargo, go or pytest; npm's "no test specified" placeholder doesn't count). In a folder you opened safely in the app, only your own configured command runs, never the folder's own script. If `package.json`'s `test`, `pretest` or `posttest` script changed during the turn, Spark doesn't run it and says so. A run gets five minutes. `spark --no-tests` turns the gate off for a session.

  ```json
  { "repos": { "C:\\code\\invoice-app": { "test": "npm test -- --reporter=dot" } } }
  ```
- **Halt after two failures (F10):** two failed test-gate runs or builds in a row halt the session. A command line counts as a build when its last command is one: `npm run build` (and `build:*`), `pnpm build`, `yarn build`, `tsc`, `vite build`, `dotnet build`, `msbuild`, `cargo build` or `go build`. Edits are denied except under `docs/postmortems/`, commands the gate would ask about are blocked, and every prompt carries `<spark-halt>`. Run `/spark:postmortem` to have Claude write the post-mortem, then `/spark-unhalt`, which works once a post-mortem newer than the halt exists.
- **Leaner context (F5):** a successful command's output over 200 lines reaches Claude as its first 40 and last 120 lines, colors stripped and progress redraws collapsed. The full output is saved to `.spark/out/<id>.txt`, which Spark adds to `.git/info/exclude`. Claude can't Read lockfiles, minified files, or anything under `node_modules`, `dist`, `build` or `obj`.
- **Saved plans (F7):** a plan you approve in plan mode is saved to `docs/design/YYYY-MM-DD--<title>--design.md` at the repo root.
- **UI taste (F8):** the `spark:ui-taste` skill sets rules for type, space, color, copy and empty/loading/error states, with a screenshot check at 375 and 1440 px. Spark's rules tell Claude to load it for UI work.
- **Reviewed agents (F2):** `spark:implementer` works in its own git worktree, test first. `spark:compliance-reviewer` reads the branch with read-only tools and ends with `VERDICT: PASS <branch>` or `VERDICT: FAIL <branch>`. Spark records the verdict for the branch's commit at that moment and blocks `git merge` or `git cherry-pick` of an agent worktree's branch without a PASS for its current commit.
- **Restore points (F6):** the snapshots above.

## Checks you run

- **`spark scan` (F9):** runs [osv-scanner](https://github.com/google/osv-scanner/releases) over the repo if it's installed, and flags lines in your uncommitted changes and untracked files that read like instructions to an AI ("ignore previous instructions", `<system>` tags). It flags; it never blocks. For a code review of the changes, run `/security-review` in a session. It exits with 1 when it found something.
- **`spark map` (F3):** lists the calls between functions in the JS/TS files changed since the last snapshot, with callees in the same file or in a file it imports. It reads the source as text, so calls through objects, aliases or dynamic dispatch don't show.

## Develop

The app lives in `app/` (Electron): `cd app && npm install && npm start` runs it from source, `npm run dist` builds `app/dist/Spark-Setup-<version>.exe`, `npm test` runs its tests.


```
npm install     # dev dependencies (TypeScript)
npm test        # launcher (node:test) + mod (claude plugin test)
npm run check   # type-check the mod and run claude plugin validate
```

The mod uses Claude Code's early-access mod API (`plugin/hooks/register.tsx`). Run `npm run check` after Claude Code updates.

To edit the mod with hot reload, keep a session open with `claude --plugin-dir plugin`. It reloads on save.

Design: `docs/design/2026-10-09--spark--design.md`.
