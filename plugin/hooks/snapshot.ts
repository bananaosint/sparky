import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

// How Spark runs a command: $.process.run in the mod, child_process in tests.
export type Run = (argv: readonly string[], init?: ProcessRunInit) => Promise<Pick<ProcessRunResult, 'exitCode' | 'stdout' | 'stderr'>>

export type Snapshot = { n: number; sha: string; at: number; label: string }

export type FileDiff = {
  path: string
  kind: 'modified' | 'new' | 'deleted' | 'lockfile' | 'binary'
  added: number
  removed: number
  patch?: string
}

const PREFIX = 'refs/spark/turn-'
const KEEP = 20
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock'])
// commit-tree needs an identity, and the person's may be unset.
const IDENTITY = { GIT_AUTHOR_NAME: 'spark', GIT_AUTHOR_EMAIL: 'spark@localhost', GIT_COMMITTER_NAME: 'spark', GIT_COMMITTER_EMAIL: 'spark@localhost' }

async function git(run: Run, args: string[], init?: ProcessRunInit): Promise<string> {
  const r = await run(['git', ...args], init)
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  return r.stdout
}

// A private index, so snapshots never touch the person's staging area. Line-ending
// conversion and .gitattributes filters are off (attributes read from the empty
// tree), so a snapshot holds the files' exact bytes and a restore writes them back.
async function sparkIndex(run: Run) {
  return {
    GIT_INDEX_FILE: (await git(run, ['rev-parse', '--path-format=absolute', '--git-path', 'spark-index'])).trim(),
    GIT_ATTR_SOURCE: EMPTY_TREE,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
  }
}

// The working tree as a tree object: tracked edits and untracked files, not ignored ones.
async function writeTree(run: Run, env: Record<string, string>) {
  await git(run, ['add', '-A'], { env, timeoutMs: 10_000 })
  return (await git(run, ['write-tree'], { env })).trim()
}

export async function listSnapshots(run: Run): Promise<Snapshot[]> {
  const out = await git(run, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(subject)', 'refs/spark/'])
  return out
    .split('\n')
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => {
      const [ref = '', sha = '', at = '0', label = ''] = line.split('\t')
      return { n: Number(ref.slice(PREFIX.length)), sha, at: Number(at) * 1000, label }
    })
    .sort((a, b) => b.n - a.n)
}

export async function takeSnapshot(run: Run, label: string): Promise<Snapshot> {
  const tree = await writeTree(run, await sparkIndex(run))
  const head = await run(['git', 'rev-parse', '--verify', '-q', 'HEAD'])
  const parent = head.exitCode === 0 ? ['-p', head.stdout.trim()] : []
  const sha = (await git(run, ['commit-tree', tree, ...parent, '-m', label], { env: IDENTITY })).trim()
  const existing = await listSnapshots(run)
  await git(run, ['update-ref', `${PREFIX}${(existing[0]?.n ?? 0) + 1}`, sha])
  for (const old of existing.slice(KEEP - 1)) await git(run, ['update-ref', '-d', `${PREFIX}${old.n}`])
  return (await listSnapshots(run))[0]!
}

// Makes the working tree match `target`. Snapshots the current state first and
// returns that snapshot, so a restore can itself be undone.
export async function restoreSnapshot(run: Run, target: Snapshot): Promise<Snapshot> {
  const undo = await takeSnapshot(run, `before restoring turn ${target.n}`)
  const top = (await git(run, ['rev-parse', '--show-toplevel'])).trim()
  const env = await sparkIndex(run)
  const made = (await git(run, ['diff', '--name-only', '-z', '--diff-filter=A', target.sha, undo.sha])).split('\0').filter(Boolean)
  await git(run, ['read-tree', target.sha], { env })
  await git(run, ['checkout-index', '-a', '-f'], { env, cwd: top })
  if (made.length) {
    const rm = 'for (const p of process.argv.slice(1)) require("fs").rmSync(p, { force: true })'
    const r = await run(['node', '-e', rm, ...made], { cwd: top })
    if (r.exitCode !== 0) throw new Error(`could not remove files made since turn ${target.n}: ${r.stderr.trim()}`)
  }
  return undo
}

// What changed since `base`, against the working tree as it is now: in `files`,
// or anywhere when no list is given.
export async function fileDiffs(run: Run, base: string, files?: readonly string[]): Promise<FileDiff[]> {
  const top = (await git(run, ['rev-parse', '--show-toplevel'])).trim()
  const inside = top.toLowerCase() + '/'
  const paths = [
    ...new Set(
      (files ?? [])
        .map((f) => f.replace(/\\/g, '/'))
        .filter((f) => f.toLowerCase().startsWith(inside))
        .map((f) => f.slice(inside.length)),
    ),
  ]
  if (files && !paths.length) return []
  const now = await writeTree(run, await sparkIndex(run))
  const at = { cwd: top }
  const status = new Map(
    (await git(run, ['diff', '--name-status', base, now, '--', ...paths], at))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code = '', path = ''] = line.split('\t')
        return [path, code.charAt(0)] as const
      }),
  )
  const counts = new Map(
    (await git(run, ['diff', '--numstat', base, now, '--', ...paths], at))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added = '0', removed = '0', path = ''] = line.split('\t')
        return [path, { added, removed }] as const
      }),
  )
  const diffs: FileDiff[] = []
  for (const path of files ? paths : [...status.keys()]) {
    const code = status.get(path)
    if (!code) continue
    const { added, removed } = counts.get(path) ?? { added: '0', removed: '0' }
    const binary = added === '-'
    const kind = LOCKFILES.has(path.split('/').pop()!)
      ? 'lockfile'
      : binary
        ? 'binary'
        : code === 'A'
          ? 'new'
          : code === 'D'
            ? 'deleted'
            : 'modified'
    const diff: FileDiff = { path, kind, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed) }
    if (kind === 'modified') diff.patch = await git(run, ['diff', base, now, '--', path], at)
    diffs.push(diff)
  }
  return diffs
}
