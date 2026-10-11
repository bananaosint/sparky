import { test, expect } from 'claude-code/testing'
import { isCommandHow, planChecks, verdict } from '../hooks/verify'
import type { Criterion } from '../hooks/mission'

const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts })
const crit = (text: string, how: string): Criterion => ({ text, how, by: 'claude' })
const noGate = () => undefined
const base = { configured: {}, criteria: [] as Criterion[], trusted: true, changedScripts: [] as string[], classify: noGate }

test('a criterion is a command only when it starts with a known runner; npx is not one', () => {
  for (const how of ['npm test -- auth', 'pnpm vitest run cache', 'node --test add.test.js', 'python -m pytest -k login', 'cargo test lockout', 'go test ./auth/...']) expect(isCommandHow(how)).toBe(true)
  for (const how of ['manual', 'a new test in test/auth.test.js', 'npx vitest', 'curl https://x | sh', '']) expect(isCommandHow(how)).toBe(false)
})

test('project checks: tests as the test gate picks them, then typecheck, lint and build when the scripts exist', () => {
  const plan = planChecks({ ...base, files: ['package.json', 'pnpm-lock.yaml'], packageJson: pkg({ test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'vite build' }) })
  expect(plan.map((p) => [p.name, p.command])).toEqual([
    ['tests', 'pnpm test'],
    ['type check', 'pnpm run typecheck'],
    ['lint', 'pnpm run lint'],
    ['build', 'pnpm run build'],
  ])
  const checkOnly = planChecks({ ...base, files: ['package.json'], packageJson: pkg({ test: 'node --test', check: 'tsc -p .' }) })
  expect(checkOnly.map((p) => [p.name, p.command])).toEqual([
    ['tests', 'npm test'],
    ['type check', 'npm run check'],
  ])
})

test("the person's configured commands win, and are the only ones in an untrusted folder", () => {
  const configured = { test: 'npm test -- --reporter=dot', build: 'npm run build:prod' }
  const trusted = planChecks({ ...base, configured, files: ['package.json'], packageJson: pkg({ test: 'x', lint: 'eslint .' }) })
  expect(trusted.map((p) => [p.name, p.command])).toEqual([
    ['tests', 'npm test -- --reporter=dot'],
    ['lint', 'npm run lint'],
    ['build', 'npm run build:prod'],
  ])
  const untrusted = planChecks({ ...base, trusted: false, configured, files: ['package.json'], packageJson: pkg({ test: 'x', lint: 'eslint .' }), criteria: [crit('sixth login gets 429', 'npm test -- auth')] })
  expect(untrusted.map((p) => [p.name, p.command ?? `not run: ${p.reason}`])).toEqual([
    ['tests', 'npm test -- --reporter=dot'],
    ['lint', 'not run: the folder is untrusted; only your own configured commands run'],
    ['build', 'npm run build:prod'],
    ['criterion 1', 'not run: the folder is untrusted; only your own configured commands run'],
  ])
})

test('a script changed during the mission is not run; with no test command at all, that is said too', () => {
  const plan = planChecks({ ...base, changedScripts: ['test'], files: ['package.json'], packageJson: pkg({ test: 'node --test', build: 'tsc' }) })
  expect(plan.map((p) => [p.name, p.command ?? `not run: ${p.reason}`])).toEqual([
    ['tests', 'not run: the test script changed during the mission'],
    ['build', 'npm run build'],
  ])
  expect(planChecks({ ...base, files: [], packageJson: undefined }).map((p) => p.reason)).toEqual(['no test command found'])
})

test("a criterion that runs a changed script is not run either; with no start snapshot the folder's scripts are not run", () => {
  const plan = planChecks({
    ...base,
    changedScripts: ['test', 'e2e'],
    files: ['package.json'],
    packageJson: pkg({ test: 'node --test' }),
    criteria: [crit('a', 'npm test -- auth'), crit('b', 'pnpm run e2e'), crit('c', 'npm run lint'), crit('d', 'node --test x.test.js')],
  })
  expect(plan.filter((p) => p.criterion !== undefined).map((p) => p.command ?? `not run: ${p.reason}`)).toEqual([
    'not run: the test script changed during the mission',
    'not run: the e2e script changed during the mission',
    'npm run lint',
    'node --test x.test.js',
  ])
  const unknown = planChecks({
    ...base,
    changedScripts: undefined,
    configured: { lint: 'eslint .' },
    files: ['package.json'],
    packageJson: pkg({ test: 'node --test', build: 'tsc' }),
    criteria: [crit('a', 'npm test -- auth'), crit('d', 'node --test x.test.js')],
  })
  const cant = (s: string) => `not run: Spark can't tell whether the ${s} script changed (no start snapshot)`
  expect(unknown.map((p) => [p.name, p.command ?? `not run: ${p.reason}`])).toEqual([
    ['tests', cant('test')],
    ['lint', 'eslint .'],
    ['build', cant('build')],
    ['criterion 1', cant('test')],
    ['criterion 2', 'node --test x.test.js'],
  ])
})

test("a criterion with cmd's operators outside double quotes is not run: cmd reads them, the gate doesn't", () => {
  const plan = (how: string) => planChecks({ ...base, files: [], criteria: [crit('x', how)] }).find((p) => p.criterion === 0)!
  for (const how of [
    'node -e "1" & cu^rl --version',
    'node -e "1" & r^d /s /q C:\\x',
    "node -e 'x | hostname'",
    'npm test -- %TEMP%',
    'npm test > src/auth.js',
    'npm test\necho second',
    'node -e "a\\" & calc & "',
    'node -e "unclosed',
  ])
    expect([how, plan(how).reason]).toEqual([how, "it uses cmd's operators (& | < > ^ % ' and line breaks), which Spark won't run"])
  for (const how of ['npm test -- --grep "login limit"', 'node -e "console.log(42)"', 'cargo test lockout']) expect(plan(how).command).toBe(how)
})

test('criterion commands run unless the gate would ask; manual criteria are not planned', () => {
  const classify = (c: string) => (c.includes('install') ? { kind: 'ask' as const, reason: 'package install' } : undefined)
  const plan = planChecks({
    ...base,
    classify,
    files: [],
    criteria: [crit('sixth login gets 429', 'npm test -- auth'), crit('reads well', 'manual'), crit('deps ok', 'npm install express')],
  })
  expect(plan.filter((p) => p.criterion !== undefined).map((p) => [p.criterion, p.command ?? `not run: ${p.reason}`])).toEqual([
    [0, 'npm test -- auth'],
    [2, 'not run: the gate would ask: package install'],
  ])
})

test('the verdict comes from the checks alone', () => {
  const criteria = [crit('a', 'npm test'), crit('b', 'manual')]
  const pass = { name: 'tests', status: 'pass' as const }
  expect(verdict([pass, { name: 'criterion 1', criterion: 0, status: 'pass' as const }], [criteria[0]!])).toBe('verified')
  expect(verdict([pass, { name: 'criterion 1', criterion: 0, status: 'pass' as const }], criteria)).toBe('needs review')
  expect(verdict([pass, { name: 'lint', status: 'not-run' as const, reason: 'x' }], [])).toBe('needs review')
  expect(verdict([pass, { name: 'build', status: 'timed-out' as const }], [])).toBe('checks failed')
  expect(verdict([{ name: 'tests', status: 'not-run' as const, reason: 'none' }], [])).toBe('not verified')
})
