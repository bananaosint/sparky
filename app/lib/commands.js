// Slash commands typed into the message box. Spark's modes, the model and effort
// pickers and /marathon are handled in the window; any other /command passes through to Claude Code.

export const MODES = { 'anti-slop': ['antislop', 'anti-slop'], 'thinking-red-team': ['red-team', 'redteam', 'thinking-red-team'], grillme: ['grillme'] };
export const MODELS = ['default', 'auto', 'ultracode', 'opus', 'sonnet', 'haiku', 'gemini'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function parseCommand(text) {
  const m = /^\/([\w:-]+)\s*(.*)$/s.exec(text.trim());
  if (!m) return null;
  const [, name, arg] = m;
  const mode = Object.keys(MODES).find((key) => MODES[key].includes(name.toLowerCase()));
  if (mode) return { kind: 'mode', mode };
  if (name === 'model' && MODELS.includes(arg.trim().toLowerCase())) return { kind: 'model', model: arg.trim().toLowerCase() };
  if (name === 'effort' && EFFORTS.includes(arg.trim().toLowerCase())) return { kind: 'effort', effort: arg.trim().toLowerCase() };
  if (name === 'marathon') return { kind: 'marathon', args: arg.trim() };
  return { kind: 'passthrough' };
}

// Active modes ride along with each message, in the block Spark's rules describe.
export const withModes = (text, modes) => (modes.length ? `${text}\n\n<spark-modes>${modes.join(', ')}</spark-modes>` : text);
