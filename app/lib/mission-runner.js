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
  approvedPlan,
  criteriaCount,
  draftText,
  isSessionId,
  move,
  newMission,
  permissionRecord,
  processRecord,
  recordsFor,
  resumeFailed,
  resumeText,
  runText,
  turnEnded,
  youRecord,
} from '../staged/plugin/hooks/mission.ts';
import { buildReport, describe, gitFacts, reportSections, totals } from '../staged/plugin/hooks/mission-report.ts';
import { afterCheck, layers, nextTask, retryText, taskStates, taskText } from '../staged/plugin/hooks/plan.ts';
import { numstat, pinSnapshot } from '../staged/plugin/hooks/snapshot.ts';

// The id of the plan-mode request, so its refusal can be told apart from other control answers.
const PLAN = 'mission-plan';
// A task record's snapshot reaches git: only a full commit id is used.
const SHA = /^[0-9a-f]{40}$/;

// `store`: lib/mission-store.js for the folder. `write`: one line for Claude Code's stdin.
// `notify`: one message for the window. `run`: git in the repo (snapshot.ts's Run), or undefined
// outside one. `verify(mission, onResult)`: Spark's own checks (lib/verify-run.js), each result
// handed to onResult as it finishes. `checkTask(mission, task, attempt)`: one task's check, the
// same way. `now`: the clock in ms. `hex4`: four random hex digits for ids.
export function createMissionRunner({ store, write, notify, run, verify, checkTask, now, hex4 }) {
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

  // A pass whose checks could not run is still a pass: it reads as "Not verified", and says why.
  // The results are kept here as they come: the report is built from these, not from the disk.
  async function checks(mission, again) {
    const pass = { at: now(), again, checks: [] };
    record(mission, [{ at: pass.at, kind: 'verify', again }]);
    notify({ kind: 'verifying', id: mission.id, again });
    await verify(mission, (result) => {
      pass.checks.push(result);
      record(mission, [{ at: now(), kind: 'check', ...result }]);
    }).catch((err) => notify({ kind: 'error', id: mission.id, error: `Spark's checks could not run: ${err.message}` }));
    return pass;
  }

  async function report(mission, { again = false } = {}) {
    const { mission: ended, facts } = await gitFacts(run, mission, now());
    store.save(ended);
    const pass = verify && (again || ended.status === 'finished' || ended.status === 'blocked') ? await checks(ended, again) : undefined;
    const built = buildReport(ended, store.read(ended.id).records, facts, pass);
    store.saveReport(ended.id, built);
    notify({ kind: 'report', id: ended.id, mission: ended, sections: reportSections(built) });
  }

  function later(mission, options) {
    queue = queue.then(() => report(mission, options)).catch((err) => notify({ kind: 'error', id: mission.id, error: err.message }));
  }

  function draft(objective) {
    write(setPermissionMode(PLAN, 'plan'));
    write(userMessage({ text: draftText(objective) }));
  }

  // ---------- tasks: one turn each, checked by Spark (plan.ts decides) ----------

  const pin = (m, name) => (run ? pinSnapshot(run, `refs/spark/missions/${m.id}/${name}`, `mission ${m.id} ${name}`).catch(() => undefined) : Promise.resolve(undefined));

  function startTask(m, task, base) {
    record(m, [{ at: now(), kind: 'task', id: task.id, event: 'started', attempt: 1, ...(base ? { base } : {}) }]);
  }

  // Every task is done, or one failed for good: the mission ends, and its report follows.
  async function finishTasks(m) {
    const states = taskStates(m.tasks, store.read(m.id).records, { over: false });
    const failed = m.tasks.find((t) => states[t.id].state === 'failed');
    await report(step(m, failed ? 'blocked' : 'finished', failed ? `task ${failed.id}'s check failed twice` : 'every task is done'));
  }

  // A task's turn ended: what it changed, its check, then a retry, the next task, or the end.
  async function taskTurnEnded(m) {
    const records = store.read(m.id).records;
    const states = taskStates(m.tasks, records, { over: false });
    const current = m.tasks.find((t) => states[t.id].state === 'running');
    if (!current) return finishTasks(m);
    const attempt = states[current.id].attempts;
    const base = records.filter((r) => r.kind === 'task' && r.id === current.id && r.event === 'started').at(-1)?.base;
    const end = await pin(m, `task-${current.id}-${attempt}`);
    const files = SHA.test(base ?? '') && end ? await numstat(run, base, end).catch(() => undefined) : undefined;
    const check = current.check && checkTask ? await checkTask(m, current, attempt).catch((err) => ({ name: `task ${current.id}`, status: 'fail', reason: err.message })) : undefined;
    const decision = afterCheck(current, attempt, check);
    record(m, [
      {
        at: now(),
        kind: 'task',
        id: current.id,
        event: decision.event,
        attempt: decision.event === 'retry' ? attempt + 1 : attempt,
        ...(files ? { files } : {}),
        ...(check ? { check } : {}),
        ...(decision.note ? { note: decision.note } : {}),
      },
    ]);
    // ■ or Cancel while the check ran: the result is kept, and Resume carries on from it.
    const now_ = store.read(m.id).mission;
    if (now_.status !== 'running') return;
    if (decision.event === 'retry') {
      write(userMessage({ text: retryText(current, check) }));
      return commit(now_);
    }
    const next = decision.event === 'done' ? nextTask(m.tasks, taskStates(m.tasks, store.read(m.id).records, { over: false })) : undefined;
    if (!next) return finishTasks(now_);
    startTask(now_, next, end);
    write(userMessage({ text: taskText(next) }));
    commit(now_);
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
    else if (m.status === 'running' && done.mission.status === 'running' && done.mission.tasks?.length)
      queue = queue.then(() => taskTurnEnded(done.mission)).catch((err) => notify({ kind: 'error', id: m.id, error: err.message }));
  }

  function interrupted(reason, { detach = false } = {}) {
    if (active && LIVE.has(active.status)) step(active, 'interrupted', reason);
    if (!detach || !active) return;
    // The window keeps a mission in its header until it hears this one is no longer its own.
    const left = active;
    active = null;
    notify({ kind: 'state', mission: left, active: false });
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

    // A Council synthesis becomes a mission straight in review: its criteria are already drafted.
    fromPlan(objective, criteria, plan, { sessionId } = {}) {
      if (active) return { error: `mission "${active.title}" is ${active.status}: cancel it first` };
      if (!criteria.length) return { error: 'the council plan has no acceptance criteria to start from' };
      const { mission, record: first } = newMission(objective, now(), hex4(), store.gateSize(), { criteria, plan });
      active = { ...mission, ...(isSessionId(sessionId) ? { sessionId } : {}) };
      commit(active, [first]);
      notify({ kind: 'review', mission: active });
      return { mission: active };
    },

    onEvent(event) {
      if (!active) return;
      if (event.kind === 'init' && (event.sessionId !== active.sessionId || event.model !== active.model))
        commit({ ...active, ...(isSessionId(event.sessionId) ? { sessionId: event.sessionId } : {}), ...(event.model ? { model: event.model } : {}) });
      if (event.kind === 'control' && event.id === PLAN && !event.ok) record(active, [processRecord('plan-mode-refused', now(), { error: event.error })]);
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

    // `sentTasks`: the tasks the card kept, as edited; [] runs the mission as one piece.
    async approve(id, sent, sentTasks) {
      if (active?.id !== id || active.status !== 'review') return { error: 'that mission is not waiting for approval' };
      const criteria = approvedCriteria(active.criteria, sent);
      if (!criteria.length) return { error: 'a mission needs at least one criterion' };
      const tasks = active.tasks ? approvedPlan(active.tasks, sentTasks === undefined ? active.tasks : sentTasks) : [];
      const startSha = run ? await pinSnapshot(run, `refs/spark/missions/${id}/start`, `mission ${id} start`).catch(() => undefined) : undefined;
      if (active?.id !== id || active.status !== 'review') return { error: 'the mission changed while its snapshot was taken' };
      const base = { ...active, criteria };
      delete base.tasks;
      if (tasks.length) base.tasks = tasks;
      const m = step(base, 'running', `you approved ${criteriaCount(criteria.length)}${tasks.length ? ` and ${tasks.length} tasks` : ''}`, {
        approvedAt: now(),
        ...(startSha ? { startSha } : {}),
      });
      if (tasks.length) startTask(m, tasks[0], startSha);
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
      record(active, [processRecord('exited', now(), { code, error })]);
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
      record(m, [processRecord(fresh ? 'started' : 'resumed', now())]);
      if (m.approvedAt === undefined) {
        const next = step(m, 'draft', 'drafting again');
        draft(next.objective);
        return { mission: next };
      }
      const next = step(m, 'running', fresh ? 'resumed in a fresh session' : 'resumed');
      // The task it was on goes again; if that one had ended, the next one starts.
      let current;
      if (next.tasks?.length) {
        const states = taskStates(next.tasks, store.read(id).records, { over: false });
        current = next.tasks.find((t) => states[t.id].state === 'running');
        if (!current) {
          current = nextTask(next.tasks, states);
          if (current) startTask(next, current);
        }
      }
      write(userMessage({ text: resumeText(next, current) }));
      return { mission: next };
    },

    // On opening a folder nothing runs yet, so a mission still marked live was cut off.
    // A mission that can't be written (a read-only folder from the repo) is left as it is; the
    // others are still marked.
    recover() {
      for (const m of store.list()) {
        if (m.unreadable || !LIVE.has(m.status)) continue;
        try {
          step(m, 'interrupted', 'Spark closed while it ran');
        } catch {}
      }
    },

    // The checks again on the working tree as it is now. Not while a mission runs: its edits would
    // race the checks.
    checkAgain(id) {
      if (active && LIVE.has(active.status)) return { error: `mission "${active.title}" is ${active.status}: check again once it stops` };
      const m = store.read(id)?.mission;
      if (!verify || !m || !FINAL.has(m.status)) return { error: 'only an ended mission is checked again' };
      later(m, { again: true });
      return { ok: true };
    },

    list: () => store.list(),

    view(id) {
      const found = store.read(id);
      if (!found) return undefined;
      const { tasks } = found.mission;
      // Each task with its state, and the timeline rows from its turns.
      const plan = tasks?.length
        ? (() => {
            const states = taskStates(tasks, found.records, { over: FINAL.has(found.mission.status) });
            return {
              layers: layers(tasks),
              tasks: tasks.map((t) => {
                const v = states[t.id];
                const within = found.records.filter((r) => v.from !== undefined && r.at >= v.from && r.at <= (v.to ?? Infinity));
                const { check: checkResult, ...state } = v;
                return { ...t, ...state, ...(checkResult ? { checkResult } : {}), rows: within.map(describe).filter(Boolean) };
              }),
            };
          })()
        : undefined;
      return {
        mission: found.mission,
        ...(plan ? { plan } : {}),
        rows: found.records.map(describe).filter(Boolean),
        totals: totals(found.records),
        sections: found.report ? reportSections(found.report) : undefined,
        active: active?.id === id,
      };
    },
  };
}
