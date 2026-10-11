import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyAfter } from '../lib/mission-busy.js';

// The window's composer through a planned mission's messages, in the order main sends them.
function replay(messages) {
  let busy = true;
  let activeId = null;
  for (const m of messages) {
    if (m === 'result') {
      busy = false;
      continue;
    }
    const next = busyAfter(m, { busy, activeId });
    if (next !== undefined) busy = next;
    if (m.kind === 'state') activeId = m.active ? m.mission.id : activeId === m.mission.id ? null : activeId;
  }
  return busy;
}
const state = (status, active) => ({ kind: 'state', mission: { id: 'm1', status }, active });

test("a planned mission that finishes or blocks after its last check gives the composer back", () => {
  const lastTask = [state('running', true), 'result', state('running', true), { kind: 'checking', id: 'm1', task: 't2' }, state('finished', false), { kind: 'verifying', id: 'm1' }, { kind: 'report', id: 'm1' }];
  assert.equal(replay(lastTask), false);
  assert.equal(replay([state('running', true), 'result', state('running', true), state('blocked', false)]), false);
});

test('a task that goes on keeps the composer busy, and an unrelated mission ending changes nothing', () => {
  assert.equal(replay([state('running', true), 'result', state('running', true)]), true);
  assert.equal(busyAfter(state('finished', false), { busy: true, activeId: 'other' }), undefined);
});
