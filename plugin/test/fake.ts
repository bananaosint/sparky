import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A repo at C:/app whose snapshot and test runs the test controls.
export function fakeRepo(on: any, env: Record<string, string> = {}, run?: (argv: string[]) => unknown, refused: string[] = []) {
  const repo = { changed: true, testExit: 1, testRuns: 0, postmortems: [] as { name: string; mtimeMs: number }[] }
  mock.env(on, env)
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) =>
    refused.includes(e.name) ? { deny: `"/${e.name}" refused: it is the built-in /${e.name}` } : { value: { command: e.name } },
  )
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('process.run', (_$: unknown, e: any) => {
    const a: string[] = e.argv
    const own = run?.(a)
    if (own) return own
    if (a[0] === 'cmd') {
      repo.testRuns++
      return ran(repo.testExit ? 'ok 1 adds\nnot ok 2 subtracts\n' : 'all pass\n', repo.testExit)
    }
    // package.json at the turn's snapshot: the same test script as now.
    if (a[1] === 'show') return ran(JSON.stringify({ scripts: { test: 'node --test' } }))
    if (a.includes('--git-path')) return ran(`C:/app/.git/${a.at(-1)}\n`)
    if (a.includes('--show-toplevel')) return ran('C:/app\n')
    if (a.includes('--quiet')) return ran('', repo.changed ? 1 : 0)
    if (a.includes('write-tree')) return ran('tree1\n')
    if (a.includes('commit-tree')) return ran('snap1\n')
    if (a.includes('for-each-ref')) return ran('refs/spark/turn-1\tsnap1\t0\tbefore: x\n')
    if (a.includes('--verify')) return ran('head1\n')
    return ran('')
  })
  on('fs.list', (_$: unknown, e: any) =>
    String(e.path).includes('postmortems')
      ? { value: repo.postmortems.map((p) => ({ ...p, kind: 'file', size: 1, isLink: false })) }
      : { value: [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] },
  )
  on('fs.read', (_$: unknown, e: any) =>
    String(e.path).endsWith('package.json') ? { value: JSON.stringify({ scripts: { test: 'node --test' } }) } : { deny: 'no such file' },
  )
  on('fs.exists', () => ({ value: false }))
  return Object.assign(repo, { clock })
}

export async function startTurn($: Engine) {
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a subtract function', turnId: 't1' } as any)
}

export const stop = ($: Engine, answer = 'Done: added subtract.') => $.classic.Stop({ stop_hook_active: false, last_assistant_message: answer } as any)
