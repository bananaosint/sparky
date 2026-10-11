// Councils in the app: the pre-flight (brief, panel, estimates, consent, limits), the run in the
// background, cancel, the saved record under .spark/councils/, and the hand-off to a mission.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CANDIDATES, MODES, briefPrompt, briefText, estimate, parseBrief, pickCouncil } from '../staged/plugin/hooks/council.ts';
import { runCouncil } from '../staged/plugin/hooks/council-run.ts';
import { parseMissionBlock } from '../staged/plugin/hooks/mission.ts';

const BRIEF_SYSTEM = 'You prepare a problem brief that other models will work from without access to this project. Be exact and short. Read files; never change them.';
const isCouncilId = (id) => typeof id === 'string' && /^c-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id);
const pad = (n) => String(n).padStart(2, '0');
const councilId = (at, hex4) => {
  const d = new Date(at);
  return `c-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex4}`;
};
// Providers whose servers see the brief; Claude runs on the person's plan, Ollama on this machine.
const NEEDS_CONSENT = ['openrouter', 'gemini'];

// A seat as the window and the record keep it: the model's facts, why it was picked, its estimate.
const seatInfo = (seat, role, inputChars, mode) => ({ ...seat.candidate, reason: seat.reason, ...(seat.perspective ? { perspective: seat.perspective } : {}), estimate: estimate(seat.candidate, inputChars, role, mode) });
const seatOf = (info) => ({ candidate: info, reason: info.reason, ...(info.perspective ? { perspective: info.perspective } : {}) });

export function createCouncils({ root, makeIo, notify, now, hex4, shuffle, sleep, deadline, consents, saveConsent, budgetUsd }) {
  const dir = join(root, '.spark', 'councils');
  const runs = new Map();
  const file = (id) => join(dir, `${id}.json`);

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
      const reply = await io.call({ candidate: sonnet }, 'brief', { system: BRIEF_SYSTEM, user: briefPrompt(question), maxTokens: 6000 }, new AbortController().signal);
      const brief = parseBrief(reply.text);
      if (!brief) return { error: 'the brief came back without a brief block; ask again with a clearer question' };
      const { candidates, notes } = await io.catalogs();
      const chars = briefText(brief).length;
      const panel = pickCouncil(candidates, mode, { briefChars: chars });
      const m = MODES[mode];
      const judgeChars = chars + panel.proposers.length * m.words * 6;
      const record = {
        id: councilId(now(), hex4()),
        question,
        mode,
        createdAt: now(),
        brief,
        briefCost: reply.usd,
        panel: {
          proposers: panel.proposers.map((s) => seatInfo(s, 'proposer', chars, mode)),
          judges: panel.judges.map((s) => seatInfo(s, 'judge', judgeChars, mode)),
          synth: seatInfo(panel.synth, 'synth', judgeChars + panel.judges.length * m.judgeTokens * 4, mode),
        },
        empty: panel.empty,
        notes,
        freeLeft: await io.freeRequestsLeft(),
      };
      const seats = [...record.panel.proposers, ...record.panel.judges, record.panel.synth];
      record.estimate = { meteredUsd: Math.round(seats.reduce((n, s) => n + (s.access === 'paid-hosted' ? (s.estimate.usd ?? 0) : 0), 0) * 100) / 100, freeCalls: seats.filter((s) => s.access === 'free-hosted').length };
      record.consentNeeded = [...new Set(seats.map((s) => s.provider))].filter((p) => NEEDS_CONSENT.includes(p) && !consents()[p]);
      save(record);
      return record;
    },

    // Starts the run in the background. Every check that could stop it happens first.
    async run(id, { consent = false, dataCollection, reduced = false } = {}) {
      const council = load(id);
      if (!council) return { error: 'no such council' };
      if (runs.has(id) || council.run) return { error: 'this council already ran' };
      if (council.consentNeeded.length && !consent) return { error: `consent needed to send the brief to ${council.consentNeeded.join(' and ')}` };
      if (council.empty.length && !reduced) return { error: `the panel is short (${council.empty.join(', ')} empty): run with a reduced panel` };
      if (council.panel.proposers.length < 2 || council.panel.judges.length < 2) return { error: 'a council needs at least 2 proposers and 2 judges' };
      if (council.estimate.meteredUsd > budgetUsd()) return { error: `the estimate ($${council.estimate.meteredUsd.toFixed(2)}) is over your cap ($${budgetUsd().toFixed(2)}); raise councilBudgetUsd or run Light` };
      const choice = dataCollection ?? consents().openrouter?.dataCollection ?? 'deny';
      for (const p of council.consentNeeded) saveConsent(p, choice);
      const io = makeIo(choice);
      const controller = new AbortController();
      const panel = { proposers: council.panel.proposers.map(seatOf), judges: council.panel.judges.map(seatOf), synth: seatOf(council.panel.synth), empty: council.empty };
      Object.assign(council, { consentNeeded: [], dataCollection: choice, reduced: council.empty.length > 0 });
      const promise = runCouncil({
        brief: council.brief,
        panel,
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

    // The synthesis's acceptance criteria and the synthesis itself, for missions.fromPlan.
    toMission(id) {
      const council = load(id);
      const synthesis = council?.run?.synthesis;
      if (!synthesis) return { error: 'this council has no synthesis to start from' };
      const drafted = parseMissionBlock(synthesis);
      if (!drafted) return { error: 'the synthesis has no mission block with acceptance criteria' };
      return { objective: council.brief.objective, criteria: drafted.criteria, plan: synthesis };
    },
  };
}
