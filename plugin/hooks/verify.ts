// The verification engine's plan and verdict, pure: which checks Spark runs itself when a mission
// ends, which it won't and why, and what the results add up to. The app and the mod run the plan.
import type { Criterion } from './mission.ts'

export type CheckStatus = 'pass' | 'fail' | 'timed-out' | 'not-run'
// A check to run (`command`) or one that won't run (`reason`). `criterion`: the index it checks.
export type PlannedCheck = { name: string; command?: string; reason?: string; criterion?: number }
export type CheckResult = { name: string; status: CheckStatus; command?: string; criterion?: number; reason?: string; exit?: number; ms?: number; tree?: string; tail?: string; log?: string }
export type Verdict = 'verified' | 'needs review' | 'checks failed' | 'not verified'
type GateVerdict = { kind: 'deny' | 'ask'; reason: string } | undefined

// Runners that run the project's own tooling. npx is left out: it can download and run packages.
const RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3', 'py', 'pytest', 'cargo', 'go', 'dotnet', 'make', 'mvn', 'gradle', 'tsc', 'vitest', 'jest', 'mocha'])
export const isCommandHow = (how: string) => RUNNERS.has(how.trim().split(/\s+/)[0]?.toLowerCase() ?? '')

const UNTRUSTED = 'the folder is untrusted; only your own configured commands run'

// The package.json script a command line runs, if any: `npm test`, `pnpm run e2e`, `yarn lint`.
// Over-matching only makes Spark more careful. `bun test` is bun's own runner, not a script.
function scriptOf(how: string) {
  const [runner, a, b] = how.trim().split(/\s+/)
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(runner?.toLowerCase() ?? '') || !a) return undefined
  if (a === 'run' || a === 'run-script') return b
  if (a === 't' || a === 'tst' || a === 'test') return runner?.toLowerCase() === 'bun' ? undefined : 'test'
  return runner?.toLowerCase() === 'npm' || runner?.toLowerCase() === 'bun' ? undefined : a
}

function scripts(packageJson: string | undefined): Record<string, unknown> {
  try {
    const s = JSON.parse(packageJson ?? '{}')?.scripts
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// The person's own commands for the repo at `top`, from Spark's config (`repos[<path>]`).
export function configuredFor(config: unknown, top: string): { test?: string; typecheck?: string; lint?: string; build?: string } {
  const repos = (config as { repos?: Record<string, Record<string, unknown>> } | undefined)?.repos ?? {}
  const own = Object.entries(repos).find(([path]) => normal(path) === normal(top))?.[1] ?? {}
  return Object.fromEntries(['test', 'typecheck', 'lint', 'build'].flatMap((k) => (typeof own[k] === 'string' ? [[k, own[k]]] : [])))
}

// Each script with the pre and post scripts npm runs around it.
function scriptGroups(packageJson: string) {
  const s = scripts(packageJson) as Record<string, unknown>
  const names = Object.keys(s).filter((n) => !/^(pre|post)/.test(n) || !(n.replace(/^(pre|post)/, '') in s))
  return new Map(names.map((n) => [n, JSON.stringify([s[`pre${n}`], s[n], s[`post${n}`]])]))
}

// The scripts that differ between two package.json texts; one missing from either counts.
export function changedScripts(before: string, after: string): string[] {
  const then = scriptGroups(before)
  const now = scriptGroups(after)
  return [...new Set([...then.keys(), ...now.keys()])].filter((n) => then.get(n) !== now.get(n))
}

// The test gate's choice of test command, as a command line.
function testLine(files: readonly string[], packageJson: string | undefined) {
  const has = (name: string) => files.includes(name)
  if (has('package.json')) {
    const script = scripts(packageJson).test
    if (typeof script !== 'string' || !script || /no test specified/.test(script)) return undefined
    return `${runnerOf(files)} test`
  }
  if (has('Cargo.toml')) return 'cargo test'
  if (has('go.mod')) return 'go test ./...'
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) return 'python -m pytest'
  return undefined
}
const runnerOf = (files: readonly string[]) => (files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') ? 'bun' : 'npm')

export function planChecks(a: {
  files: readonly string[]
  packageJson?: string
  configured: { test?: string; typecheck?: string; lint?: string; build?: string }
  criteria: readonly Criterion[]
  trusted: boolean
  // package.json scripts that changed since the mission's start snapshot; undefined: no snapshot
  changedScripts: readonly string[] | undefined
  classify: (command: string) => GateVerdict
}): PlannedCheck[] {
  const s = scripts(a.packageJson)
  const runner = runnerOf(a.files)
  const plan: PlannedCheck[] = []
  const changed = (script: string | undefined) =>
    !script
      ? undefined
      : a.changedScripts === undefined
        ? `Spark can't tell whether the ${script} script changed (no start snapshot)`
        : a.changedScripts.includes(script)
          ? `the ${script} script changed during the mission`
          : undefined
  // A check from the person's config always runs; one from the folder's own files needs trust and
  // an unchanged script.
  const project = (name: string, own: string | undefined, script: string | undefined, line: string | undefined) => {
    if (own?.trim()) return plan.push({ name, command: own.trim() })
    if (!line) return
    if (!a.trusted) return plan.push({ name, reason: UNTRUSTED })
    const reason = changed(script)
    if (reason) return plan.push({ name, reason })
    plan.push({ name, command: line })
  }
  const tests = testLine(a.files, a.packageJson)
  if (!a.configured.test?.trim() && !tests) plan.push({ name: 'tests', reason: 'no test command found' })
  else project('tests', a.configured.test, a.files.includes('package.json') ? 'test' : undefined, tests)
  const typecheck = typeof s.typecheck === 'string' ? 'typecheck' : typeof s.check === 'string' ? 'check' : undefined
  project('type check', a.configured.typecheck, typecheck, typecheck && `${runner} run ${typecheck}`)
  project('lint', a.configured.lint, 'lint', typeof s.lint === 'string' ? `${runner} run lint` : undefined)
  project('build', a.configured.build, 'build', typeof s.build === 'string' ? `${runner} run build` : undefined)
  a.criteria.forEach((c, i) => {
    if (!isCommandHow(c.how)) return
    const name = `criterion ${i + 1}`
    if (!a.trusted) return plan.push({ name, criterion: i, reason: UNTRUSTED })
    const script = changed(scriptOf(c.how))
    if (script) return plan.push({ name, criterion: i, reason: script })
    const gate = a.classify(c.how)
    if (gate) return plan.push({ name, criterion: i, reason: `the gate would ${gate.kind === 'deny' ? 'block it' : 'ask'}: ${gate.reason.replace(/^✦ spark gate: (blocked: )?/, '')}` })
    plan.push({ name, criterion: i, command: c.how.trim() })
  })
  return plan
}

// From the checks only: never from what a model said about its work.
export function verdict(results: readonly CheckResult[], criteria: readonly Criterion[]): Verdict {
  if (!results.some((r) => r.status !== 'not-run')) return 'not verified'
  if (results.some((r) => r.status === 'fail' || r.status === 'timed-out')) return 'checks failed'
  if (results.some((r) => r.status === 'not-run') || criteria.some((c) => !isCommandHow(c.how))) return 'needs review'
  return 'verified'
}
