import { test, expect } from 'claude-code/testing'
import { MISP } from '../hooks/misp'
import { fakeRepo, startTurn, stop } from './fake'

test('when the turn changed files and the tests fail, Claude is sent back with the tail', async ($, on) => {
  fakeRepo(on)
  await startTurn($)
  const result = await stop($)
  expect(result.block).toMatch(/^✦ tests failed \(exit 1\)\n/)
  expect(result.block).toContain('not ok 2 subtracts')
})

test('passing tests, no change, a closing question or --no-tests let the turn end', async ($, on) => {
  const repo = fakeRepo(on)
  await startTurn($)
  repo.testExit = 0
  expect((await stop($)).block).toBeUndefined()
  repo.testExit = 1
  expect((await stop($, 'Export the filtered rows or all of them?')).block).toBeUndefined()
  repo.changed = false
  expect((await stop($)).block).toBeUndefined()
  expect(repo.testRuns).toBe(1)
})

test('--no-tests turns the gate off for the session', async ($, on) => {
  const repo = fakeRepo(on, { SPARK_NO_TESTS: '1' })
  await startTurn($)
  expect((await stop($)).block).toBeUndefined()
  expect(repo.testRuns).toBe(0)
})

test('the rules tell Claude what the test gate does', () => {
  expect(MISP).toContain('\n- Test gate: when you end a turn after changing files, Spark runs the tests.')
})

test("a command Claude Code refuses to register (its own /goal) doesn't switch the gate off", async ($, on) => {
  fakeRepo(on, {}, undefined, ['goal'])
  await startTurn($)
  expect((await stop($)).block).toContain('tests failed')
})

test('an untrusted folder never has its own test script run unasked', async ($, on) => {
  const repo = fakeRepo(on, { SPARK_UNTRUSTED: '1' })
  await startTurn($)
  expect((await stop($)).block).toBeUndefined()
  expect(repo.testRuns).toBe(0)
})

test("a continuation after a block keeps the turn's snapshot, so the failing tests run again", async ($, on) => {
  let snapshots = 0
  fakeRepo(on, {}, (argv) => {
    if (argv.includes('commit-tree')) snapshots++
    return undefined
  })
  await startTurn($)
  expect((await stop($)).block).toContain('tests failed')
  await $.turn.start({ text: '', turnId: 't2' } as any)
  expect(snapshots).toBe(1)
  await $.turn.start({ text: 'now add division', turnId: 't3' } as any)
  expect(snapshots).toBe(2)
})
