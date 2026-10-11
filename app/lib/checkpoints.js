// The Changes view's git side: Spark's checkpoints (turn snapshots and mission pins), what changed
// since one, and restoring it. checkpoints.ts labels them; snapshot.ts reads and restores.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointList, restorePlan } from '../staged/plugin/hooks/checkpoints.ts';
import { parseGateLines } from '../staged/plugin/hooks/mission.ts';
import { fileDiffs, restoreSnapshot } from '../staged/plugin/hooks/snapshot.ts';

const NO_GIT = "Checkpoints need a git repository; this folder isn't one.";

// A restore rewrites the working tree: anything that edits or checks it at the same time would race.
export function restoreRefusal({ turnOpen, missionBusy, marathon }) {
  if (turnOpen) return 'Claude is working on a turn: wait for it to end, or press ■ first';
  if (missionBusy) return 'a mission is running or Spark is checking one: wait for it to end';
  if (marathon) return 'a marathon is running: /marathon stop ends it first';
  return undefined;
}

// `run`: git in the repo (mission-open.js's gitIn), undefined outside one. `missions()`: the
// folder's missions, for the pins' titles.
export function createCheckpoints({ root, run, missions }) {
  async function list() {
    if (!run) throw new Error(NO_GIT);
    const r = await run(['git', 'for-each-ref', '--format=%(refname)%09%(objectname)%09%(tree)%09%(committerdate:unix)%09%(subject)', 'refs/spark/']);
    if (r.exitCode !== 0) throw new Error(`git for-each-ref failed: ${r.stderr.trim()}`);
    const rows = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref = '', sha = '', tree = '', at = '0', label = ''] = line.split('\t');
        return { ref, sha, tree, at: Number(at) * 1000, label };
      });
    const turns = rows.filter((x) => /^refs\/spark\/turn-\d+$/.test(x.ref)).map((x) => ({ n: Number(x.ref.slice('refs/spark/turn-'.length)), sha: x.sha, at: x.at, label: x.label, tree: x.tree }));
    const pins = rows.filter((x) => x.ref.startsWith('refs/spark/missions/'));
    let gate = '';
    try {
      gate = readFileSync(join(root, '.spark', 'gate.jsonl'), 'utf8');
    } catch {}
    return checkpointList(turns, pins, missions(), parseGateLines(gate));
  }

  // Only a checkpoint from the list reaches git: the window sends the sha.
  async function find(sha) {
    const found = (await list()).find((c) => c.sha === sha);
    if (!found) throw new Error("that is not one of Spark's checkpoints");
    return found;
  }

  return {
    list,
    async changes(sha) {
      const found = await find(sha);
      const diffs = await fileDiffs(run, found.sha);
      return { diffs, plan: restorePlan(diffs) };
    },
    async restore(sha) {
      const found = await find(sha);
      const undo = await restoreSnapshot(run, found);
      return { undo };
    },
  };
}
