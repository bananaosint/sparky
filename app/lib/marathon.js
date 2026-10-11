// A marathon: Claude is kept working, in short review passes, until a time or token budget
// is spent. This file only decides; main.js sends the messages and the window shows them.

export const DEFAULT_LIMITS = { timeMs: 30 * 60_000, tokens: 500_000 };
// Tools that only change files: "auto-accept edits" lets these run, and a pass that calls none changed nothing.
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const UNITS_TOKENS = { '': 1, k: 1000, m: 1_000_000 };
// Weakest to strongest. Fable is only reached when the user allows it.
const LADDER = ['haiku', 'sonnet', 'opus', 'fable'];
// One idle pass can be a lens with nothing to find (the test run); two in a row mean the model is out of ideas.
const IDLE_BEFORE_STEP_UP = 2;
// A stronger model pays off while there is time to use it.
const STEP_UP_WHILE_LEFT = 0.5;
// Passes that find nothing keep re-reading an unchanged project at a few thousand tokens each. Once a
// stronger model can't help, they back off like a watcher: 15s, doubling, at most 5 minutes.
const BACKOFF_START_MS = 15_000;
const BACKOFF_CAP_MS = 5 * 60_000;

// Each pass checks one thing. "Keep improving" with no lens would fight Spark's own YAGNI rule.
const LENSES = [
  'Check the original request line by line against the code and the tests. Fix anything missing or wrong.',
  'Hunt for bugs: empty and huge inputs, error paths, off-by-one cases, anything that can throw. Reproduce each with a failing test, then fix it.',
  'Run the full test suite and the build. Fix any failure at its cause.',
  'Simplify what you wrote: remove dead code, single-caller helpers and needless abstraction. The tests stay green.',
  'Attack it: hostile input, injection, unsafe paths, data lost when something fails halfway. Reproduce each hole with a test, then close it.',
  'Read the docs, comments and names you touched. Make them say what the code does now.',
];
const RULE = 'Change code only for a requirement or a failing test, and write the test first. If you find nothing, reply "Nothing found." and stop.';

const FLAG = /\s*--(time|tokens)(?=\s|$)(?:\s+(\S+))?/g;

// `fix the parser --time 1.5h --tokens 2m`: the task, then optional limits, as /goal reads them.
export function parseMarathon(args) {
  const text = args.trim();
  if (!text) return { status: true };
  if (text.toLowerCase() === 'stop') return { stop: true };
  const limits = { ...DEFAULT_LIMITS };
  for (const [, flag, raw = ''] of text.matchAll(FLAG)) {
    // A sentence's full stop or comma after the value is not part of it.
    const value = raw.toLowerCase().replace(/[.,;:!]+$/, '');
    const m = flag === 'time' ? /^(\d+(?:\.\d+)?)([smh])$/.exec(value) : /^(\d+(?:\.\d+)?)([km]?)$/.exec(value);
    if (!m) return { error: flag === 'time' ? '--time takes a duration like 45m, 90s or 1.5h' : '--tokens takes a count like 200k or 2m' };
    const amount = Number(m[1]) * (flag === 'time' ? UNITS_MS : UNITS_TOKENS)[m[2]];
    if (amount <= 0) return { error: `--${flag} must be above zero` };
    limits[flag === 'time' ? 'timeMs' : 'tokens'] = amount;
  }
  const task = text.replace(FLAG, '').trim();
  return task ? { task, limits } : { error: 'say what to work on, e.g. /marathon fix the parser --time 1.5h --tokens 2m' };
}

export const tierOf = (model) => LADDER.find((tier) => (model ?? '').toLowerCase().includes(tier));

export const startMarathon = ({ task, limits, now, tier }) => ({ task, limits, startedAt: now, tokens: 0, pass: 1, forced: false, edits: 0, idle: 0, tier });

export const noteTool = (state, name) => (EDIT_TOOLS.has(name) ? { ...state, edits: state.edits + 1 } : state);

// What the user typed is not a pass: it can't count as idle, and it starts the pace over.
export const userSent = (state) => ({ ...state, forced: false, edits: 0, idle: 0 });

const nextTier = (tier, top) => {
  const at = LADDER.indexOf(tier);
  const cap = top === 'fable' ? LADDER.length - 1 : LADDER.indexOf('opus');
  return at >= 0 && at < cap ? LADDER[at + 1] : undefined;
};

const backoff = (idle) => (idle < IDLE_BEFORE_STEP_UP ? 0 : Math.min(BACKOFF_START_MS * 2 ** (idle - IDLE_BEFORE_STEP_UP), BACKOFF_CAP_MS));

const left = (state, now) => Math.min(1 - (now - state.startedAt) / state.limits.timeMs, 1 - state.tokens / state.limits.tokens);

// A turn just ended. Says whether the marathon is over, waits for the user, or sends the next pass
// (after how long, and on which model). The state it returns replaces the old one.
export function onResult(state, event, { now, top = 'opus' }) {
  const tokens = state.tokens + event.usage.input + event.usage.output + event.usage.cacheWrite;
  const spent = { ...state, tokens };
  const end = (reason) => ({ state: spent, next: { kind: 'end', reason } });
  if (!event.ok) return end(`a turn failed: ${event.text.slice(0, 200)}`);
  if (now - state.startedAt >= state.limits.timeMs) return end('time is up');
  if (tokens >= state.limits.tokens) return end('token budget spent');
  if (/\?\s*$/.test(event.text)) return { state: spent, next: { kind: 'wait' } };
  const idle = state.forced ? (state.edits === 0 ? state.idle + 1 : 0) : state.idle;
  const up = idle >= IDLE_BEFORE_STEP_UP && left(spent, now) >= STEP_UP_WHILE_LEFT ? nextTier(state.tier, top) : undefined;
  const pass = state.pass + 1;
  const next = { ...spent, pass, forced: true, edits: 0, idle: up ? 0 : idle };
  return { state: next, next: { kind: 'send', delayMs: backoff(next.idle), ...(up ? { switchTo: up } : {}) } };
}

// The message for the pass `state` is on, written when it is sent so the block's figures are current.
// `tier` is the model it will run on, when that is about to change.
export const passText = (state, now, tier = state.tier) =>
  `${LENSES[(state.pass - 2) % LENSES.length]}\n\n${RULE}\n\n${sessionBlock({ ...state, tier }, now)}`;

const short = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// Seconds only matter on a short clock.
export const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  if (m >= 10) return `${m}m`;
  if (m) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${s}s`;
};

// The facts Claude gets with every message in a marathon; Spark's rules say what they mean.
export const sessionBlock = (state, now) =>
  `<spark-session>marathon pass ${state.pass} · ${clock(state.limits.timeMs - (now - state.startedAt))} left of ${clock(state.limits.timeMs)} · ${short(state.tokens)} of ${short(state.limits.tokens)} tokens spent${state.tier ? ` · model ${state.tier}` : ''}</spark-session>`;

export const statusLine = (state, now) =>
  `⏱ ${clock(state.limits.timeMs - (now - state.startedAt))} left · ${short(state.tokens)}/${short(state.limits.tokens)} tokens · pass ${state.pass}`;

export const summary = (state, now) =>
  `${state.pass} ${state.pass === 1 ? 'pass' : 'passes'} · ${clock(now - state.startedAt)} · ${short(state.tokens)} tokens`;
