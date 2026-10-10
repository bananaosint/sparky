// The window's side of Spark's command gate. Headless Claude Code hands a gate ask to the
// approval card with the tool and input only, so the window judges the command again: a gate
// ask always reaches the person, whatever was allowed before, and the card says why.
import { classify } from '../staged/plugin/hooks/gate.ts';

export function gateNote(tool, input, ctx) {
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof input?.command !== 'string') return undefined;
  const v = classify(input.command, tool === 'Bash' ? 'bash' : 'powershell', ctx);
  return v?.kind === 'ask' ? v.reason : undefined;
}
