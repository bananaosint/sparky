# Auto and UltraCode modes, Tab Tab, structured prompts, 3D Sparky

Decided with the user (defaults accepted 2026-10-10): Auto compares answers only, UltraCode is a strong model at max effort with a review pass, the old "Auto" card becomes "Default", Enter once rewrites, Tab Tab sends as typed, the cook button goes but its setting stays.

## 1. Auto and UltraCode (app, Power Core)

- **Cards:** the picker becomes Default · Auto · UltraCode · Opus · Sonnet · Haiku · Gemini. "Default" is Claude Code's default model (was labeled Auto).
- **Auto** answers in the window, like Gemini quick answers: no tools, no files. It asks each model in `autoModels` in parallel, then a judge synthesizes the best answer.
  - Default models: `opus`, `fable`, `gemini-3.1-flash-lite`, `gemini-3.7-flash`. Claude models run as one-shot `claude -p --tools "" --setting-sources "" --strict-mcp-config --system-prompt … --output-format json --no-session-persistence` (probed on 2.1.296: 2.5 s, no tools, no hooks, on the user's plan). Gemini models run through the existing `askChain` with a chain of one.
  - The judge is the first Claude model in the list, else the first Gemini one. It gets the question and the labeled answers, writes the final answer and ends with `Picked from: <labels>`.
  - A model that fails or times out (3 minutes) is listed as failed; the rest still count. All failed: an error line.
  - The bubble shows the synthesis, a badge naming the judge and the models it drew on, and a collapsed section per model with its own answer.
  - Images go to the Gemini models only; Claude one-shots get the text.
- **UltraCode** runs Claude Code on `ultraModel` (default `fable`) at effort `max`, whatever the effort bar says. After each turn you started ends, Spark sends one review pass ("check the change against my request, run the tests, fix what's wrong, else reply Nothing found."). Not during a marathon, which has its own passes.
- **Settings (⚙):** checkboxes for the Auto models (opus, fable, sonnet, haiku, and the Gemini models Spark knows) and a select for the UltraCode model. Stored in `%APPDATA%\spark\config.json` as `autoModels` and `ultraModel`.

## 2. Timer format

The working timer and the "done in" line read `mm:ss` under an hour, `hh:mm:ss` from an hour on.

## 3–4. Cook button and submission

- The `⚡ Cook` pill is removed. The "Rewrite prompts with Gemini" setting stays in ⚙.
- Enter once: Gemini rewrites (and picks skills); the rewrite lands in the box, nothing is sent. Enter again sends it. Unchanged.
- Tab Tab (second Tab within 600 ms) sends the original typed text, with the `Skills:` line if skills were already picked; if none were picked and skill picks are on with a key, Spark picks them first (no rewrite) and sends. With an empty box Tab moves focus as before; with text in the box the first Tab waits for the second.

## 5. Prompts

- Gemini's rewrite is in depth: 2–4 `##` headers, 3–6 bullets under each. It may restate, split and make explicit what the request states or clearly implies, plus how to check it's done; it still adds no new requirements. The old "no headings" and "at most 3× as long" rules go.
- The cooked prompt says it was rewritten: a line `(Rewritten by Gemini from what I typed. My original words win if they conflict.)` after the role line.
- Sparky's answers (Gemini quick answers, Auto members, the Auto judge) use 2–4 headers with 3–6 bullets each. Their system prompts state that the person's message may have been rewritten by Gemini before it arrived.

## 6. 3D Sparky

The welcome screen's Sparky becomes a 3D voxel model built from the same pixel sprite and theme colors: thicker in the middle so he reads as rounded, lit from the upper left, bobbing, turning toward the pointer, spun by dragging, a flip on click. No dependency: a small canvas renderer (`app/lib/voxel.js` builds and projects; the renderer draws). Reduced motion: still, facing slightly to the side.

## Tests

`app/test/` for the timer format, Tab Tab detection, Auto orchestration and judge parsing, the voxel geometry; `plugin/test/` for the rewrite rules and the cooked-prompt line. Real probes: a one-shot Auto run on cheap models.
