import { execFile } from 'node:child_process';

const CTRL_V = '\x16';
// Windows Terminal answers Ctrl+V itself; with only an image on the clipboard it may paste nothing.
const EMPTY_PASTE = '\x1b[200~\x1b[201~';
// Claude Code's own image-paste key on Windows.
export const ALT_V = '\x1bv';

export function clipboardHasImage() {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::ContainsImage()'],
      { windowsHide: true },
      (err, out) => resolve(!err && out.trim() === 'True'),
    ),
  );
}

// Ctrl+V (or an empty paste) with an image on the clipboard becomes Claude Code's image paste.
export async function translatePaste(data, hasImage = clipboardHasImage) {
  if ((data === CTRL_V || data === EMPTY_PASTE) && (await hasImage())) return ALT_V;
  return data;
}
