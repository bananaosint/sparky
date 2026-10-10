# Spark

Claude Code, launched with a Gemini prompt cook, modes and a Spark look. Windows only.

```
  ϟ       ϟ
   ╲▗▄▄▄▖╱     ▄▀▀▀ █▀▀▄ ▄▀▀▄ █▀▀▄ █ ▄▀
  ▐█◕ ▾ ◕█▌     ▀▀▄ █▀▀  █▀▀█ █▀█  █▀▄
 ◂▐█●▄▄▄●█▌▸   ▀▀▀  ▀    ▀  ▀ ▀  ▀ ▀  ▀
   ▝▀╯ ╰▀▘
```

Sparky Bug, Spark's mascot, greets you in the launcher banner. Claude Code's own welcome screen, crab included, follows below it; Spark can't change that screen, but the theme recolors everything else blue to ultraviolet.

## Install

Needs Windows, Node 24+, git and [Claude Code](https://claude.com/claude-code) on PATH, and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```
npm install -g github:bananaosint/sparky
spark key set       # paste your Gemini API key; stored encrypted for your Windows account
spark doctor        # checks claude, git, the key, and that every Gemini model in the chains exists for it
spark               # start Claude Code with Spark in the current folder
```

Without a key Spark still runs; prompts are sent as typed. `spark key clear` deletes the stored key.

Update with the same install command. Uninstall with `npm uninstall -g spark`. Each [release](https://github.com/bananaosint/sparky/releases) also has a `.tgz` you can install offline with `npm install -g spark-<version>.tgz`.

Use a key from a billing-enabled Google project. On the free tier, Google may use prompts to improve its products and human reviewers may read them.

### From a clone

```
git clone https://github.com/bananaosint/sparky.git
cd sparky
npm link            # puts `spark` on PATH (undo: npm unlink -g spark)
```

## Use

Run `spark` in any project folder. Claude Code starts as usual, with Spark loaded.

1. Type a prompt and press **Enter**. The band above the prompt shows `cooking`.
   - Gemini rewrites the prompt and opens it with a role for Claude, wildly exaggerated but on topic: "Act as a senior web developer with 200 years of programming and UI/UX development."
   - The rewrite tries `gemini-3.8-flash`, `3.7-flash`, `3.6-flash`, `3.5-flash`, `3-flash-preview`, `3.1-flash-lite`, then `gemma-4-31b-it`, moving on when one is out of quota or failing. The band says which one answered.
   - `gemini-3.5-flash-lite` (then `gemini-3.1-flash-lite`) picks up to seven of your installed skills, or none. If the work needs a skill you don't have, it searches [skills.sh](https://skills.sh/) (the registry behind `npx skills find`) and suggests up to three with 1K+ installs.
   - Both run at once. Each model gets three tries of up to 10 seconds (the timeout) before the next one is asked; press Enter any time to send your prompt as typed instead.
2. The rewrite replaces your text in the prompt box. The role is the first line. Any open questions appear as "Ask me before starting:" lines, chosen skills as a `Skills:` line, and suggested installs as an "Install these skills first" list that Claude installs with `npx skills add <id> -g -y`. Delete any you don't want. Edit anything.
3. Press **Enter** again to send it to Claude.

These prompts are sent as typed instead:
- prompts that start with `\`
- Enter while the prompt is still cooking
- prompts under 4 words
- slash commands
- prompts typed while Claude is working
- prompts with images or pasted text

| Command | Effect |
|---|---|
| `/spark-diff` | Pane with what this turn changed, per file |
| `/sandbox` | Toggle: each turn ends with keep or revert for everything it changed |
| `/spark-restore [N]` | List turn snapshots, or restore one (asks first; the current state is snapshotted, so it can be undone) |
| `/spark-fix` | Send the last failed `spark try` command to Claude |
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
