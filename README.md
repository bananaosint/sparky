# Spark

Claude Code, launched with a Gemini prompt cook, modes and a Spark look. Windows only.

When `spark` starts, Sparky assembles from scattered pixels, drawn two pixels per character in truecolor. His eyes ignite like a neon tube (flicker, then white-hot cores), the glow bleeds into the pixels around them, he glances left and back, his bolts flash, and the SPARK wordmark sweeps in. It takes under 0.9 s and plays while Claude Code is already starting, so it adds no wait. `--no-anim` shows the final frame only; `--plain` shows nothing.


Sparky Bug, Spark's mascot, greets you in the launcher banner and, as pixel art, at the start of the band in terminals that draw images (Windows Terminal 1.22+). `spark install` adds a Windows Terminal profile named Spark, with Sparky as its tab icon, a dark gradient background and the Spark colors, plus Start Menu and desktop shortcuts with Sparky's icon; `spark uninstall` removes them. Claude Code's own header follows, with Sparky where the mascot was: Spark runs Claude Code in its own pseudo-terminal (`node-pty`) and redraws the mascot's cells as Sparky on their way to your screen. `claude.exe` itself is never touched, so it stays signed and keeps updating. `spark --direct` (or `--plain`) runs Claude Code without that layer.

## Install

Needs Windows, [Node.js 24+](https://nodejs.org), git and [Claude Code](https://claude.com/claude-code). In PowerShell:

```
irm https://raw.githubusercontent.com/bananaosint/sparky/main/install.ps1 | iex
```

The installer checks those three, installs Spark from GitHub, adds a "Spark" Windows Terminal profile plus Start Menu and desktop shortcuts, and asks for a [Gemini API key](https://aistudio.google.com/apikey) (stored encrypted for your Windows account). Without a key Spark still runs; prompts are sent as typed.

By hand: `npm install -g github:bananaosint/sparky`, then `spark install` and `spark key set`. Each [release](https://github.com/bananaosint/sparky/releases) also has a `.tgz` for `npm install -g spark-<version>.tgz`. Update by running the installer again; uninstall with `spark uninstall` and `npm uninstall -g spark`.

Use a key from a billing-enabled Google project. On the free tier, Google may use prompts to improve its products and human reviewers may read them.

### From a clone

```
git clone https://github.com/bananaosint/sparky.git
cd sparky
npm install
npm link            # puts `spark` on PATH (undo: npm unlink -g spark)
```

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
- `--direct`: run Claude Code without Spark's terminal layer (its own mascot shows again)
- `--no-anim`: skip Sparky's startup animation

Two looks: `spark theme` shows the current one, `spark theme teal` switches to teal and electric green, `spark theme ultraviolet` switches back. The choice is saved in `%APPDATA%\spark\config.json` and colors the intro, Sparky in the header, the band and the Claude Code theme from the next `spark`; the Windows Terminal background changes after Windows Terminal restarts.
- Anything else, or everything after `--`, goes to `claude`. For example, `spark -c` continues the last session.

## What it protects and what it doesn't

- **On disk:** a key you store with `spark key set` is encrypted with DPAPI, so other Windows accounts can't read it.
- **In the session:** the mod unsets the key from Claude Code's environment at startup, so shell commands Claude runs don't inherit it. Neither measure stops a process running as you.
- **What leaves your machine for Gemini:** your typed prompt, with secrets swapped for `«secret-N»` placeholders, and your skills' names and descriptions. The placeholders are swapped back before the rewrite lands in the box.
- **What leaves your machine for skills.sh:** up to two short keyword queries (60 characters at most) that Gemini writes from your redacted prompt, such as `playwright e2e`. Not the prompt itself. Turn it off with "Search skills.sh" in `/config`.

## Develop

```
npm install     # dev dependencies (TypeScript)
npm test        # launcher (node:test) + mod (claude plugin test)
npm run check   # type-check the mod and run claude plugin validate
```

The mod uses Claude Code's early-access mod API (`plugin/hooks/register.tsx`). Run `npm run check` after Claude Code updates.

To edit the mod with hot reload, keep a session open with `claude --plugin-dir plugin`. It reloads on save.

Design: `docs/design/2026-10-09--spark--design.md`.
