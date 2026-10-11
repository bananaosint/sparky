# Council mode: several models propose, other models judge, one synthesizes

`/council <question>` (Light) or `/council full <question>` (Full) has several models write independent proposals, other models judge them blind against a rubric, and Claude synthesize the strongest coherent plan. The result can start a mission. Everything shown comes from recorded calls: no fabricated proposals, votes, scores or costs.

This is sub-project 2 of the command-center spec (`FutureAdd-onns_Prompt.txt`, section 29). It builds on missions (sub-project 1).

## What the user asked for

- From the spec: eight proposers (Opus 5.5, Sonnet 5.5, Fable 5.1 and five discovered open-weight or free models), three more judges, blind evaluation, a 100-point rubric, a combination analysis, synthesis, validation against the repo, a pre-flight cost and privacy check, a dashboard, failure handling, and no fabrication.
- Decided with the user:
  - Light and Full modes. Light uses about half the models.
  - OpenRouter (plus local Ollama when it runs) supplies the open-weight and free models. The key is stored encrypted like the Gemini key.
  - Council comes after missions.
  - You consent once per provider before any code leaves the machine, and Spark remembers it.
  - Every run shows an estimate first, and paid calls have a per-run cap.

## Modes

| | Light (`/council <q>`) | Full (`/council full <q>`) |
|---|---|---|
| Proposers | Sonnet + 3 discovered models | Opus, Sonnet, Fable + 5 discovered models |
| Judges | 2 | 3 |
| Synthesis | Sonnet | Fable |
| Proposal length | up to 900 words, 2,500 output tokens | up to 1,800 words, 5,000 output tokens |
| Retries per call | 1 | 2 |
| Timeout per call | 120 s | 300 s |

Light is lighter because it makes fewer and shorter calls, not because it picks faster models: Spark has no per-model latency data, so it doesn't claim any.

## Providers

| Provider | Reached through | Discovery | Access label |
|---|---|---|---|
| Claude (opus, sonnet, fable, haiku) | one-shot `claude -p` on your plan | fixed list | *your Claude plan* (cost shown at API rates, as Claude Code reports it) |
| OpenRouter | `POST https://openrouter.ai/api/v1/chat/completions` with your key | `GET /api/v1/models` | *free hosted* when both prices are `"0"`, else *paid hosted*; *open weights* when `hugging_face_id` is set |
| Gemini | the existing Gemini key | `GET https://generativelanguage.googleapis.com/v1beta/models` | *your Gemini key* (cost not reported); Gemma models are *open weights* |
| Ollama | `POST http://127.0.0.1:11434/api/chat`, if it answers | `GET /api/tags` | *local*, *open weights* |

- **Claude calls** have no settings sources, no MCP servers and no session. Proposers and judges get no tools. The brief and the synthesis get only `Read`, `Grep` and `Glob`, in plan mode, in the project folder. Checked against Claude Code 2.1.296: `--tools Read,Grep,Glob --permission-mode plan --output-format json` reads files, and the result carries `total_cost_usd` and `usage`.
- **OpenRouter requests** carry `provider: { data_collection: "deny" }` unless you allowed otherwise in the consent card (see Privacy). Their `usage.cost` (credits, which are USD) is recorded as the call's cost.
- **Catalogs** are fetched at pre-flight and kept for 6 hours in `%APPDATA%\spark\council-catalog.json` with their fetch time. If a fetch fails, the kept copy is used and the card shows its age. With no copy, that provider's models are missing, and the card says so.

## Selection

Pure and tested: `pickCouncil(candidates, mode, settings)`.

- A candidate has an id, provider, family (the id's author prefix, such as `deepseek` or `qwen`; the provider for Claude, Gemini and Ollama), access label, open-weights flag, context and output limits, prices per million tokens or *unknown*, and benchmark scores (OpenRouter's `benchmarks.artificial_analysis` coding and intelligence indexes) or *none*.
- Eligible discovered proposers are open-weight, free hosted, or Gemini models on your key (whose free tier is free to use, within its limits), text-in and text-out, with context of at least 32k tokens. Family for Gemini models is `gemini` or `gemma`. Ranked by coding index, then intelligence index, then context. A candidate with no benchmarks ranks below every scored one, and its reason says "no benchmark data". At most one proposer per family.
- Judges are distinct from every proposer. They come from families not used by a proposer, each judge from a different family, and from different providers where the pool allows. Ranked by intelligence index, then coding index, and they need context large enough for the brief plus every proposal. Judges may be paid. Claude models are never judges in Full, since all three serve as proposers. In Light, Opus may judge.
- Each pick records its reason (for example "coding index 61, free hosted, 128k context"), its access label, limits, estimated cost and any privacy or licence note the catalog gives.
- **Short pool.** If the pool can't fill every seat, the card names the empty seats. Run then becomes **Run with a reduced panel** (for example "4 proposers, 2 judges"), and the report says *reduced panel*. A proposer is never reused as a judge to fill a gap.

## Flow

1. **Brief.** Claude Sonnet reads the project (read-only) and returns a fenced `brief` block: objective, relevant context as file excerpts (at most 12 excerpts, 6,000 characters in all), constraints, acceptance criteria, verification. Spark runs `redact()` over it.
2. **Pre-flight card** in the chat shows:
   - **Panel:** the full brief exactly as it would be sent, the panel with reasons and access labels, empty seats, and the estimated cost per model and in total.
   - **Your limits:** the run cap, OpenRouter's remaining free requests for today (from `GET /api/v1/key`, `free_model_daily_requests.remaining`), with a warning if the run won't fit.
   - **Consent:** consent for each provider not yet approved.

   **Run** needs every consent and an estimate under the cap. **Cancel** ends it.
3. **Proposals (Stage A).** All proposers run in parallel, at most 4 calls at a time. Each gets the same brief and one perspective, in this order: simplest viable; strongest architecture; performance and scale; reliability and recovery; maintainability; security and correctness; unconventional; best overall balance. Light uses the first four.

   A proposal must use the headings A to L from the spec (Executive recommendation … Confidence and unknowns). One missing A, C, D, F, G or H is invalid and gets one retry that names the missing sections. After that, the model has **failed**. Nothing replaces a failed proposal.
4. **Blind packets.** Proposals are shuffled into letters A to H. Model and vendor names in the text become `[model]`. The mapping stays in the run record and is revealed only in the audit section after synthesis.
5. **Judging (Stage B).** Every judge runs in parallel, with no sight of the other judges. Each gets the brief, the blind proposals and the rubric, and must return a fenced `verdict` JSON block:
   - `scores`: each proposal's 0–10 score on every rubric criterion
   - `rank`
   - `preferred` and `alternative`
   - `ideas`: `[{ proposal, idea }]`
   - `risks`: `[{ proposal, issue, severity: critical|major|minor, evidence }]`
   - `hybrid`: `{ base, take: [{ from, contribution }], drop, conflicts: [{ between, resolution }], worthIt }`
   - `confidence`

   A verdict that fails validation gets one retry, then the judge has **failed**.
6. **Aggregate.** Spark computes each judge's weighted totals itself (it never trusts a model's arithmetic), the mean, a Borda count from the ranks, first-place votes, the score spread, and critical flags. The case is one of:
   - *inadequate*: the best mean is under 55 of 100
   - *dominant*: one proposal leads every judge's ranking, or its mean leads by 10 or more, and nobody flags it critical
   - *hybrid*: most judges say a hybrid is worth it
   - *contested*: anything else

   A proposal with a critical flag can't be *dominant*: its flag goes to the synthesis as a must-address item. Where judges disagree by 3 or more points on a criterion for the same proposal, that disagreement is listed.
7. **Synthesis.** Fable (Full) or Sonnet (Light), with read-only tools in the project, gets the brief, the blind proposals, the verdicts, the aggregate and the disagreements. It may check repository claims by reading files. It returns, in Markdown:
   - **Decision**: dominant, hybrid, or none adequate (and if none, what to investigate next)
   - **Why**
   - **Contributions used**, by letter, and **Rejected and why**
   - **Conflicts resolved**
   - **Implementation steps**
   - a ```mission block (the missions format) with acceptance criteria
   - **Verification**
   - **Still uncertain**
8. **Result card.** Problem brief, candidate models with their real states, proposal gallery (folded), judge panel, voting matrix (proposal × judge weighted totals, mean, Borda, flags), combination analysis (each judge's hybrid), final synthesis, execution summary (who took part, who failed and why, retries, reduced panel, cost by provider), and the audit (letter → model).
   - **Start as mission** creates a mission straight in `review` with the synthesized criteria and the synthesis as its plan. The normal criteria card and approval follow; `runText` includes the plan.

Model states shown: selected, queued, running, done, failed, timed out, unavailable, skipped. They change only on real events.

## Rubric

Default weights out of 100: outcome and requirements 25, correctness and compatibility 20, feasibility and specificity 15, security, privacy and safety 15, maintainability and testability 10, insight and edge cases 10, cost and resource efficiency 5. They are recorded with the run. Changing the weights per task is out of this pass.

## Privacy

- **Consent** is per provider (OpenRouter, Gemini, Ollama is local and needs none). It is stored in `%APPDATA%\spark\config.json` as `councilConsent: { openrouter: { at, dataCollection } }`. The card says that the brief and code excerpts go to that provider, and that free endpoints often keep or train on prompts.
- **OpenRouter data collection.** The default is `deny`: OpenRouter routes only to endpoints that don't keep prompts, which can leave fewer free models. The card shows how many discovered models each choice leaves. If you pick `allow`, it is remembered with your consent.
- **What leaves the machine** is only the redacted brief, a proposal packet and the blind proposals. Never whole files, `.env` files or keys. The brief's excerpts are chosen by Claude, capped and redacted, and shown to you in full before you consent.
- **Records** stay in `.spark/councils/<id>.json`.

## Cost and limits

- The estimate per call is (input tokens × input price + max output tokens × output price), with tokens estimated as characters ÷ 4. Claude calls are shown at API rates and marked *on your plan*. Gemini and Ollama are *not reported* or *local*.
- The **run cap** applies to metered spend only (OpenRouter paid models). It is checked on the estimate before Run and recorded against the actual cost after; it is not enforced in the middle of a call. Default $1.00, changed with `councilBudgetUsd` in `%APPDATA%\spark\config.json`.
- Free OpenRouter models are limited to 20 requests a minute and 50 a day without purchased credits (1,000 a day with at least $10 bought). The pre-flight check reads the day's remaining count. A 429 waits for the time `Retry-After` gives (at most 30 s) and counts as one retry.

## Failure handling

Each call has a timeout and bounded retries (on 429, 5xx, network errors and invalid output). At most 4 calls run at once, and ■ cancels them all: Claude processes are killed and fetches aborted. The run is then recorded as *cancelled*, with whatever finished.

| Situation | What happens |
|---|---|
| Fewer than 2 proposals succeed | The run stops as *failed* and keeps what it has. |
| Fewer than 2 judges succeed | No aggregate or synthesis; the proposals are kept. |
| One judge fails | The aggregate says "2 of 3 judged". |

The runner's state lives in one record that is written after every call, so a crash keeps the finished calls.

## Where it lives

| Piece | Role |
|---|---|
| `plugin/hooks/council.ts` | Pure: types, catalog normalization for each provider, `pickCouncil`, estimates, prompts, proposal and verdict validation, anonymizing, aggregation, result sections. |
| `plugin/hooks/council-run.ts` | The orchestrator. It takes `call(model, request, signal)`, `notify` and the clock, and handles the stages, concurrency, timeouts, retries, cancellation and the record. Shared so the terminal can use it. |
| `plugin/hooks/council-providers.ts` | Request builders and response parsers for OpenRouter, Gemini, Ollama and the Claude argv. Pure. |
| `app/lib/council-io.js` | The app's `call`, using `fetch`, and `claude -p` through `spawn` (tracked so ■ can kill it), plus catalog fetches and caching. |
| `app/main.js`, `app/preload.cjs` | IPC for `council-preflight`, `council-run`, `council-cancel`, `council-mission`, and the OpenRouter key in settings. |
| `app/renderer.js`, `app/lib/council-view.js`, `app/styles.css` | `/council`, the pre-flight card, the live result card, the OpenRouter key and run cap in ⚙ settings. |
| `plugin/hooks/mission.ts`, `app/lib/mission-runner.js` | A mission created in `review` with criteria and a plan; `runText` includes the plan. |

## Not covered

- **Blindness is a name-strip.** A judge can still guess an author from style.
- **Selection** uses OpenRouter's benchmark indexes where they exist, and catalog facts otherwise. It doesn't use any benchmark of Spark's own yet.
- **Full mode was not run end to end** while building this, because no OpenRouter key was available. The OpenRouter client is built against its documented schema and tested with a fake `fetch`. Light was run end to end with Claude and Gemini only.
- **The run cap** is checked on the estimate, not enforced mid-call.
- **Council suggesting itself** for large tasks is out of this pass.
- **The terminal** gets `/council` only if the mod can run the orchestrator through `$.http` and `$.process.run`. If not, the README says the terminal has no `/council` yet.
- **Per-task rubric weights** are out of this pass.

## Tests

- `plugin/test/council.test.ts`:
  - catalog normalization (free, paid, open weights, benchmarks or none)
  - selection:
    - diversity
    - judges distinct from proposers
    - reduced panel
    - the Light and Full shapes
    - unscored candidates ranked last
  - estimates
  - proposal validation (missing sections)
  - verdict validation
  - anonymizing (names stripped, the mapping kept)
  - aggregation in the four cases: dominant, hybrid, contested, and inadequate, plus a top-scored proposal with a critical flag that can't win
- `plugin/test/council-run.test.ts` with a fake `call`:
  - stage order and blindness (a judge's input never holds a model name)
  - concurrency of 4 or fewer
  - a timeout
  - a 429 retry
  - an invalid proposal retried, then failed
  - a judge failing
  - fewer than 2 proposals
  - cancel keeping partial results
- `plugin/test/council-providers.test.ts`: request bodies (`data_collection`, `max_tokens`) and response parsing (text, usage, cost) for each provider.
- `app/test/council-io.test.js`: catalog caching and fallback age with a fake `fetch`.
- End to end: a Light council in this repo with Claude and Gemini, plus the window check at 720 and 1440 px.
