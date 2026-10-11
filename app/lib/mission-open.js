// Missions for a folder: at the repo top (the folder itself outside a repo), next to the plugin's
// gate.jsonl. A folder Spark can't write to still opens for chat; missions are just off there.
import { execFile } from 'node:child_process';
import { createStore, excludeSpark } from './mission-store.js';
import { createMissionRunner } from './mission-runner.js';

// git in `dir`, the way snapshot.ts runs commands. No shell: arguments go as given.
export const gitIn = (dir) => (argv, init = {}) =>
  new Promise((done) =>
    execFile(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, timeout: init.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

export async function openMissions({ cwd, write, notify, now, hex4 }) {
  try {
    const run = gitIn(cwd);
    const top = await run(['git', 'rev-parse', '--show-toplevel']);
    const inRepo = top.exitCode === 0;
    const root = inRepo ? top.stdout.trim() : cwd;
    if (inRepo) {
      const exclude = await run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
      if (exclude.exitCode === 0) excludeSpark(exclude.stdout.trim());
    }
    const missions = createMissionRunner({ store: createStore(root), write, notify, run: inRepo ? gitIn(root) : undefined, now, hex4 });
    missions.recover();
    return { missions };
  } catch (err) {
    return { error: err.message };
  }
}
