// F4: when a turn changed files, Spark runs the repo's tests before Claude may finish.
import { testCommand } from './agents.ts'
import { trimOutput } from './failure.ts'
import { changedSince } from './snapshot.ts'
import type { Run } from './snapshot'

export type GateIo = { run: Run; list: (dir: string) => Promise<string[]>; read: (path: string) => Promise<string | undefined> }

export type GateResult = { ok: true } | { ok: false; block: string }

const TIMEOUT_MS = 300_000
const TAIL_LINES = 60

const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// A clarifying question isn't buried under test output; the tests run at the next turn's end.
export const endsInQuestion = (answer: string) => /\?[\s"'”’)\]*_`]*$/.test(answer.trim())

// The person's own command from Spark's config (`repos[<path>].test`, never read from the repo,
// which could otherwise choose what runs here unasked), else what the files at the root suggest.
// A folder the person hasn't trusted gets only their own command: its package.json is its author's.
async function repoTestCommand(io: GateIo, top: string, base: string, sparkConfig: unknown, untrusted: boolean): Promise<string[] | undefined> {
  const repos = (sparkConfig as { repos?: Record<string, { test?: unknown }> })?.repos ?? {}
  const own = Object.entries(repos).find(([path]) => normal(path) === normal(top))?.[1]?.test
  if (typeof own === 'string' && own.trim()) return ['cmd', '/d', '/s', '/c', own.trim()]
  if (untrusted) return undefined
  const names = await io.list(top)
  const pkg = names.includes('package.json') ? await io.read(`${top}/package.json`) : undefined
  // Scripts Claude changed this turn would run with no permission asked: the person runs those.
  if (pkg !== undefined) {
    const before = await io.run(['git', 'show', `${base}:package.json`], { cwd: top })
    if (testScripts(pkg) !== testScripts(before.exitCode === 0 ? before.stdout : '')) {
      throw new Error("package.json's test scripts changed this turn, so Spark won't run them unasked; run them yourself")
    }
  }
  return testCommand(names, pkg)
}

function testScripts(packageJson: string) {
  try {
    const { test, pretest, posttest } = JSON.parse(packageJson)?.scripts ?? {}
    return JSON.stringify([test, pretest, posttest])
  } catch {
    return 'unreadable'
  }
}

// undefined when the tests weren't run: nothing changed since `base`, the turn ended
// on a question, or the repo has no test command.
export async function testGate(
  io: GateIo,
  turn: { base: string; answer: string },
  sparkConfig: unknown,
  { untrusted = false } = {},
): Promise<GateResult | undefined> {
  if (endsInQuestion(turn.answer) || !(await changedSince(io.run, turn.base))) return undefined
  const top = (await io.run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim()
  const argv = await repoTestCommand(io, top, turn.base, sparkConfig, untrusted)
  if (!argv) return undefined
  const r = await io.run(argv, { cwd: top, timeoutMs: TIMEOUT_MS })
  if (r.exitCode === 0) return { ok: true }
  return { ok: false, block: `✦ tests failed (exit ${r.exitCode})\n${trimOutput(`${r.stdout}\n${r.stderr}`, TAIL_LINES)}` }
}
