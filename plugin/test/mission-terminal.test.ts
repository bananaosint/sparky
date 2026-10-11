import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const
const mission = ($: Engine, args = '') => $.command.run({ command: 'mission', args, origin: composer, presentation })
const DRAFT = 'Read it.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"sixth login gets 429","how":"npm test"}]}\n```'
const key = (p: string) => String(p).replace(/\//g, '\\')

// A session at C:/app with an in-memory disk, git that answers what snapshots ask, and a prompt box.
function terminal(on: any) {
  const disk = new Map<string, string>()
  let box = ''
  mock.env(on, {})
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer }))
  on('prompt.fill', (_$: unknown, e: any) => {
    box = e.text
    return { isFilled: true }
  })
  // missionTurn and missionReport open the pane and toast: answer them, whatever the harness does unmocked.
  on('ui.open', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_$: unknown, e: any) => {
    disk.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_$: unknown, e: any) => (disk.has(key(e.path)) ? { value: disk.get(key(e.path)) } : { deny: 'no such file' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: disk.has(key(e.path)) }))
  on('process.run', (_$: unknown, e: any) => {
    const a: string[] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.includes('--show-toplevel')) return out('C:/app\n')
    if (a.includes('--git-path')) return out(`C:/app/.git/${a.at(-1)}\n`)
    if (a.includes('write-tree')) return out(`${'f'.repeat(40)}\n`)
    if (a.includes('commit-tree')) return out(`${'a'.repeat(40)}\n`)
    if (a.includes('--numstat')) return out('3\t1\tsrc/auth.js\n')
    if (a.some((x) => x.endsWith('^{tree}'))) return out(`${'f'.repeat(40)}\n`)
    if (a.includes('--verify')) return out('head1\n')
    if (a.includes('--quiet')) return out('', 0)
    return out('')
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const files = (name: string) => [...disk.entries()].filter(([k]) => k.endsWith(name))
  const saved = () => JSON.parse(files('mission.json')[0]![1])
  const settle = async () => {
    await clock.advance(50)
    await clock.settle()
  }
  return { disk, box: () => box, saved, files, settle }
}

const turnComplete = ($: Engine, answer: string) =>
  ($ as any).turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })

test('/mission drafts read-only, approve fills the run message, and a finished turn writes the report', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  expect((await mission($, 'rate-limit the login route')).text).toContain('Enter sends the draft request')
  await t.settle()
  expect(t.box()).toMatch(/^\\Mission: rate-limit the login route/)
  const denied: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/auth.js', old_string: 'a', new_string: 'b' } as any)
  expect(denied.deny).toContain('being drafted')
  await turnComplete($, DRAFT)
  await t.settle()
  expect(t.saved()).toMatchObject({ status: 'review', title: 'Rate-limit login' })
  expect((await mission($, 'approve')).text).toBe('✦ approved: Enter sends the mission to Claude')
  await t.settle()
  expect(t.box()).toContain('1. sixth login gets 429 (check: npm test)')
  expect(t.saved().startSha).toBe('a'.repeat(40))
  await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/auth.js', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as any)
  await turnComplete($, 'Changed auth.js.')
  await t.settle()
  expect(t.saved().status).toBe('finished')
  const report = JSON.parse(t.files('report.json')[0]![1])
  expect(report.files).toEqual([{ path: 'src/auth.js', added: 3, removed: 1 }])
  expect(report.cost).toEqual({})
  const events = t.files('events.jsonl')[0]![1].trim().split('\n').map((l: string) => JSON.parse(l))
  expect(events.some((e: any) => e.kind === 'tool' && e.name === 'Edit')).toBe(true)
})

test('/mission refuses a second mission while one is live, and cancel ends it', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  await mission($, 'rate-limit the login route')
  expect((await mission($, 'something else')).text).toBe('✦ a mission is draft: /mission cancel ends it first')
  expect((await mission($, 'cancel')).text).toBe('✦ mission cancelled')
  expect(t.saved().status).toBe('cancelled')
  expect((await mission($, 'something else')).text).toContain('Enter sends the draft request')
})
