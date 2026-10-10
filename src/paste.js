import { execFile } from 'node:child_process';

const CTRL_V = '\x16';
// Windows Terminal answers Ctrl+V itself; with only an image on the clipboard it may paste nothing.
const EMPTY_PASTE = '\x1b[200~\x1b[201~';
// Claude Code's own image-paste key on Windows.
export const ALT_V = '\x1bv';
// Claude Code turns on win32 input mode, so Ctrl+V arrives as a key event:
// ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ with V's key code 86, character 22 and key-down 1.
const WIN32_CTRL_V_DOWN = /\x1b\[86;\d+;22;1;\d+;\d+_/g;

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
  const plain = data === CTRL_V || data === EMPTY_PASTE;
  if (!plain && !data.match(WIN32_CTRL_V_DOWN)) return data;
  if (!(await hasImage())) return data;
  return plain ? ALT_V : data.replace(WIN32_CTRL_V_DOWN, ALT_V);
}
