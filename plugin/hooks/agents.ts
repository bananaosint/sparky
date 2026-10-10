import type { Run } from './snapshot'

export type Worktree = { path: string; head: string; branch?: string }

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\n+/)
    .filter((block) => block.startsWith('worktree '))
    .map((block) => {
      const field = (name: string) => block.split('\n').find((l) => l.startsWith(name + ' '))?.slice(name.length + 1)
      const branch = field('branch')?.replace(/^refs\/heads\//, '')
      return { path: field('worktree')!, head: field('HEAD') ?? '', ...(branch ? { branch } : {}) }
    })
}

// Package-manager shims are .cmd files on Windows, which only cmd can start.
const viaCmd = (...argv: string[]) => ['cmd', '/d', '/c', ...argv]

export function testCommand(files: readonly string[], packageJson?: string): string[] | undefined {
  const has = (name: string) => files.includes(name)
  if (has('package.json')) {
    try {
      const script = JSON.parse(packageJson ?? '{}')?.scripts?.test
      // npm init's placeholder fails on purpose; it isn't a test suite.
      if (!script || /no test specified/.test(script)) return undefined
    } catch {
      return undefined
    }
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm'
    return viaCmd(runner, 'test')
  }
  if (has('Cargo.toml')) return viaCmd('cargo', 'test')
  if (has('go.mod')) return viaCmd('go', 'test', './...')
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) return viaCmd('python', '-m', 'pytest')
  return undefined
}

async function git(run: Run, cwd: string, args: string[]) {
  const r = await run(['git', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`)
  return r.stdout
}

// Changes when the worktree's commit or any file in it does; a test result counts only for its stamp.
export async function worktreeStamp(run: Run, path: string) {
  const head = (await git(run, path, ['rev-parse', 'HEAD'])).trim()
  const dirty = (await git(run, path, ['status', '--porcelain', '-uall'])).split('\n').filter(Boolean)
  const files = dirty.map((line) => line.slice(3)).filter((p) => !p.includes(' -> '))
  const hashes = files.length ? await git(run, path, ['hash-object', '--', ...files]).catch(() => '') : ''
  return [head, ...dirty, hashes].join('\n')
}

// Commits what the agent left uncommitted, then merges its branch into the main tree.
// A conflicting merge is aborted, so the main tree stays as it was.
export async function mergeWorktree(run: Run, mainPath: string, wt: Worktree, message: string) {
  if ((await git(run, wt.path, ['status', '--porcelain'])).trim()) {
    await git(run, wt.path, ['add', '-A'])
    await git(run, wt.path, ['commit', '-q', '-m', message])
  }
  const target = wt.branch ?? (await git(run, wt.path, ['rev-parse', 'HEAD'])).trim()
  const merged = await run(['git', 'merge', '--no-ff', '--no-edit', target], { cwd: mainPath })
  if (merged.exitCode !== 0) {
    await run(['git', 'merge', '--abort'], { cwd: mainPath })
    const reason = (merged.stdout + merged.stderr).trim().split('\n').slice(-3).join(' ')
    throw new Error(`merge of ${target} stopped: ${reason}`)
  }
}

// Agents' worktrees start without dependencies; a junction to the main tree's saves an install.
export async function linkModules(run: Run, mainPath: string, wtPath: string) {
  const link =
    'const fs = require("fs"), p = require("path"); const [m, w] = process.argv.slice(1);' +
    'const from = p.join(m, "node_modules"), to = p.join(w, "node_modules");' +
    'if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, "junction")'
  const r = await run(['node', '-e', link, mainPath, wtPath])
  if (r.exitCode !== 0) throw new Error(`could not link node_modules: ${r.stderr.trim()}`)
}
