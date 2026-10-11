import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { CHECK_TIMED_OUT } from '../hooks/verify'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const
const mission = ($: Engine, args = '') => $.command.run({ command: 'mission', args, origin: composer, presentation })
const DRAFT = 'Read it.\n```mission\n{"title":"Rate-limit login","criteria":[{"text":"sixth login gets 429","how":"npm test"}]}\n```'
const key = (p: string) => String(p).replace(/\//g, '\\')
type Ran = { exitCode: number; stdout: string; stderr?: string }

// A session at C:/app with an in-memory disk, git that answers what snapshots ask, and a prompt box.
// `top`: the names at the repo top; `cmd`: how a check's command line (through cmd) ends.
function terminal(on: any, { top = [] as string[], cmd = (_line: string): Ran | Promise<Ran> => ({ exitCode: 0, stdout: '' }) } = {}) {
  const disk = new Map<string, string>()
  const ran: string[] = []
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
  on('fs.list', () => ({ value: top.map((name) => ({ name })) }))
  on('fs.exists', (_$: unknown, e: any) => ({ value: disk.has(key(e.path)) }))
  on('process.run', (_$: unknown, e: any) => {
    const a: string[] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // A check, through Spark's check runner: node -e <runner> -- <command> <ms>.
    if (a[0] === 'node' && a[1] === '-e') {
      const line = a[a.indexOf('--') + 1]!
      ran.push(line)
      return Promise.resolve(cmd(line)).then((r) => ({ value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }))
    }
    // package.json at the start snapshot: as it is now, so its scripts read as unchanged.
    if (a[1] === 'show') return disk.has(key('C:/app/package.json')) ? out(disk.get(key('C:/app/package.json'))!) : out('', 128)
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
  return { disk, ran, box: () => box, saved, files, settle }
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

async function runningMission($: Engine, t: ReturnType<typeof terminal>) {
  await $.session.start({ cwd: 'C:\app', surface: 'terminal', isInteractive: true })
  await mission($, 'rate-limit the login route')
  await t.settle()
  await turnComplete($, DRAFT)
  await t.settle()
  await mission($, 'approve')
  await t.settle()
}

test('an aborted turn pauses the mission instead of finishing it, and the next prompt resumes it', async ($, on) => {
  const t = terminal(on)
  await runningMission($, t)
  await ($ as any).turn.complete({ answer: '', durationMs: 900, isAborted: true, turnId: 't2', reason: 'aborted' })
  await t.settle()
  expect(t.saved()).toMatchObject({ status: 'paused', reason: 'you stopped the turn' })
  expect(t.files('report.json')).toEqual([])
  await $.turn.start({ text: 'carry on, per account', turnId: 't3' } as any)
  await t.settle()
  expect(t.saved().status).toBe('running')
})

test('parallel tool calls both reach the record', async ($, on) => {
  const t = terminal(on)
  await runningMission($, t)
  await Promise.all([
    $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/a.js', old_string: 'a', new_string: 'b', tool_use_id: 'p1' } as any),
    $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/b.js', old_string: 'a', new_string: 'b', tool_use_id: 'p2' } as any),
  ])
  await t.settle()
  const events = t.files('events.jsonl')[0]![1].trim().split('\n').map((l: string) => JSON.parse(l))
  expect(events.filter((e: any) => e.kind === 'tool').map((e: any) => e.id).sort()).toEqual(['p1', 'p2'])
})

test("a terminal mission ends with Spark's own checks: the verdict, the proof and redacted logs", async ($, on) => {
  const secret = `ghp_${'b'.repeat(36)}`
  const t = terminal(on, { top: ['package.json'], cmd: (line) => (line === 'npm test' ? { exitCode: 0, stdout: `ok 1 lockout\ntoken=${secret}\n` } : { exitCode: 1, stdout: 'nope' }) })
  t.disk.set(key('C:/app/package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  await runningMission($, t)
  await turnComplete($, 'Changed auth.js.')
  await t.settle()
  expect(t.ran).toEqual(['npm test', 'npm test'])
  const report = JSON.parse(t.files('report.json')[0]![1])
  expect(report.status).toBe('Finished · Verified')
  expect(report.proof.checks.map((c: any) => [c.name, c.status])).toEqual([
    ['tests', 'pass'],
    ['criterion 1', 'pass'],
  ])
  const log = t.files('checks\\1.log')[0]![1]
  expect(log).toContain('ok 1 lockout')
  expect(log).not.toContain(secret)
  const events = t.files('events.jsonl')[0]![1].trim().split('\n').map((l: string) => JSON.parse(l))
  expect(events.filter((e: any) => e.kind === 'verify' || e.kind === 'check').map((e: any) => e.kind)).toEqual(['verify', 'check', 'check'])
})

test("terminal checks: a check past its limit is timed out, and records a check writes during the pass don't count", async ($, on) => {
  let calls = 0
  const t = terminal(on, {
    top: ['package.json'],
    cmd: () => {
      calls++
      if (calls === 1) {
        // The suite's own code writes a passing pass into the mission's records, then fails.
        const [path, text] = t.files('events.jsonl')[0]!
        t.disk.set(path, `${text}${JSON.stringify({ at: 1, kind: 'verify', again: false })}\n${JSON.stringify({ at: 2, kind: 'check', name: 'tests', status: 'pass' })}\n`)
        return { exitCode: 1, stdout: 'not ok 1' }
      }
      return { exitCode: 124, stdout: '', stderr: `\n${CHECK_TIMED_OUT}\n` }
    },
  })
  t.disk.set(key('C:/app/package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  await runningMission($, t)
  await turnComplete($, 'Changed auth.js.')
  await t.settle()
  const report = JSON.parse(t.files('report.json')[0]![1])
  expect(report.status).toBe('Finished · Checks failed')
  expect(report.proof.checks.map((c: any) => [c.name, c.status])).toEqual([
    ['tests', 'fail'],
    ['criterion 1', 'timed-out'],
  ])
})

test("a slow terminal check doesn't hold the mod's other work: /mission answers while it runs", async ($, on) => {
  let release = () => {}
  let released = false
  const ok: Ran = { exitCode: 0, stdout: 'ok' }
  // The first check waits until released; the ones after it answer at once.
  const t = terminal(on, {
    top: ['package.json'],
    cmd: () => (released ? ok : new Promise<Ran>((r) => (release = () => ((released = true), r(ok))))),
  })
  t.disk.set(key('C:/app/package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  await runningMission($, t)
  await turnComplete($, 'Changed auth.js.')
  await t.settle()
  expect(t.ran).toEqual(['npm test'])
  expect((await mission($, 'cancel')).text).toBe('✦ the mission is already finished')
  release()
  await t.settle()
  await t.settle()
  expect(t.files('report.json')).toHaveLength(1)
})

const PLANNED = `Read it.\n\`\`\`mission\n${JSON.stringify({
  title: 'Rate-limit login',
  criteria: [{ text: 'sixth login gets 429', how: 'manual' }],
  tasks: [
    { id: 't1', title: 'Limiter', do: 'Add it', after: [], check: 'npm test -- limiter' },
    { id: 't2', title: 'Message', do: 'Say when', after: ['t1'] },
  ],
})}\n\`\`\``

test('a planned terminal mission drives its tasks: after a passing check the next task fills the prompt; the last one finishes it', async ($, on) => {
  let limiter = 0
  const t = terminal(on, { cmd: (line) => ({ exitCode: line === 'npm test -- limiter' && ++limiter > 1 ? 0 : 1, stdout: `run ${limiter}` }) })
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  await mission($, 'rate-limit the login route')
  await t.settle()
  await turnComplete($, PLANNED)
  await t.settle()
  expect(t.saved().tasks).toHaveLength(2)
  await mission($, 'approve')
  await t.settle()
  expect(t.box()).toContain('Do only task t1 (Limiter) now: Add it')
  await turnComplete($, 'Added the limiter.')
  await t.settle()
  await t.settle()
  expect(t.box()).toMatch(/^\\Task t1's check failed \(exit 1\):/)
  await turnComplete($, 'Fixed it.')
  await t.settle()
  await t.settle()
  expect(t.ran).toEqual(['npm test -- limiter', 'npm test -- limiter'])
  expect(t.box()).toMatch(/^\\Do only task t2 \(Message\) now: Say when/)
  expect(t.saved().status).toBe('running')
  await turnComplete($, 'Added the message.')
  await t.settle()
  await t.settle()
  expect(t.saved()).toMatchObject({ status: 'finished', reason: 'every task is done' })
  const events = t.files('events.jsonl')[0]![1].trim().split('\n').map((l: string) => JSON.parse(l))
  expect(events.filter((e: any) => e.kind === 'task').map((e: any) => `${e.id} ${e.event}#${e.attempt}`)).toEqual(['t1 started#1', 't1 retry#2', 't1 done#2', 't2 started#1', 't2 done#1'])
  const report = JSON.parse(t.files('report.json')[0]![1])
  expect(report.tasks.map((x: any) => x.state)).toEqual(['done', 'done'])
})

test('a cancelled terminal mission is not checked', async ($, on) => {
  const t = terminal(on, { top: ['package.json'] })
  t.disk.set(key('C:/app/package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  await runningMission($, t)
  await mission($, 'cancel')
  await t.settle()
  expect(t.ran).toEqual([])
  expect(JSON.parse(t.files('report.json')[0]![1]).proof).toBeUndefined()
})

test('a subagent during the draft is refused edits too', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\app', surface: 'terminal', isInteractive: true })
  await mission($, 'rate-limit the login route')
  await t.settle()
  const denied: any = await $.tool.call({ tool: 'Write', file_path: 'C:/app/src/x.js', content: 'x', agentId: 'sub-1' } as any)
  expect(denied.deny).toContain('being drafted')
})
