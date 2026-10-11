// Runs a verification plan from verify.ts: one check at a time in the repo's top folder, 5 minutes
// each. Output is redacted before it is kept, in a result's tail or in the check's log.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../staged/plugin/hooks/gate.ts';
import { redact } from '../staged/plugin/hooks/redact.ts';
import { changedScripts as changed, configuredFor, planChecks } from '../staged/plugin/hooks/verify.ts';

const LIMIT_MS = 5 * 60_000;
const TAIL_LINES = 40;
// A check that prints without end keeps only its last 2 MB.
const KEEP_CHARS = 2_000_000;

// What planChecks needs, read from the repo top and Spark's config. Scripts are compared with the
// start snapshot's package.json; one missing there counts as changed.
export async function planFor({ cwd, mission, config, trusted, run }) {
  const files = readdirSync(cwd);
  const packageJson = files.includes('package.json') ? readFileSync(join(cwd, 'package.json'), 'utf8') : undefined;
  let changedScripts;
  if (run && mission.startSha) {
    const before = await run(['git', 'show', `${mission.startSha}:package.json`], { cwd });
    changedScripts = changed(before.exitCode === 0 ? before.stdout : '', packageJson ?? '');
  }
  return planChecks({
    files,
    packageJson,
    configured: configuredFor(config, cwd),
    criteria: mission.criteria,
    trusted,
    changedScripts,
    classify: (command) => classify(command, 'powershell', { repo: cwd, home: process.env.USERPROFILE ?? '' }),
  });
}

// A task's check, planned as a criterion's command is: trust, the gate and changed scripts apply.
export async function planTaskCheck({ cwd, mission, task, config, trusted, run }) {
  const plan = await planFor({ cwd, mission: { ...mission, criteria: [{ text: task.title, how: task.check, by: 'claude' }] }, config, trusted, run });
  const planned = plan.find((p) => p.criterion === 0) ?? { reason: 'its check is not a command', criterion: 0 };
  return { ...planned, name: `task ${task.id}` };
}

// cmd's children (npm, node, the test runner) outlive a plain kill, so the whole tree goes.
const killTree = (child) => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());

const running = new Set();
export const stopChecks = () => running.forEach(killTree);

export function shellExec(command, { cwd, timeoutMs = LIMIT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true });
    running.add(child);
    let output = '';
    const take = (chunk) => {
      output += chunk;
      if (output.length > 2 * KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      running.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ exitCode: code ?? 1, output: output.slice(-KEEP_CHARS), timedOut });
    });
  });
}

// `onResult` hears each result as its check finishes, so the timeline fills in while they run.
export async function runChecks(plan, { cwd, logDir, exec = shellExec, now = Date.now, tree, onResult = () => {} }) {
  mkdirSync(logDir, { recursive: true });
  const one = async (check, i) => {
    const base = { name: check.name, ...(check.criterion !== undefined && { criterion: check.criterion }) };
    if (!check.command) return { ...base, status: 'not-run', reason: check.reason };
    const ranOn = await tree?.().catch(() => undefined);
    const at = now();
    let out;
    try {
      out = await exec(check.command, { cwd });
    } catch (e) {
      return { ...base, command: check.command, status: 'fail', reason: redact(String(e?.message ?? e)).text, ms: now() - at };
    }
    const text = redact(out.output).text;
    const log = `${i + 1}.log`;
    writeFileSync(join(logDir, log), text);
    return {
      ...base,
      command: check.command,
      status: out.timedOut ? 'timed-out' : out.exitCode === 0 ? 'pass' : 'fail',
      exit: out.exitCode,
      ms: now() - at,
      ...(ranOn && { tree: ranOn }),
      tail: text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
      log,
    };
  };
  const results = [];
  for (const [i, check] of plan.entries()) {
    const result = await one(check, i);
    results.push(result);
    onResult(result);
  }
  return results;
}
