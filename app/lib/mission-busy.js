// The composer's working state as mission messages arrive: the new value, or undefined to leave it.
// `activeId`: the mission the window had as its own before this message.
const OVER = new Set(['finished', 'blocked', 'cancelled']);

export function busyAfter(m, { busy, activeId }) {
  if (m.kind !== 'state') return undefined;
  // A mission that just went to running has a turn in flight (Resume, an answer, the next task).
  if (m.active && m.mission.status === 'running' && !busy) return true;
  // This window's mission ended: a planned one ends after Spark's last check, with Claude idle.
  if (!m.active && OVER.has(m.mission.status) && activeId === m.mission.id) return false;
  return undefined;
}
