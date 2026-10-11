# Council Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This plan gives interfaces and named test cases rather than full code: it is executed inline by the author of the spec, test first, and each task's tests are written before its code.

**Goal:** `/council <q>` (Light) and `/council full <q>` (Full): independent proposals from several models, blind judging by others, Spark's own aggregation, a Claude synthesis that can start a mission.

**Architecture:**
- **Pure core:** `plugin/hooks/council.ts` and `council-providers.ts`.
- **Orchestrator:** `plugin/hooks/council-run.ts` takes an injected `call`, so the app and the terminal mod share it.
- **App:** `app/lib/council-io.js` (fetch, `claude -p`, catalog cache), IPC in `main.js`, and a chat card in `app/lib/council-view.js`.

**Spec:** `docs/superpowers/specs/2026-10-10-council-mode-design.md`

## Global Constraints

- No new dependencies.
- Plugin modules the app loads use `.ts` runtime imports and erasable TypeScript only.
- Window text uses `textContent`, and markdown only goes through DOMPurify.
- Claude one-shots use `--setting-sources '' --strict-mcp-config --no-session-persistence`. The brief and synthesis add `--tools Read,Grep,Glob --permission-mode plan`; proposers and judges use `--tools ''`.
- Nothing is fabricated: a failed call is shown as failed, and costs Spark wasn't told are *not reported*.
- Keys never go on a command line or into `.spark/` or logs.

## Review Focus

1. A judge that returns valid JSON but scores a proposal letter that doesn't exist, or skips one: the verdict is invalid and gets a retry, never a silent zero.
2. Two candidates from the same family ranked top: only one becomes a proposer.
3. An OpenRouter 404 because data collection is `deny`: shown as *unavailable (privacy setting)*, not as a crash.
4. ■ in the middle of Stage B: every running call is cancelled, and the record keeps the finished proposals and verdicts with the status *cancelled*.
5. A brief excerpt that contains a key: it is redacted before the pre-flight card and before any call.

---

### Task 1: Catalog normalization, selection, estimates (`council.ts`)

**Produces:**
- `Candidate`, `normalizeOpenRouter(json)`, `normalizeGemini(json)`, `normalizeOllama(json)`, `CLAUDE_CANDIDATES`.
- `pickCouncil(candidates, mode, { briefChars }) → { proposers: Seat[], judges: Seat[], synth: Seat, empty: string[] }`, where `Seat = { candidate, reason, perspective? }`.
- `estimate(seat, inputChars, mode) → { usd?: number, label: string }`, and `MODES` (Light/Full numbers from the spec).

- [x] Tests (`plugin/test/council.test.ts`):
  - openrouter normalization: free when both prices are "0", open weights from `hugging_face_id`, benchmarks read, non-text models dropped
  - gemini and ollama normalization
  - full picks Opus, Sonnet, Fable plus 5, one per family
  - unscored candidates rank last, and their reason says "no benchmark data"
  - judges are distinct from proposers and come from new families
  - a short pool names the empty seats
  - light shape: Sonnet plus 3 proposers, 2 judges, Sonnet synthesizing, Opus allowed as judge
  - estimate: paid, free, Claude marked "on your plan"
- [x] Watch them fail, implement, see them pass, `npm run check`, commit.

### Task 2: Prompts, validation, blind packets, aggregation (`council.ts`)

**Produces:**
- `briefPrompt(question)`, `parseBrief(text) → Brief | undefined`.
- `proposalPrompt(brief, perspective, mode)`, `missingSections(text) → string[]`.
- `judgePrompt(brief, packets)`, `parseVerdict(text, letters) → Verdict | undefined`.
- `blind(proposals, shuffle) → { packets, mapping }`.
- `aggregate(verdicts, letters) → Aggregate`, with `case` set to `dominant | hybrid | contested | inadequate`.
- `synthPrompt(...)`, `RUBRIC`.

- [x] Tests:
  - the brief block parses, and its excerpts are capped and redacted
  - missing sections are named
  - verdict validation rejects unknown or missing letters, scores outside 0–10, and severities outside the enum
  - `blind` strips model and vendor names and keeps the mapping
  - aggregate: weighted totals are computed by Spark (never trusted from the model), plus Borda and first-place votes
  - aggregate cases: dominant; hybrid; contested; inadequate (best mean under 55); a top-scored proposal with a critical flag is not dominant
  - aggregate lists disagreements of 3 points or more
- [x] Red, green, check, commit.

### Task 3: Providers (`council-providers.ts`)

**Produces:**
- `openrouterRequest(model, system, user, { maxTokens, dataCollection }) → { url, init }`, `parseOpenRouter(json) → { text, inTokens, outTokens, usd }`.
- `geminiRequest(...)`, `parseGemini`.
- `ollamaRequest(...)`, `parseOllama`.
- `claudeArgv(model, system, { readOnly }) → string[]`, `parseClaude(json) → { text, usd, inTokens, outTokens }`.
- `retryAfterMs(res)`.

- [x] Tests:
  - the OpenRouter body carries `provider.data_collection`, `max_tokens` and the messages
  - its parse reads `usage.cost` into `usd`
  - Gemini and Ollama bodies and parses
  - Claude argv: read-only only when asked, and settings and MCP always off
  - `retryAfterMs` is capped at 30 s
- [x] Red, green, check, commit.

### Task 4: Orchestrator (`council-run.ts`)

**Produces:** `runCouncil({ brief, panel, mode, call, notify, now, shuffle, signal }) → Promise<CouncilRecord>`, where `call(seat, request, signal) → { text, usd?, inTokens?, outTokens? }`. It notifies `{ kind: 'seat', seat, state }`, `{ kind: 'stage', stage }` and `{ kind: 'record', record }`.

- [x] Tests (`plugin/test/council-run.test.ts`, fake `call` and clock):
  - stages run in order, and a judge's input contains no model id
  - at most 4 calls run at once
  - a timeout marks the seat *timed out*
  - a 429 is retried once
  - an invalid proposal is retried, then *failed*
  - a judge that fails twice leaves "2 of 3 judged"
  - fewer than 2 proposals: the run is *failed* and partial results are kept
  - aborting the signal mid-Stage B: *cancelled*, finished work kept
  - synthesis gets the aggregate and the disagreements
- [x] Red, green, check, commit.

### Task 5: App I/O and settings (`app/lib/council-io.js`, key slot)

**Produces:**
- `createCouncilIo({ fetchImpl, spawn, keys, cwd, cachePath, now })`, returning `{ catalogs(), call(seat, request, signal), freeRequestsLeft(), killAll() }`.
- The OpenRouter key is stored at `%APPDATA%\spark\openrouter.key` through `saveKey`, `loadKey` and `clearKey` with a file path.

- [x] Tests (`app/test/council-io.test.js`, fake `fetch` and `spawn`):
  - a catalog fresh within 6 h comes from the cache
  - a stale catalog with a failed fetch falls back, with its age
  - a missing key leaves its provider absent
  - `call` routes to the right provider
  - `killAll` kills tracked Claude processes
- [x] Red, green, commit.

### Task 6: Mission handoff (`mission.ts`, `mission-runner.js`)

**Produces:** `newMission(objective, at, hex4, gateOffset, { criteria, plan })`, which starts in `review` when criteria are given. `runText` adds a "Plan (from Council)" section when `plan` is set. The runner gets `fromPlan(objective, criteria, plan, { sessionId })`.

- [x] Tests:
  - a planned mission starts in `review` with its criteria and plan, and approving it sends a run text that includes the plan
  - `asMission` keeps `plan` as a string, clipped to 20,000 characters
- [x] Red, green, commit.

### Task 7: Main wiring and store

**Produces:**
- `.spark/councils/<id>.json`, written atomically.
- IPC handlers:
  - `council-preflight(question, mode) → { id, brief, panel, empty, estimate, consentNeeded, freeLeft, catalogAge }`
  - `council-run(id, { consent, dataCollection, reduced })`
  - `council-cancel(id)`
  - `council-mission(id)`
  - `councils()`, `council-view(id)`
- In settings: `openrouterKey` (DPAPI) and `councilBudgetUsd`.
- Window messages: `council` events relayed from `notify`.

- [x] Main has no unit tests (the same as missions). Verify with `node --check app/main.js`, the app test suite, and the e2e.

### Task 8: Window

**Produces:**
- `/council [full] <q>`.
- The pre-flight card: the full brief, the panel table, empty seats, estimates, consent with the data-collection choice and the count each choice leaves, and the cap check.
- The live result card: seat states, the proposal gallery, the voting matrix, combination analysis, the synthesis, the execution summary, the audit, and Start as mission.
- An OpenRouter key field and a run cap field in ⚙ settings.

- [x] Browser check with a stubbed bridge at 720 and 1440 px, in both themes. Then commit.

### Task 9: Terminal `/council`

- [x] If the mod can run `runCouncil` with `$.http.fetch` and `$.process.run(['claude', …], { stdin, timeoutMs })`, add `/council [full] <q>`. It works through a pane, with Run and Cancel as pane buttons and consent and keys read from Spark's config. Otherwise, add a README line saying the terminal has no `/council` yet. Test with the fake engine, as `mission-terminal.test.ts` does.

### Task 10: README, end-to-end Light run, verification

- [x] README section "Council".
- [x] End-to-end Light council in a scratch repo with Claude and Gemini (no OpenRouter key). Check every number on the card against the run record.
- [x] Full suites green, then commit. State plainly that Full and OpenRouter were not run end to end.
