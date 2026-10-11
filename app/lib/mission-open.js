// Missions for a folder: at the repo top (the folder itself outside a repo), next to the plugin's
// gate.jsonl. A folder Spark can't write to still opens for chat; missions are just off there.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createStore, excludeSpark } from './mission-store.js';
import { createMissionRunner } from './mission-runner.js';
import { planFor, runChecks } from './verify-run.js';
import { treeNow } from '../staged/plugin/hooks/snapshot.ts';

// git in `dir`, the way snapshot.ts runs commands. No shell: arguments go as given.
export const gitIn = (dir) => (argv, init = {}) =>
  new Promise((done) =>
    execFile(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, timeout: init.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

// `config()`: Spark's config, for the person's own commands. `trusted()`: whether the folder is.
export async function openMissions({ cwd, write, notify, now, hex4, config = () => ({}), trusted = () => false }) {
  try {
    const run = gitIn(cwd);
    const top = await run(['git', 'rev-parse', '--show-toplevel']);
    const inRepo = top.exitCode === 0;
    const root = inRepo ? top.stdout.trim() : cwd;
    if (inRepo) {
      const exclude = await run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
      if (exclude.exitCode === 0) excludeSpark(exclude.stdout.trim());
    }
    const git = inRepo ? gitIn(root) : undefined;
    const verify = async (mission, onResult) => {
      const plan = await planFor({ cwd: root, mission, config: config(), trusted: trusted(), run: git });
      await runChecks(plan, { cwd: root, logDir: join(root, '.spark', 'missions', mission.id, 'checks'), tree: git && (() => treeNow(git)), onResult });
    };
    const missions = createMissionRunner({ store: createStore(root), write, notify, run: git, verify, now, hex4 });
    missions.recover();
    return { missions, root };
  } catch (err) {
    return { error: err.message, root: cwd };
  }
}
