import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { RUBRIC, SECTIONS } from '../hooks/council'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const
const council = ($: Engine, args = '') => $.command.run({ command: 'council', args, origin: composer, presentation })
const mission = ($: Engine, args = '') => $.command.run({ command: 'mission', args, origin: composer, presentation })
const key = (p: string) => String(p).replace(/\//g, '\\')
const BRIEF = '```brief\n{"objective":"speed up the cache","context":[],"constraints":[],"criteria":["p95 under 50 ms"],"verification":["npm run bench"]}\n```'
const proposal = SECTIONS.map((s) => `## ${s}\nuse an LRU`).join('\n')
const verdict = (letters: string[]) =>
  '```verdict\n' +
  JSON.stringify({ scores: Object.fromEntries(letters.map((l, i) => [l, Object.fromEntries(RUBRIC.map((r) => [r.key, 9 - i]))])), rank: letters, preferred: letters[0], ideas: [], risks: [], hybrid: { base: letters[0], take: [], drop: [], conflicts: [], worthIt: false }, confidence: 'high' }) +
  '\n```'
const SYNTH = '## Decision\ndominant: A\n## Acceptance criteria\n```mission\n{"title":"Faster cache","criteria":[{"text":"p95 under 50 ms","how":"npm run bench"}]}\n```'
const letters = (user: string) => [...user.matchAll(/<proposal letter="(\w)">/g)].map((m) => m[1]!)
// A model's reply for a request, by what its system prompt asks for.
const answerFor = (system: string, user: string) =>
  system.startsWith('You prepare a problem brief') ? BRIEF : system.startsWith('You are one of several') ? proposal : system.startsWith('You are an independent judge') ? verdict(letters(user)) : SYNTH

// A terminal session at C:/app with an in-memory disk, Claude and Gemini that answer well, and no Ollama.
function terminal(on: any) {
  const disk = new Map<string, string>()
  const seen: string[] = []
  mock.env(on, { SPARK_GEMINI_KEY: 'AIza-test', TEMP: 'C:\\tmp' })
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', () => ({ isFilled: true }))
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
    if (a[0] === 'claude') {
      const system = a[a.indexOf('--system-prompt') + 1]!
      seen.push(`claude:${a[a.indexOf('--model') + 1]}`)
      return out(JSON.stringify({ result: answerFor(system, e.stdin ?? e.init?.stdin ?? ''), is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20 } }))
    }
    if (a.includes('--show-toplevel')) return out('C:/app\n')
    if (a.includes('--git-path')) return out(`C:/app/.git/${a.at(-1)}\n`)
    return out('')
  })
  on('http.fetch', (_$: unknown, e: any) => {
    const respond = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (e.url.includes('11434')) return respond(500, {})
    if (e.url.includes('/v1beta/models?'))
      return respond(200, {
        models: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemma-4-31b-it'].map((m) => ({ name: `models/${m}`, inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] })),
      })
    const body = JSON.parse(e.init.body)
    seen.push(`gemini:${e.url.match(/models\/([^:]+):/)[1]}`)
    return respond(200, { candidates: [{ content: { parts: [{ text: answerFor(body.systemInstruction.parts[0].text, body.contents[0].parts[0].text) }] } }] })
  })
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await clock.advance(50)
      await clock.settle()
    }
  }
  const councilFile = () => JSON.parse([...disk.entries()].find(([k]) => k.includes('\\.spark\\councils\\'))![1])
  return { disk, seen, settle, councilFile, config: () => disk.get('C:\\Users\\me\\AppData\\Roaming\\spark\\config.json') }
}

test('/council: the brief and panel first; /council run asks the models and saves the record; /council mission starts a mission in review', async ($, on) => {
  const t = terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  expect((await council($, 'speed up the cache')).text).toContain('writing the brief')
  await t.settle()
  const pre = t.councilFile()
  expect(pre.brief.objective).toBe('speed up the cache')
  expect(pre.panel.proposers.map((s: any) => s.id).sort()).toEqual(['gemini-3.8-flash', 'gemma-4-31b-it', 'sonnet'])
  expect(pre.panel.judges.map((s: any) => s.id)).toEqual(['gemini-3.5-flash', 'opus'])
  expect(pre.consentNeeded).toEqual(['gemini'])
  expect(t.seen.filter((s) => !s.startsWith('claude:sonnet'))).toEqual([])
  expect((await council($, 'run')).text).toContain('council running')
  await t.settle()
  const done = t.councilFile()
  expect(done.run.status).toBe('done')
  expect(done.run.aggregate.judged).toBe(2)
  expect((await council($, 'mission')).text).toContain('/mission approve')
  await t.settle()
  const missionFile = JSON.parse([...t.disk.entries()].find(([k]) => k.endsWith('mission.json'))![1])
  expect(missionFile).toMatchObject({ status: 'review', criteria: [{ text: 'p95 under 50 ms', how: 'npm run bench', by: 'claude' }] })
  expect((await mission($, 'approve')).text).toBe('✦ approved: Enter sends the mission to Claude')
})

test('/council with no question says how to ask; /council run with nothing waiting says so', async ($, on) => {
  terminal(on)
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  expect((await council($, '')).text).toBe('✦ /council [full] <question>; then /council run, /council cancel or /council mission')
  expect((await council($, 'run')).text).toBe('✦ no council is waiting to run')
})
