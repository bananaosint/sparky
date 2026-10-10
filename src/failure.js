import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

// Enough output for the mod to show the failing tests; the start of a long log rarely matters.
const KEEP_CHARS = 64 * 1024;

// Inside .git, so the record never shows up in git status. Undefined outside a repo.
export function failurePath(cwd, env = process.env) {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'spark-failure.json'], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export const shellLine = (argv) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

// Runs `command` through the shell, showing its output as usual. A failure is
// recorded for the Spark band; a success clears the last record.
export function tryCommand({ command, cwd = process.cwd(), out = process.stdout, err = process.stderr, env = {}, now = Date.now }) {
  const childEnv = { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', ...env };
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: childEnv, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    const tee = (to) => (chunk) => {
      to.write(chunk);
      output = (output + chunk.toString()).slice(-KEEP_CHARS);
    };
    child.stdout.on('data', tee(out));
    child.stderr.on('data', tee(err));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      const path = failurePath(cwd, childEnv);
      if (path && exitCode === 0) rmSync(path, { force: true });
      if (path && exitCode !== 0) writeFileSync(path, JSON.stringify({ command, cwd, exitCode, output, at: now() }));
      resolve({ exitCode, recorded: Boolean(path) && exitCode !== 0 });
    });
  });
}
