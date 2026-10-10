# Marathon sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/marathon <task> [--time 1.5h] [--tokens 2m]` keeps Claude working in review passes until a time or token budget is spent, steps up to a stronger model when passes find nothing, and shows what is left.

**Architecture:** A pure policy module (`app/lib/marathon.js`) decides, at each turn end, whether to end, wait or send the next pass and whether to switch model. `main.js` feeds it Claude Code's stream events and acts on the answer: next pass on stdin, `set_model` control request. The window starts and stops it and shows the header line. Spark's rules (`misp.ts`) explain the `<spark-session>` block.

**Tech Stack:** Node ESM, `node:test` (app); TypeScript and `claude plugin test` (rules text).

**Spec:** `docs/superpowers/specs/2026-10-10-marathon-sessions-design.md`

## Global Constraints

- Flag grammar and defaults match `/goal`: `--time 90s|45m|1.5h`, `--tokens 200k|2m`, defaults 30m and 500k.
- Tokens = input + output + cache writes; cache reads never count.
- Models move up one tier at a time, never down: haiku, sonnet, opus, then fable only when `marathonTop` is `"fable"` in `%APPDATA%\spark\config.json`.
- Step up only after 2 idle passes in a row with at least half of both budgets left.
- A last message ending in `?` waits for the user; no pass is sent.
- No new dependency, no new setting UI. Comments say why. Match the surrounding style.

## Review Focus

- Zero or negative limits (`--time 0m`): rejected, never a marathon that ends before it starts.
- A pass that crosses the token cap: ends, and the cap check wins over sending another pass.
- A switch Claude Code refuses (unknown model, plan lacks it): reported, marathon carries on on the current model.
- User presses ■, starts a New chat or opens a folder mid-marathon: marathon ends, nothing sends afterwards.
- The user answers a question mid-marathon: that reply is not a pass and cannot trigger a step up.

## File map

- Create `app/lib/marathon.js`: policy and texts. Create `app/test/marathon.test.js`.
- Modify `app/lib/stream.js` (control events, `setModel`), `app/lib/commands.js` (`marathon` kind), `app/main.js`, `app/preload.cjs`, `app/renderer.js`.
- Modify `plugin/hooks/misp.ts`; create `plugin/test/marathon.test.ts`.
- Modify `README.md`. Tests extend `app/test/core.test.js` and `app/test/features.test.js`.

### Task 1: Stream control events and `setModel`

**Files:** Modify `app/lib/stream.js`; test `app/test/core.test.js`.
**Produces:** `parseLine` emits `{kind:'control', id, ok, error}`; `setModel(id, model?) -> string` (one JSON line, no newline).

- [ ] **Step 1: Failing test** (append to `core.test.js`; add `setModel` to the `stream.js` import)

```js
test('control responses become events, and set_model asks for a model by alias', () => {
  assert.deepEqual(parseLine('{"type":"control_response","response":{"subtype":"success","request_id":"sw1"}}'), [{ kind: 'control', id: 'sw1', ok: true, error: undefined }]);
  assert.deepEqual(
    parseLine('{"type":"control_response","response":{"subtype":"error","request_id":"sw2","error":"Model \'x\' not found"}}'),
    [{ kind: 'control', id: 'sw2', ok: false, error: "Model 'x' not found" }],
  );
  assert.deepEqual(JSON.parse(setModel('sw1', 'opus')), { type: 'control_request', request_id: 'sw1', request: { subtype: 'set_model', model: 'opus' } });
  assert.deepEqual(JSON.parse(setModel('sw2')), { type: 'control_request', request_id: 'sw2', request: { subtype: 'set_model' } });
});
```

- [ ] **Step 2:** `cd app && node --test test/core.test.js` → FAIL (`setModel` is not exported).
- [ ] **Step 3: Implement** in `stream.js`: before the final `return []` in `parseLine`

```js
  if (j.type === 'control_response')
    return [{ kind: 'control', id: j.response?.request_id, ok: j.response?.subtype === 'success', error: j.response?.error }];
```

and after `userMessage`:

```js
// Switches the running session's model; without one it goes back to the account default.
export const setModel = (id, model) =>
  JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_model', ...(model ? { model } : {}) } });
```

- [ ] **Step 4:** run the same command → PASS.

### Task 2: `/marathon` as a window command

**Files:** Modify `app/lib/commands.js`; test `app/test/features.test.js`.
**Produces:** `parseCommand('/marathon <args>') -> { kind: 'marathon', args }`.

- [ ] **Step 1: Failing test** (add to the slash-commands test in `features.test.js`)

```js
  assert.deepEqual(parseCommand('/marathon fix the parser --time 1h'), { kind: 'marathon', args: 'fix the parser --time 1h' });
  assert.deepEqual(parseCommand('/marathon'), { kind: 'marathon', args: '' });
```

- [ ] **Step 2:** `cd app && node --test test/features.test.js` → FAIL (`passthrough`).
- [ ] **Step 3: Implement** in `parseCommand`, after the `effort` line:

```js
  if (name === 'marathon') return { kind: 'marathon', args: arg.trim() };
```

and update the file's top comment to say it also covers `/marathon`.
- [ ] **Step 4:** PASS.

### Task 3: The marathon policy

**Files:** Create `app/lib/marathon.js`, `app/test/marathon.test.js`.
**Produces (exact):**
`DEFAULT_LIMITS`, `EDIT_TOOLS` (Set), `parseMarathon(args) -> {error}|{status:true}|{stop:true}|{task,limits}`, `tierOf(model) -> 'haiku'|'sonnet'|'opus'|'fable'|undefined`, `startMarathon({task,limits,now,tier}) -> state`, `noteTool(state,name) -> state`, `userSent(state) -> state`, `onResult(state, resultEvent, {now, top='opus'}) -> {state, next}` with `next` one of `{kind:'end',reason}`, `{kind:'wait'}`, `{kind:'send',text,switchTo?}`, `sessionBlock(state,now)`, `statusLine(state,now)`, `summary(state,now)`.
State: `{task, limits, startedAt, tokens, pass, forced, edits, idle, tier}`.

- [ ] **Step 1: Failing tests** — `app/test/marathon.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, parseMarathon, tierOf, startMarathon, noteTool, userSent, onResult, sessionBlock, statusLine, summary } from '../lib/marathon.js';

const result = (over = {}) => ({ kind: 'result', ok: true, text: 'Nothing found.', costUsd: 0, durationMs: 1, usage: { input: 100, output: 50, cacheRead: 9999, cacheWrite: 10 }, ...over });
const begin = (over = {}) => ({ ...startMarathon({ task: 'fix the parser', limits: { timeMs: 90 * 60_000, tokens: 2_000_000 }, now: 0, tier: 'haiku' }), ...over });
const min = (n) => n * 60_000;

test('/marathon reads the task and the limits /goal reads', () => {
  assert.deepEqual(DEFAULT_LIMITS, { timeMs: min(30), tokens: 500_000 });
  assert.deepEqual(parseMarathon('fix the parser'), { task: 'fix the parser', limits: DEFAULT_LIMITS });
  assert.deepEqual(parseMarathon('fix the parser --time 1.5h --tokens 2m'), { task: 'fix the parser', limits: { timeMs: 5_400_000, tokens: 2_000_000 } });
  const sentence = parseMarathon('ship "it" --tokens 200k. --time 45m,');
  assert.equal(sentence.task, 'ship "it"');
  assert.deepEqual(sentence.limits, { timeMs: min(45), tokens: 200_000 });
});

test('bare /marathon is a status request, stop stops, bad input says what is wrong', () => {
  assert.deepEqual(parseMarathon(''), { status: true });
  assert.deepEqual(parseMarathon('  stop '), { stop: true });
  assert.match(parseMarathon('fix it --time soon').error, /--time takes a duration like 45m, 90s or 1\.5h/);
  assert.match(parseMarathon('fix it --tokens').error, /--tokens takes a count like 200k or 2m/);
  assert.match(parseMarathon('fix it --time 0m').error, /above zero/);
  assert.match(parseMarathon('fix it --tokens 0').error, /above zero/);
  assert.match(parseMarathon('--time 1h').error, /say what to work on/);
});

test('a model id maps to its tier', () => {
  assert.equal(tierOf('claude-opus-5-5'), 'opus');
  assert.equal(tierOf('claude-sonnet-5-5'), 'sonnet');
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku');
  assert.equal(tierOf('claude-fable-5-1'), 'fable');
  assert.equal(tierOf('sonnet'), 'sonnet');
  assert.equal(tierOf(''), undefined);
  assert.equal(tierOf(undefined), undefined);
});

test('a turn that ends past the time limit ends the marathon, even mid-task', () => {
  assert.deepEqual(onResult(begin(), result(), { now: min(90) }).next, { kind: 'end', reason: 'time is up' });
});

test('tokens count input, output and cache writes, never cache reads; the cap ends it', () => {
  const s = begin({ limits: { timeMs: min(60), tokens: 1000 } });
  const first = onResult(s, result({ usage: { input: 400, output: 100, cacheRead: 500_000, cacheWrite: 100 } }), { now: 1000 });
  assert.equal(first.state.tokens, 600);
  assert.equal(first.next.kind, 'send');
  const second = onResult(first.state, result({ usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0 } }), { now: 2000 });
  assert.deepEqual(second.next, { kind: 'end', reason: 'token budget spent' });
});

test('a failed turn ends it with the reason', () => {
  assert.deepEqual(onResult(begin(), result({ ok: false, text: 'API Error: overloaded' }), { now: 1000 }).next, { kind: 'end', reason: 'a turn failed: API Error: overloaded' });
});

test('a question to the user waits instead of sending a pass', () => {
  const { next, state } = onResult(begin(), result({ text: 'Keep the old API or break it?' }), { now: 1000 });
  assert.deepEqual(next, { kind: 'wait' });
  assert.equal(state.pass, 1);
});

test('each turn end sends the next pass, one lens at a time, around again after the last', () => {
  let s = begin();
  const texts = [];
  for (let i = 0; i < 8; i++) {
    const r = onResult(s, result(), { now: 1000 * (i + 1) });
    s = r.state;
    texts.push(r.next.text);
  }
  assert.match(texts[0], /^Check the original request/);
  assert.match(texts[2], /^Run the full test suite/);
  assert.equal(texts[6].split('\n')[0], texts[0].split('\n')[0]);
  assert.match(texts[0], /<spark-session>marathon pass 2 · /);
  assert.match(texts[0], /reply "Nothing found\." and stop/);
});

test('two idle passes in a row, with half the budget left, step up one tier', () => {
  let s = onResult(begin(), result(), { now: 1000 }).state;
  const a = onResult(s, result(), { now: 2000 });
  assert.equal(a.next.switchTo, undefined);
  const b = onResult(a.state, result(), { now: 3000 });
  assert.equal(b.next.switchTo, 'sonnet');
  assert.equal(b.state.idle, 0);
});

test('an edit resets the idle count, and no step-up happens late in the budget', () => {
  let s = onResult(begin(), result(), { now: 1000 }).state;
  s = onResult(s, result(), { now: 2000 }).state;
  s = noteTool(s, 'Edit');
  s = onResult(s, result(), { now: 3000 }).state;
  assert.equal(s.idle, 0);
  s = onResult(s, result(), { now: 4000 }).state;
  assert.equal(onResult(s, result(), { now: min(60) }).next.switchTo, undefined);
});

test('the ladder never goes down, stops at opus, and reaches fable only when allowed', () => {
  const up = (tier, top) => onResult({ ...begin({ tier }), forced: true, idle: 1 }, result(), { now: 1000, top }).next.switchTo;
  assert.equal(up('sonnet'), 'opus');
  assert.equal(up('opus'), undefined);
  assert.equal(up('opus', 'fable'), 'fable');
  assert.equal(up('fable', 'fable'), undefined);
  assert.equal(up(undefined), undefined);
});

test('a message from the user is not a pass, so it cannot count as idle', () => {
  const s = userSent({ ...begin(), forced: true, edits: 3, idle: 1 });
  assert.equal(s.forced, false);
  assert.equal(s.edits, 0);
  assert.equal(onResult(s, result(), { now: 1000 }).state.idle, 1);
});

test('only tools that change files count as edits', () => {
  let s = begin();
  for (const name of ['Read', 'Bash', 'Grep']) s = noteTool(s, name);
  assert.equal(s.edits, 0);
  for (const name of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) s = noteTool(s, name);
  assert.equal(s.edits, 4);
});

test('the session block and the header line say what is left', () => {
  const s = begin({ tier: 'opus', pass: 4, tokens: 612_000 });
  assert.equal(sessionBlock(s, min(49)), '<spark-session>marathon pass 4 · 41m left of 1h30m · 612k of 2M tokens spent · model opus</spark-session>');
  assert.equal(sessionBlock({ ...s, tier: undefined }, min(49)).includes('model'), false);
  assert.equal(statusLine(s, min(49)), '⏱ 41m left · 612k/2M tokens · pass 4');
  assert.equal(statusLine(s, min(100)), '⏱ 0s left · 612k/2M tokens · pass 4');
  assert.equal(summary(s, min(49)), '4 passes · 49m · 612k tokens');
});
```

- [ ] **Step 2:** `cd app && node --test test/marathon.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `app/lib/marathon.js` to the signatures above. Rules to encode: `parseMarathon` takes `--time`/`--tokens` anywhere in the text, strips sentence punctuation after a value, rejects zero, keeps the task's words and quotes untouched; `onResult` order is failed turn, then time, then tokens, then question, then idle/step-up, then the pass; the lens for pass `n` is `LENSES[(n - 2) % 6]`; every pass text is `lens + "\n\n" + RULE + "\n\n" + sessionBlock`, where RULE ends with `If you find nothing, reply "Nothing found." and stop.`
- [ ] **Step 4:** run again → PASS.

### Task 4: Spark's rules explain `<spark-session>`

**Files:** Modify `plugin/hooks/misp.ts`; create `plugin/test/marathon.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import { expect, test } from 'claude-code/testing'
import { MISP } from '../hooks/misp'

test('the rules explain the session block', () => {
  expect(MISP).toContain('## Work sessions')
  expect(MISP).toContain('<spark-session> after a prompt means the user set a work session with a time and token budget.')
  expect(MISP).toContain('Spark sends the next pass when you finish, until a budget runs out. Don\'t wind down or write a long summary.')
})
```

Match the imports of `plugin/test/review.test.ts`.
- [ ] **Step 2:** `claude plugin test plugin` → FAIL.
- [ ] **Step 3: Implement** a `## Work sessions` section in `MISP`, between `## Modes` and `## Subagents`:

```
## Work sessions
<spark-session> after a prompt means the user set a work session with a time and token budget. Spark sends the next pass when you finish, until a budget runs out. Don't wind down or write a long summary.
- A pass names one thing to check. Do that and nothing else.
- Change code only for a requirement or a failing test, test first. If you find nothing, reply "Nothing found." and stop.
- A stronger model may take over mid-session. The block names the model.
```

- [ ] **Step 4:** PASS.

### Task 5: Wire it into the app

**Files:** Modify `app/main.js`, `app/preload.cjs`, `app/renderer.js`. Pure wiring; its logic is tested in Tasks 1–3, and Task 7 runs it for real.

- [ ] **Step 1: main.js.** Import from `./lib/marathon.js` and `setModel` from `./lib/stream.js`; drop the local `EDIT_TOOLS` for the shared one. State: `marathon` (null or state), `switching` (`{id, tier}`), `origin` (picker model at start), `switched` (bool). In the stdout loop, after `send('event', event)`: `if (marathon) marathonEvent(event)`; on `init` also set `marathon.tier = tierOf(event.model) ?? marathon.tier`. `marathonEvent`: `tool` → `noteTool`; `control` matching `switching.id` → on ok set tier, `switched = true`, `send('marathon', {kind:'switched', tier, state})`, else `send('marathon', {kind:'switch-failed', tier, error})`; `result` → `onResult(marathon, event, {now: Date.now(), top: loadConfig().marathonTop === 'fable' ? 'fable' : 'opus'})`, store state, then `end` → `endMarathon(reason, true)`, `send` → write `setModel` (if `switchTo`) then the pass as `userMessage({text})` to `claude.stdin` and `send('marathon', {kind:'pass', state})`. `endMarathon(reason, restore)`: clear state, `send('marathon', {kind:'end', reason, summary})`, and when `restore && switched` write `setModel(id, CLAUDE_MODELS.has(origin) ? origin : undefined)`. `send-message`: when `marathon`, `marathon = userSent(marathon)` and append `sessionBlock` to the text. `ipcMain.on('marathon')`: `start` sets state (`tier` from the last init model, else the picker's model), `origin`, `switched = false`; `stop` → `endMarathon('stopped', true)`. `stop`, `new-chat`, `open-folder` handlers and the child `exit` handler call `endMarathon(..., false)`.
- [ ] **Step 2: preload.cjs.** `marathon: (message) => ipcRenderer.send('marathon', message)`.
- [ ] **Step 3: renderer.js.** Import `parseMarathon`, `statusLine` from `./lib/marathon.js`. `marathonCommand(args)` as in the spec: errors keep the typed text in the box; `status` shows `statusLine` or the usage hint; `stop` sends `stop`; Gemini model → note "marathon needs Claude"; already running → note; otherwise `spark.marathon({action:'start', task, limits})`, `sendNow(task)`, then a chat line with the budget, plus a tip when auto-accept edits is off. `spark.on('marathon')` keeps `marathonState`, appends a chat line for `pass`, `switched`, `switch-failed` and `end`, sets busy and resets `turnTools` on `pass`, sets `model = tier` on `switched`, and calls `renderStatus()`. `renderStatus` appends `statusLine` when a marathon runs; a 15-second interval refreshes it.
- [ ] **Step 4:** `cd app && npm test` → PASS. Load the `spark:ui-taste` skill and apply it to the header segment and the chat lines.

### Task 6: README

**Files:** Modify `README.md`.

- [ ] Add a `/marathon` row to the app's feature list and a short section: what it does, the flags, the budgets' meaning (time keeps it going, tokens cap it), the step-up rule and `marathonTop`, what it costs (cache re-read on switch, idle passes), and the three limits from the spec's Not covered list.

### Task 7: Real run

- [ ] Drive `claude -p` on haiku with the same flags `main.js` uses, a throwaway folder and `--time 90s --tokens 50k`, through `parseLine` and `onResult`. Expect: pass 2 goes out after the task, `Nothing found.` replies, a switch request after two idle passes if half the time is left, and an end at the time limit. Record the real output.

### Task 8: Terminal (only if feasible)

- [ ] Probe whether a plugin can submit the next prompt (`$.prompt.submit`) and switch models (`$.command.run({command:'model'})`) in a real session. If both work, write the plugin version test first with the fake engine; if not, say so in the README and stop.
