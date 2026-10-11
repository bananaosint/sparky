// Runs a verification plan from verify.ts: one check at a time in the repo's top folder, 5 minutes
// each. Output is redacted before it is kept, in a result's tail or in the check's log.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../staged/plugin/hooks/redact.ts';

const LIMIT_MS = 5 * 60_000;
const TAIL_LINES = 40;
// A check that prints without end keeps only its last 2 MB.
const KEEP_CHARS = 2_000_000;

export function shellExec(command, { cwd, timeoutMs = LIMIT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true });
    let output = '';
    const take = (chunk) => {
      output += chunk;
      if (output.length > 2 * KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    // cmd's children (npm, node, the test runner) outlive a plain kill, so the whole tree goes.
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: output.slice(-KEEP_CHARS), timedOut });
    });
  });
}

export async function runChecks(plan, { cwd, logDir, exec = shellExec, now = Date.now, tree }) {
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const [i, check] of plan.entries()) {
    const base = { name: check.name, ...(check.criterion !== undefined && { criterion: check.criterion }) };
    if (!check.command) {
      results.push({ ...base, status: 'not-run', reason: check.reason });
      continue;
    }
    const ranOn = await tree?.().catch(() => undefined);
    const at = now();
    let out;
    try {
      out = await exec(check.command, { cwd });
    } catch (e) {
      results.push({ ...base, command: check.command, status: 'fail', reason: redact(String(e?.message ?? e)).text, ms: now() - at });
      continue;
    }
    const text = redact(out.output).text;
    const log = `${i + 1}.log`;
    writeFileSync(join(logDir, log), text);
    results.push({
      ...base,
      command: check.command,
      status: out.timedOut ? 'timed-out' : out.exitCode === 0 ? 'pass' : 'fail',
      exit: out.exitCode,
      ms: now() - at,
      ...(ranOn && { tree: ranOn }),
      tail: text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
      log,
    });
  }
  return results;
}
