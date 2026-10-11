// Runs a marathon against a live Claude Code process: reads its stream, writes the next pass and
// model switches to it, and tells the window. marathon.js decides; the process, the window and the
// clock are passed in, so none of this needs Electron to be tested.
import { setModel, userMessage } from './stream.js';
import { startMarathon, noteTool, userSent, onResult, passText, tierOf, sessionBlock, summary } from './marathon.js';

const inTime = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

// `write` takes one JSON line for Claude Code's stdin, `notify` one message for the window,
// `now` the clock in ms, `top` the strongest model allowed ('opus' or 'fable') and `schedule`
// runs a function after a delay and returns what cancels it.
export function createMarathon({ write, notify, now, top, schedule = inTime }) {
  let state = null;
  // The model switch Claude Code hasn't answered yet.
  let switching;
  // The model the picker held when the marathon began, and whether a switch has happened since.
  let origin;
  let switched = false;
  // What the current Claude Code process reported at init.
  let lastModel;
  // Cancels the pass waiting out its backoff.
  let cancelWait;

  const timeLeft = () => state.limits.timeMs - (now() - state.startedAt);

  function sendPass(switchTo) {
    if (!state) return;
    if (timeLeft() <= 0) return end('time is up', { restore: true });
    if (switchTo) {
      switching = { id: `switch-${state.pass}`, tier: switchTo };
      write(setModel(switching.id, switchTo));
    }
    const text = passText(state, now(), switchTo);
    write(userMessage({ text }));
    notify({ kind: 'pass', state, lens: text.split('\n')[0] });
  }

  function nextPass({ switchTo, delayMs }) {
    if (!delayMs) return sendPass(switchTo);
    const ms = Math.min(delayMs, timeLeft());
    notify({ kind: 'wait', state, ms });
    cancelWait = schedule(() => {
      cancelWait = undefined;
      sendPass();
    }, ms);
  }

  // With `restore`, the process lives on, so the model goes back to what the picker names:
  // later turns shouldn't quietly run on a pricier one.
  function end(reason, { restore }) {
    if (!state) return;
    const done = state;
    state = null;
    switching = undefined;
    cancelWait?.();
    cancelWait = undefined;
    if (restore && switched) write(setModel('restore', tierOf(origin)));
    notify({ kind: 'end', reason, summary: summary(done, now()) });
  }

  return {
    start({ task, limits, picker }) {
      origin = picker;
      switched = false;
      state = startMarathon({ task, limits, now: now(), tier: tierOf(lastModel) ?? tierOf(picker) });
      notify({ kind: 'start', state });
    },
    end,
    running: () => state !== null,
    // Every restart kills the pass in flight, and no result will come to continue from.
    restarted() {
      lastModel = undefined;
      end('Claude Code restarted', { restore: false });
    },
    // A message from the window gains the session block. What the user typed is not a pass,
    // and it takes over from a pass that was waiting.
    outgoing(message) {
      if (!state) return message;
      cancelWait?.();
      cancelWait = undefined;
      state = userSent(state);
      return { ...message, text: `${message.text}\n\n${sessionBlock(state, now())}` };
    },
    onEvent(event) {
      if (event.kind === 'init') {
        lastModel = event.model;
        if (state) state = { ...state, tier: tierOf(event.model) ?? state.tier };
      }
      if (!state) return;
      if (event.kind === 'tool') state = noteTool(state, event.name);
      if (event.kind === 'control' && event.id === switching?.id) {
        const { tier } = switching;
        switching = undefined;
        if (event.ok) {
          state = { ...state, tier };
          switched = true;
        }
        notify({ kind: event.ok ? 'switched' : 'switch-failed', tier, error: event.error, state });
      }
      if (event.kind === 'result') {
        const decided = onResult(state, event, { now: now(), top: top() });
        state = decided.state;
        if (decided.next.kind === 'end') end(decided.next.reason, { restore: true });
        if (decided.next.kind === 'send') nextPass(decided.next);
      }
    },
  };
}
