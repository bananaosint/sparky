import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HALT_REASON, isBuild, editAllowedWhileHalted } from '../hooks/halt'
import { MISP } from '../hooks/misp'
import { fakeRepo, startTurn, stop } from './fake'

const composer = { kind: 'composer' } as const
const edit = ($: Engine, file: string) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' } as any)
const shell = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as any)
const unhalt = ($: Engine) => $.command.run({ command: 'spark-unhalt', args: '', origin: composer, presentation: { isFullscreen: false, columns: 120 } })

// Core answers every tool call; a build command fails while `builds` says so.
function core(on: any) {
  const state = { buildFails: true, reached: [] as string[] }
  on('tool.call', (_$: unknown, e: any) => {
    state.reached.push(e.file_path ?? e.command)
    return e.tool === 'Bash' && state.buildFails && isBuild(e.command)
      ? { isError: true, result: 'Exit code 2', text: 'Exit code 2\nsrc/a.ts(3,1): error TS2304' }
      : { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return state
}

test('build commands are recognised wherever they sit in the line', () => {
  for (const c of ['npm run build', 'npx tsc -p .', 'cd app && pnpm build', 'cargo build --release', 'go build ./...', 'dotnet build', 'vite build', 'pnpm run build', 'yarn build', 'npm run build:prod', 'npx vite build'])
    expect(`${c} → ${isBuild(c)}`).toBe(`${c} → true`)
  for (const c of ['npm test', 'git status', 'echo tscx', 'npm run build-docs-later', 'which tsc', 'grep tsc package.json', 'git commit -m "fix tsc errors"'])
    expect(`${c} → ${isBuild(c)}`).toBe(`${c} → false`)
  // The last command decides: a failure there is the tests', and the test gate counts it.
  expect(isBuild('npm run build && npm test')).toBe(false)
})

test('while halted only post-mortems can be edited', () => {
  expect(editAllowedWhileHalted('C:\\app\\docs\\postmortems\\2026-10-10--login.md', 'C:/app')).toBe(true)
  expect(editAllowedWhileHalted('docs/postmortems/x.md', 'C:/app')).toBe(true)
  expect(editAllowedWhileHalted('C:/app/src/login.ts', 'C:/app')).toBe(false)
  expect(editAllowedWhileHalted('C:/app/docs/postmortems/../../src/login.ts', 'C:/app')).toBe(false)
})

test('two failing test runs in a row halt: the second turn end is not blocked, edits are denied', async ($, on) => {
  fakeRepo(on)
  const tools = core(on)
  await startTurn($)
  expect((await stop($)).block).toContain('tests failed')
  expect((await stop($)).block).toBeUndefined()
  expect(await edit($, 'C:\\app\\src\\a.js')).toEqual({ deny: HALT_REASON })
  await edit($, 'C:\\app\\docs\\postmortems\\2026-10-10--subtract.md')
  expect(tools.reached).toEqual(['C:\\app\\docs\\postmortems\\2026-10-10--subtract.md'])
})

test('a passing test run resets the streak', async ($, on) => {
  const repo = fakeRepo(on)
  core(on)
  await startTurn($)
  await stop($)
  repo.testExit = 0
  await stop($)
  repo.testExit = 1
  expect((await stop($)).block).toContain('tests failed')
})

test('two failed builds in a row halt; a build that passes in between resets', async ($, on) => {
  fakeRepo(on)
  const tools = core(on)
  await startTurn($)
  await shell($, 'npm run build')
  tools.buildFails = false
  await shell($, 'npm run build')
  tools.buildFails = true
  await shell($, 'npm run build')
  expect((await edit($, 'C:\\app\\src\\a.js')).deny).toBeUndefined()
  const second = await shell($, 'npx tsc -p .')
  expect(second.context).toContain(HALT_REASON)
  expect(await edit($, 'C:\\app\\src\\a.js')).toEqual({ deny: HALT_REASON })
})

test('/spark-unhalt waits for a post-mortem written after the halt', async ($, on) => {
  const repo = fakeRepo(on)
  core(on)
  await startTurn($)
  expect((await unhalt($)).text).toBe('✦ not halted')
  await repo.clock.advance(60_000)
  await stop($)
  await stop($)
  expect((await unhalt($)).text).toBe('✦ still halted: write the post-mortem first (/spark:postmortem)')
  repo.postmortems = [{ name: '2026-10-09--older.md', mtimeMs: 1000 }]
  expect((await unhalt($)).text).toBe('✦ still halted: write the post-mortem first (/spark:postmortem)')
  repo.postmortems.push({ name: '2026-10-10--subtract.md', mtimeMs: 90_000 })
  expect((await unhalt($)).text).toBe('✦ halt lifted')
  expect((await edit($, 'C:\\app\\src\\a.js')).deny).toBeUndefined()
})

test('while halted every prompt carries <spark-halt>', async ($, on) => {
  fakeRepo(on)
  core(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$: unknown, e: any) => {
    seen.push(e.context)
    return { text: e.text }
  })
  await startTurn($)
  await stop($)
  await stop($)
  await $.prompt.submit({ text: 'why did it fail', wait: false, origin: composer })
  expect(seen.at(-1)?.join('\n')).toContain('<spark-halt>')
  expect(MISP).toContain('- Halt: after two consecutive build or test failures Spark blocks edits and shows <spark-halt>.')
})
