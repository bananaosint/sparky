# Auto, UltraCode, Tab Tab, prompts, 3D Sparky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Test first for every behavior change.

**Goal:** the six items in the spec. **Spec:** `docs/superpowers/specs/2026-10-10-auto-ultracode-3d-design.md`
**Architecture:** pure modules in `app/lib/` (tested with `node:test`), thin wiring in `main.js` / `renderer.js`; prompt text in `plugin/hooks/` (tested with `claude plugin test`).

## Global Constraints
- No new dependency. Comments say why. Match surrounding style. Reduced motion respected.
- Auto never gives a model tools; Claude one-shots skip user settings and MCP.

## Review Focus
- Auto with every model failing, or a judge that fails: the person still sees an answer or a clear error, never a stuck "working".
- Tab Tab while cooking or busy: nothing double-sends.
- UltraCode review pass never loops (one per user turn) and never runs inside a marathon.
- 3D Sparky with `prefers-reduced-motion`: no animation loop.
- Settings with an empty Auto list: Auto refuses with a note instead of asking nobody.

### Task 1 — timer format: `app/lib/elapsed.js` `elapsed(ms)`; test `app/test/elapsed.test.js`; use in the thinking label and the done line.
### Task 2 — prompts: `plugin/hooks/gemini.ts` REWRITE_SYSTEM, `plugin/hooks/cook.ts` composeCooked line, `app/lib/cook.js` SPARKY_SYSTEM; tests in `plugin/test/cook.test.ts`, `plugin/test/gemini.test.ts`, `app/test/features.test.js`.
### Task 3 — submission: `app/lib/keys.js` `doubleTab()` detector; `cook` IPC takes `{ rewrite }`; renderer Tab Tab, cook pill removed; tests `app/test/keys.test.js`, cook skills-only test.
### Task 4 — Auto: `app/lib/auto.js` (`autoAnswer`, `judgePrompt`, `splitPicked`, `claudeArgs`, `judgeOf`); `main.js` `auto` IPC; renderer `askAuto` bubble; settings; tests `app/test/auto.test.js`.
### Task 5 — UltraCode: `app/lib/ultracode.js` (`REVIEW_PASS`, `ultraArgs`, `reviewDue`); `main.js` spawn args and review pass; tests `app/test/ultracode.test.js`.
### Task 6 — 3D Sparky: `app/lib/voxel.js` (`voxelize`, `project`); welcome canvas in `index.html`, drawing in renderer; tests `app/test/voxel.test.js`; screenshot check.
### Task 7 — README, full suites, real Auto probe, final review.
