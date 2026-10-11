// How long a turn has run, as the thread shows it: mm:ss, or hh:mm:ss once it passes an hour.
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const mmss = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return s >= 3600 ? `${two(Math.floor(s / 3600))}:${mmss}` : mmss;
}
