---
name: postmortem
description: Use when Spark has halted after two consecutive build or test failures, or when the user asks for a post-mortem. Writes docs/postmortems/YYYY-MM-DD--<slug>.md and attempts no fixes.
---

# Post-mortem

Spark halted because two builds or test runs failed in a row. Don't try another fix. Write down what happened so the next attempt starts from evidence.

Write `docs/postmortems/YYYY-MM-DD--<slug>.md` (today's date; the slug names what was being attempted, lowercase words joined by `-`). Edits under `docs/postmortems/` are allowed while halted.

## Sections

1. **What was being attempted.** One short paragraph.
2. **The two failures.** Each as the verbatim tail of its output in a fenced block, with the command that produced it.
3. **Root-cause hypotheses, ranked.** For each: the evidence for it and the evidence against it.
4. **The one check that would confirm the top hypothesis.** A command or a single observation, not a fix.
5. **Proposed next step.**

## Rules
- No fixes. Don't edit code, tests or config.
- Quote output exactly; never paraphrase an error.
- Mark anything you couldn't verify as unverified.

When the file is written, tell the user it exists and that `/spark-unhalt` lifts the halt.
