import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const

const runCommand = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: composer, presentation })

const band = async ($: Engine) =>
  JSON.stringify(
    await $.ui.render({
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 },
    } as any),
  )

function session(on: any) {
  mock.env(on, {})
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  let box = ''
  on('prompt.fill', (_$: unknown, e: any) => {
    box = e.text
    return { isFilled: true }
  })
  return { clock, box: () => box }
}

test('/sandbox turns the end-of-turn review on and off', async ($) => {
  expect((await runCommand($, 'sandbox')).text).toBe('✦ sandbox on: each turn ends with keep or revert')
  expect((await runCommand($, 'sandbox')).text).toBe('✦ sandbox off')
})

test('/spark-fix with no recorded failure says how to record one', async ($) => {
  expect((await runCommand($, 'spark-fix')).text).toBe('✦ no failed command to attach. Run it with spark try <command> first.')
})

test('a failed spark try turns the band red, and /spark-fix puts it in the prompt box with secrets redacted', async ($, on) => {
  const { clock, box } = session(on)
  const record = {
    command: 'npm test',
    cwd: 'C:/app',
    exitCode: 1,
    output: 'login.test.ts\n  expected token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to be valid\n',
    at: 7,
  }
  on('process.run', (_$: unknown, e: unknown) =>
    JSON.stringify(e).includes('spark-failure.json')
      ? { value: { exitCode: 0, stdout: 'C:/app/.git/spark-failure.json\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 128, stdout: '', stderr: 'not here', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 5, isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify(record) }))
  await $.session.start({ cwd: 'C:\app', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  await clock.settle()

  const shown = await band($)
  expect(shown).toContain('npm test failed (exit 1)')
  // The face is drawn a cell at a time, in the error color.
  expect(shown).toContain('"children":["×"]')
  expect(shown).toContain('#FB7185')

  await runCommand($, 'spark-fix')
  await clock.advance(30)
  await clock.settle()
  expect(box()).toContain('`npm test` failed with exit code 1 (in C:/app)')
  expect(box()).toContain('login.test.ts')
  expect(box()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  expect(await band($)).not.toContain('npm test failed')
})
