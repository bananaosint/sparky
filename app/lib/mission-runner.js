// Runs missions against the live Claude Code process, as marathon-runner.js runs marathons:
// mission.ts decides, the store keeps the records, and the process, git and clock come in from
// main.js, so none of this needs Electron to be tested.
import { setPermissionMode, userMessage } from './stream.js';
import {
  DRAFT_DENIAL,
  DRAFT_DENIED,
  FINAL,
  LIVE,
  approvedCriteria,
  draftText,
  isSessionId,
  move,
  newMission,
  permissionRecord,
  recordsFor,
  resumeFailed,
  resumeText,
  runText,
  turnEnded,
  youRecord,
} from '../staged/plugin/hooks/mission.ts';
import { buildReport, describe, gitFacts, reportSections, totals } from '../staged/plugin/hooks/mission-report.ts';
import { pinSnapshot } from '../staged/plugin/hooks/snapshot.ts';

// The id of the plan-mode request, so its refusal can be told apart from other control answers.
const PLAN = 'mission-plan';

// `store`: lib/mission-store.js for the folder. `write`: one line for Claude Code's stdin.
// `notify`: one message for the window. `run`: git in the repo (snapshot.ts's Run), or undefined
// outside one. `now`: the clock in ms. `hex4`: four random hex digits for ids.
export function createMissionRunner({ store, write, notify, run, now, hex4 }) {
  // The mission this window runs, until it ends or the window moves on.
  let active = null;
  // Reports wait on git; they run one after another so records stay in order.
  let queue = Promise.resolve();

  function record(mission, records) {
    for (const r of records) {
      store.append(mission.id, r);
      const row = describe(r);
      if (row) notify({ kind: 'row', id: mission.id, row });
    }
  }

  function commit(mission, records = []) {
    store.save(mission);
    record(mission, records);
    if (active?.id === mission.id) active = FINAL.has(mission.status) ? null : mission;
    notify({ kind: 'state', mission, active: active?.id === mission.id });
    return mission;
  }

  function step(mission, to, reason, more = {}) {
    const moved = move(mission, to, reason, now());
    return commit({ ...moved.mission, ...more }, [moved.record]);
  }

  async function report(mission) {
    const { mission: ended, facts } = await gitFacts(run, mission, now());
    store.save(ended);
    const built = buildReport(ended, store.read(ended.id).records, facts);
    store.saveReport(ended.id, built);
    notify({ kind: 'report', id: ended.id, mission: ended, sections: reportSections(built) });
  }

  function later(mission) {
    queue = queue.then(() => report(mission)).catch((err) => notify({ kind: 'error', id: mission.id, error: err.message }));
  }

  function draft(objective) {
    write(setPermissionMode(PLAN, 'plan'));
    write(userMessage({ text: draftText(objective) }));
  }

  function turnEnd(event) {
    const m = active;
    if (m.status !== 'draft' && m.status !== 'running') return;
    const gates = store.gateSince(m.gateOffset);
    const done = turnEnded(m, store.read(m.id).records, { ok: event.ok, text: event.text }, gates.records, gates.offset, now());
    commit(done.mission, done.records);
    if (m.status === 'draft') {
      write(setPermissionMode('mission-default', 'default'));
      notify({ kind: 'review', mission: done.mission });
    }
    if (FINAL.has(done.mission.status)) later(done.mission);
  }

  function interrupted(reason, { detach = false } = {}) {
    if (active && LIVE.has(active.status)) step(active, 'interrupted', reason);
    if (detach) active = null;
  }

  return {
    busy: () => Boolean(active && LIVE.has(active.status)),
    idle: () => queue,

    start(objective, { sessionId } = {}) {
      if (active) return { error: `mission "${active.title}" is ${active.status}: cancel it first` };
      if (!objective.trim()) return { error: 'a mission needs an objective: /mission <what should be true when it is done>' };
      const { mission, record: first } = newMission(objective, now(), hex4(), store.gateSize());
      active = { ...mission, ...(isSessionId(sessionId) ? { sessionId } : {}) };
      commit(active, [first]);
      draft(objective);
      return { mission: active };
    },

    onEvent(event) {
      if (!active) return;
      if (event.kind === 'init' && (event.sessionId !== active.sessionId || event.model !== active.model))
        commit({ ...active, ...(isSessionId(event.sessionId) ? { sessionId: event.sessionId } : {}), ...(event.model ? { model: event.model } : {}) });
      if (event.kind === 'control' && event.id === PLAN && !event.ok)
        record(active, [{ at: now(), kind: 'process', event: 'plan-mode-refused', error: String(event.error ?? '') }]);
      record(active, recordsFor(event, now()));
      if (event.kind === 'result') turnEnd(event);
    },

    // The bridge asks before a tool runs: a draft only reads, whatever "always allow" says.
    draftDenial(tool, input) {
      if (active?.status !== 'draft' || !DRAFT_DENIED.has(tool)) return undefined;
      record(active, [permissionRecord(tool, input, 'auto-denied', now())]);
      return DRAFT_DENIAL;
    },

    permission(tool, input, decision, gate) {
      if (active) record(active, [permissionRecord(tool, input, decision, now(), gate)]);
    },

    you(text) {
      if (!active) return;
      record(active, [youRecord(text, now())]);
      if (active.status === 'waiting' || active.status === 'paused') step(active, 'running', 'you wrote to Claude');
    },

    async approve(id, sent) {
      if (active?.id !== id || active.status !== 'review') return { error: 'that mission is not waiting for approval' };
      const criteria = approvedCriteria(active.criteria, sent);
      if (!criteria.length) return { error: 'a mission needs at least one criterion' };
      const startSha = run ? await pinSnapshot(run, `refs/spark/missions/${id}/start`, `mission ${id} start`).catch(() => undefined) : undefined;
      if (active?.id !== id || active.status !== 'review') return { error: 'the mission changed while its snapshot was taken' };
      const m = step({ ...active, criteria }, 'running', `you approved ${criteria.length} criteria`, { approvedAt: now(), ...(startSha ? { startSha } : {}) });
      write(userMessage({ text: runText(m) }));
      return { mission: m };
    },

    // ■: the turn is stopped, and the mission waits for Resume or for you to write.
    stopped() {
      if (active?.status === 'running' || active?.status === 'waiting') step(active, 'paused', 'you pressed stop');
      else if (active?.status === 'draft') step(active, 'interrupted', 'you pressed stop while it drafted');
    },

    interrupted,

    exited(code, error) {
      if (!active) return;
      record(active, [{ at: now(), kind: 'process', event: 'exited', ...(typeof code === 'number' ? { code } : {}), ...(error ? { error: String(error).slice(-500) } : {}) }]);
      interrupted('Claude Code stopped');
    },

    cancel(id) {
      const m = active?.id === id ? active : store.read(id)?.mission;
      if (!m || FINAL.has(m.status)) return { error: 'that mission is already over' };
      const stop = active?.id === id && LIVE.has(m.status);
      const ended = step(m, 'cancelled', 'you cancelled it');
      later(ended);
      return { mission: ended, stop };
    },

    // `restart(sessionId)` starts Claude Code on that session, or a fresh one when it is undefined.
    resume(id, restart) {
      if (active && active.id !== id) return { error: `mission "${active.title}" is ${active.status}: finish or cancel it first` };
      const found = store.read(id);
      const m = active?.id === id ? active : found?.mission;
      if (!m || (m.status !== 'paused' && m.status !== 'interrupted')) return { error: 'only a paused or interrupted mission resumes' };
      const fresh = !isSessionId(m.sessionId) || resumeFailed(found?.records ?? []);
      active = m;
      restart(fresh ? undefined : m.sessionId);
      record(m, [{ at: now(), kind: 'process', event: fresh ? 'started' : 'resumed' }]);
      if (m.approvedAt === undefined) {
        const next = step(m, 'draft', 'drafting again');
        draft(next.objective);
        return { mission: next };
      }
      const next = step(m, 'running', fresh ? 'resumed in a fresh session' : 'resumed');
      write(userMessage({ text: resumeText(next) }));
      return { mission: next };
    },

    // On opening a folder nothing runs yet, so a mission still marked live was cut off.
    recover() {
      for (const m of store.list()) if (!m.unreadable && LIVE.has(m.status)) step(m, 'interrupted', 'Spark closed while it ran');
    },

    list: () => store.list(),

    view(id) {
      const found = store.read(id);
      if (!found) return undefined;
      return {
        mission: found.mission,
        rows: found.records.map(describe).filter(Boolean),
        totals: totals(found.records),
        sections: found.report ? reportSections(found.report) : undefined,
        active: active?.id === id,
      };
    },
  };
}
