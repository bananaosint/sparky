import { test, expect } from 'claude-code/testing'
import { checkpointList, restorePlan } from '../hooks/checkpoints'

const sha = (c: string) => c.repeat(40)
const ID = 'm-20261010-210000-beef'

test('turn snapshots and mission pins become one list, newest first, each saying what it is', () => {
  const list = checkpointList(
    [
      { n: 7, sha: sha('a'), at: 5000, label: `before: fix the login token=ghp_${'z'.repeat(36)}`, tree: sha('1') },
      { n: 6, sha: sha('b'), at: 1000, label: 'before: hello', tree: sha('2') },
    ],
    [
      { ref: `refs/spark/missions/${ID}/start`, sha: sha('c'), at: 2000, tree: sha('3') },
      { ref: `refs/spark/missions/${ID}/task-t2-1`, sha: sha('d'), at: 3000, tree: sha('4') },
      { ref: `refs/spark/missions/${ID}/end`, sha: sha('e'), at: 4000, tree: sha('1') },
      { ref: 'refs/spark/missions/m-20261009-120000-cafe/start', sha: sha('f'), at: 500, tree: sha('5') },
      { ref: 'refs/spark/missions/../../x/start', sha: sha('9'), at: 9000, tree: sha('6') },
    ],
    [{ id: ID, title: 'Rate-limit login' }],
    [],
  )
  expect(list.map((c) => [c.sha[0], c.kind, c.label])).toEqual([
    ['a', 'turn', 'before: fix the login token=«secret-1»'],
    ['e', 'mission-end', 'Mission "Rate-limit login" ended'],
    ['d', 'task', 'task t2 of "Rate-limit login" ended (attempt 1)'],
    ['c', 'mission-start', 'Mission "Rate-limit login" started'],
    ['b', 'turn', 'before: hello'],
    ['f', 'mission-start', 'Mission m-20261009-120000-cafe started'],
  ])
  expect(list[0]!.n).toBe(7)
  expect(list[1]!.missionId).toBe(ID)
})

test('a checkpoint is marked by the last test-gate run on exactly its tree', () => {
  const gates = [
    { at: 1, kind: 'gate' as const, check: 'tests' as const, ok: false, tree: sha('1') },
    { at: 2, kind: 'gate' as const, check: 'tests' as const, ok: true, tree: sha('1') },
    { at: 3, kind: 'gate' as const, check: 'tests' as const, ok: false, tree: sha('2') },
    { at: 4, kind: 'gate' as const, check: 'build' as const, ok: true, tree: sha('3') },
  ]
  const list = checkpointList(
    [
      { n: 2, sha: sha('a'), at: 3, label: 'before: b', tree: sha('1') },
      { n: 1, sha: sha('b'), at: 2, label: 'before: a', tree: sha('2') },
    ],
    [{ ref: `refs/spark/missions/${ID}/start`, sha: sha('c'), at: 1, tree: sha('3') }],
    [],
    gates,
  )
  expect(list.map((c) => c.tests)).toEqual(['passed', 'failed', undefined])
})

test('the restore confirmation sorts the files: changed ones go back, new ones go, deleted ones return', () => {
  expect(
    restorePlan([
      { path: 'src/auth.js', kind: 'modified', added: 3, removed: 1 },
      { path: 'src/limit.js', kind: 'new', added: 20, removed: 0 },
      { path: 'docs/old.md', kind: 'deleted', added: 0, removed: 9 },
      { path: 'package-lock.json', kind: 'lockfile', added: 40, removed: 2 },
      { path: 'logo.png', kind: 'binary', added: 0, removed: 0 },
    ]),
  ).toEqual({ putBack: ['src/auth.js', 'package-lock.json', 'logo.png'], removed: ['src/limit.js'], broughtBack: ['docs/old.md'] })
})
