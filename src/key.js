// The Gemini key is stored encrypted with Windows DPAPI (CurrentUser scope).
// That protects it on disk and from other accounts, not from processes
// running as you.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function defaultKeyPath() {
  return join(process.env.APPDATA ?? '', 'spark', 'gemini.key');
}

// The app's ⚙ settings save it; the terminal reads it for /council.
export const openrouterKeyPath = () => join(process.env.APPDATA ?? '', 'spark', 'openrouter.key');

const PROTECT = `
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:SPARK_KEY_IN)
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllBytes($env:SPARK_KEY_FILE, $sealed)
`;

const UNPROTECT = `
Add-Type -AssemblyName System.Security
$sealed = [IO.File]::ReadAllBytes($env:SPARK_KEY_FILE)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

// The key travels in the child's environment, never on its command line.
function powershell(script, env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function saveKey(key, file = defaultKeyPath()) {
  mkdirSync(dirname(file), { recursive: true });
  powershell(PROTECT, { SPARK_KEY_IN: key, SPARK_KEY_FILE: file });
}

export function loadKey(file = defaultKeyPath()) {
  if (!existsSync(file)) return undefined;
  return powershell(UNPROTECT, { SPARK_KEY_FILE: file });
}

export function clearKey(file = defaultKeyPath()) {
  rmSync(file, { force: true });
}
