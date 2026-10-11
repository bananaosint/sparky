// Councils in the app: the pre-flight, the run in the background, cancel, the saved record under
// .spark/councils/, and the hand-off to a mission. The steps themselves are council-flow.ts.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CANDIDATES, briefPrompt, parseBrief } from '../staged/plugin/hooks/council.ts';
import { BRIEF_SYSTEM, councilId, isCouncilId, missionPlan, panelOf, preflightRecord, runRefusal } from '../staged/plugin/hooks/council-flow.ts';
import { runCouncil } from '../staged/plugin/hooks/council-run.ts';

export function createCouncils({ root, makeIo, notify, now, hex4, shuffle, sleep, deadline, consents, saveConsent, budgetUsd }) {
  const dir = join(root, '.spark', 'councils');
  const runs = new Map();
  const file = (id) => join(dir, `${id}.json`);
  // The brief being written, so the waiting card can cancel it.
  let briefing = null;
  const BRIEF_MS = 180_000;

  function save(council) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file(council.id)}.tmp`, JSON.stringify(council, null, 2));
    renameSync(`${file(council.id)}.tmp`, file(council.id));
    notify({ kind: 'council', id: council.id, council });
  }

  function load(id) {
    if (!isCouncilId(id) || !existsSync(file(id))) return undefined;
    try {
      const c = JSON.parse(readFileSync(file(id), 'utf8'));
      return c?.id === id ? c : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async preflight(question, mode) {
      const io = makeIo('deny');
      const sonnet = CLAUDE_CANDIDATES.find((c) => c.id === 'sonnet');
      const controller = new AbortController();
      const mine = { controller, io, why: '' };
      briefing = mine;
      void deadline(BRIEF_MS).then(() => {
        mine.why ||= 'no brief within 3 minutes; ask again, or with a narrower question';
        controller.abort();
      });
      let reply;
      try {
        reply = await io.call({ candidate: sonnet }, 'brief', { system: BRIEF_SYSTEM, user: briefPrompt(question), maxTokens: 6000 }, controller.signal);
      } catch (err) {
        return { error: mine.why || err.message };
      } finally {
        if (briefing === mine) briefing = null;
      }
      if (mine.why) return { error: mine.why };
      const brief = parseBrief(reply.text);
      if (!brief) return { error: 'the brief came back without a brief block; ask again with a clearer question' };
      const { candidates, notes } = await io.catalogs();
      const at = now();
      const record = preflightRecord({ id: councilId(at, hex4()), question, mode, at, brief, briefCost: reply.usd, candidates, notes, freeLeft: await io.freeRequestsLeft(), consents: consents() });
      save(record);
      return record;
    },

    // Starts the run in the background. Every check that could stop it happens first.
    async run(id, { consent = false, dataCollection, reduced = false } = {}) {
      const council = load(id);
      if (!council) return { error: 'no such council' };
      if (runs.has(id) || council.run) return { error: 'this council already ran' };
      const refusal = runRefusal(council, { consent, reduced }, budgetUsd());
      if (refusal) return { error: refusal };
      // The window always sends a choice; it counts only while the OpenRouter consent is being given.
      const asked = council.consentNeeded.includes('openrouter') ? dataCollection : consents().openrouter?.dataCollection;
      const choice = asked === 'allow' ? 'allow' : 'deny';
      for (const p of council.consentNeeded) saveConsent(p, choice);
      const io = makeIo(choice);
      const controller = new AbortController();
      Object.assign(council, { consentNeeded: [], dataCollection: choice, reduced: council.empty.length > 0 });
      const promise = runCouncil({
        brief: council.brief,
        panel: panelOf(council),
        mode: council.mode,
        call: io.call,
        notify: ({ record }) => save({ ...council, run: record }),
        shuffle,
        sleep,
        deadline,
        signal: controller.signal,
      }).then((record) => {
        runs.delete(id);
        save({ ...council, run: record });
        return record;
      });
      runs.set(id, { controller, io, promise });
      return { started: true };
    },

    cancelBrief() {
      if (!briefing) return { error: 'no brief is being written' };
      briefing.why = 'you cancelled the brief';
      briefing.controller.abort();
      briefing.io.killAll();
      return { cancelled: true };
    },

    finished: (id) => runs.get(id)?.promise ?? Promise.resolve(load(id)?.run),

    cancel(id) {
      const run = runs.get(id);
      if (!run) return { error: 'that council is not running' };
      run.controller.abort();
      run.io.killAll();
      return { cancelled: true };
    },

    list: () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isCouncilId).sort().reverse().map(load).filter(Boolean) : []),

    view: load,

    toMission(id) {
      const council = load(id);
      return council ? missionPlan(council) : { error: 'no such council' };
    },
  };
}
