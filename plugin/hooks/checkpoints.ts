// Spark's checkpoints for the app's Changes view, pure: turn snapshots and mission pins in one
// list, each labelled and marked with the test-gate result on exactly its tree.
import { isMissionId } from './mission.ts'
import type { GateRecord } from './mission.ts'
import { redact } from './redact.ts'
import type { FileDiff, Snapshot } from './snapshot.ts'

// A mission pin as `git for-each-ref refs/spark/missions` lists it.
export type Pin = { ref: string; sha: string; at: number; tree: string }
export type Checkpoint = {
  sha: string
  at: number
  kind: 'turn' | 'mission-start' | 'task' | 'mission-end'
  label: string
  n?: number
  missionId?: string
  tests?: 'passed' | 'failed'
}

const PIN = /^refs\/spark\/missions\/([^/]+)\/(start|end|task-([A-Za-z][\w-]{0,19})-(\d+))$/

export function checkpointList(
  snapshots: readonly (Snapshot & { tree?: string })[],
  pins: readonly Pin[],
  missions: readonly { id: string; title: string }[],
  gates: readonly GateRecord[],
): Checkpoint[] {
  const tests = (tree: string | undefined) => {
    const last = gates.filter((g) => g.check === 'tests' && tree && g.tree === tree).at(-1)
    return last ? { tests: last.ok ? ('passed' as const) : ('failed' as const) } : {}
  }
  const turns = snapshots.map((s): Checkpoint => ({ sha: s.sha, at: s.at, kind: 'turn', label: redact(s.label).text, n: s.n, ...tests(s.tree) }))
  const pinned = pins.flatMap((p): Checkpoint[] => {
    const m = PIN.exec(p.ref)
    if (!m || !isMissionId(m[1])) return []
    const id = m[1]
    const title = missions.find((x) => x.id === id)?.title
    const name = title ? `"${title}"` : id
    const kind = m[2] === 'start' ? 'mission-start' : m[2] === 'end' ? 'mission-end' : 'task'
    const label = kind === 'mission-start' ? `Mission ${name} started` : kind === 'mission-end' ? `Mission ${name} ended` : `task ${m[3]} of ${name} ended (attempt ${m[4]})`
    return [{ sha: p.sha, at: p.at, kind, label, missionId: id, ...tests(p.tree) }]
  })
  return [...turns, ...pinned].sort((a, b) => b.at - a.at)
}

// What a restore does to each file that differs from the checkpoint now.
export function restorePlan(diffs: readonly FileDiff[]) {
  return {
    putBack: diffs.filter((d) => d.kind !== 'new' && d.kind !== 'deleted').map((d) => d.path),
    removed: diffs.filter((d) => d.kind === 'new').map((d) => d.path),
    broughtBack: diffs.filter((d) => d.kind === 'deleted').map((d) => d.path),
  }
}
