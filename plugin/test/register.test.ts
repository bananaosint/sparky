import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 120 }
const composer = { kind: 'composer' } as const

const runCommand = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: composer, presentation })

const typePrompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: composer })

test('the MISP is added as the last system prompt section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine prompt', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections[0]?.id).toBe('intro')
  const last = sections.at(-1)
  expect(last?.id).toBe('spark:misp')
  expect(last?.scope).toBe('session')
  expect(last?.text).toContain('### Clarify before building')
})

test('mode commands toggle and report the active set', async ($) => {
  expect((await runCommand($, 'anti-slop')).text).toBe('✦ anti-slop on')
  expect((await runCommand($, 'thinking-red-team')).text).toBe('✦ thinking-red-team on')
  expect((await runCommand($, 'spark-modes')).text).toBe('✦ modes on: anti-slop, thinking-red-team')
  expect((await runCommand($, 'anti-slop')).text).toBe('✦ anti-slop off')
  expect((await runCommand($, 'spark-modes', 'off')).text).toBe('✦ all modes off')
})

test('without a Gemini key a typed prompt goes straight through, with active modes attached', async ($, on) => {
  const seen: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => {
    seen.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  await runCommand($, 'anti-slop')
  await typePrompt($, 'please add csv export to the invoices page')
  expect(seen).toEqual([
    { text: 'please add csv export to the invoices page', context: ['<spark-modes>anti-slop</spark-modes>'] },
  ])
})

test('with a key the first Enter is held for cooking, Enter while cooking sends as typed, a backslash skips it', async ($, on) => {
  mock.env(on, { SPARK_GEMINI_KEY: 'test-key' })
  mock.clock(on)
  const unset: string[] = []
  on('env.set', (_$, e) => {
    if (e.value === undefined) unset.push(e.name)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const reached: string[] = []
  on('prompt.submit', (_$, e) => {
    reached.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: 'C:\\code\\app', surface: 'terminal', isInteractive: true })
  expect(unset).toEqual(['SPARK_GEMINI_KEY'])

  expect(await typePrompt($, 'please add csv export to the invoices page')).toMatchObject({ drop: expect.any(String) })
  expect(reached).toEqual([])

  await typePrompt($, 'please add csv export to the invoices page')
  expect(reached).toEqual(['please add csv export to the invoices page'])

  await typePrompt($, '\\ just send this one as typed please')
  expect(reached.at(-1)).toBe('just send this one as typed please')
})

type Registry = { status: number; skills?: object[] }

// Cooks one prompt with Gemini and skills.sh answered by the test; returns what landed.
// `refuse` maps a model to the HTTP status it answers instead.
async function cookWith($: Engine, on: any, registry: Registry, refuse: Record<string, number> = {}) {
  mock.env(on, { SPARK_GEMINI_KEY: 'test-key' })
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.list', () => ({ value: [{ name: 'tdd', description: 'Test-driven development', source: 'user' as const }] }))
  let box = ''
  on('prompt.fill', (_$: unknown, e: any) => {
    box = e.text
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: 0 } }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: any) => {
    toasts.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  const searched: string[] = []
  const rewrites: string[] = []
  const routes: string[] = []
  const respond = (status: number, body: object) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
  const answer = (json: object) => respond(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] })
  on('http.fetch', (_$: unknown, e: any) => {
    if (e.url.startsWith('https://skills.sh/')) {
      searched.push(e.url)
      return respond(registry.status, { skills: registry.skills ?? [] })
    }
    const system: string = JSON.parse(e.init.body).systemInstruction.parts[0].text
    const model = e.url.match(/models\/([^:]+):/)[1]
    if (system.startsWith('You rewrite')) rewrites.push(model)
    if (system.startsWith('You pick')) routes.push(model)
    if (refuse[model]) return respond(refuse[model], { error: { code: refuse[model] } })
    if (system.startsWith('You rewrite')) return answer({ prompt: 'Add Playwright e2e tests for checkout, test first.', unclear: [] })
    if (system.startsWith('You pick')) return answer({ skills: ['tdd'], search: ['playwright e2e'] })
    return answer({ install: ['microsoft/playwright@playwright', 'nobody/tiny@playwright-lite'] })
  })
  await $.session.start({ cwd: 'C:\\code\\app', surface: 'terminal', isInteractive: true })

  await typePrompt($, 'add playwright e2e tests for checkout, test first')
  await clock.advance(30)
  await clock.settle()
  return { box, searched, toasts, rewrites, routes }
}

test('cooking loads installed skills, searches skills.sh for missing ones and fills the box', async ($, on) => {
  const { box, searched, toasts } = await cookWith($, on, {
    status: 200,
    skills: [
      { source: 'microsoft/playwright', skillId: 'playwright', installs: 52000 },
      { source: 'nobody/tiny', skillId: 'playwright-lite', installs: 12 },
    ],
  })
  expect(toasts).toEqual([])
  expect(searched).toEqual(['https://skills.sh/api/search?q=playwright%20e2e&limit=10'])
  expect(box).toBe(
    'Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd\n\n' +
      'Install these skills first with `npx skills add <id> -g -y`:\n- microsoft/playwright@playwright (52K installs)',
  )
})

test('a failing skills.sh search keeps the installed picks', async ($, on) => {
  const { box, toasts } = await cookWith($, on, { status: 503 })
  expect(toasts).toEqual([])
  expect(box).toBe('Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd')
})

test('a model out of quota or failing hands the prompt to the next model in its chain', async ($, on) => {
  const { box, toasts, rewrites, routes } = await cookWith($, on, { status: 503 }, {
    'gemini-3.8-flash': 429,
    'gemini-3.7-flash': 500,
    'gemini-3.5-flash-lite': 429,
  })
  expect(rewrites).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'])
  expect(routes).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])
  expect(toasts).toEqual([])
  expect(box).toBe('Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd')
})

test('a refused key stops the chain instead of trying every model', async ($, on) => {
  const { box, rewrites } = await cookWith($, on, { status: 503 }, { 'gemini-3.8-flash': 403 })
  expect(rewrites).toEqual(['gemini-3.8-flash'])
  expect(box).toBe('add playwright e2e tests for checkout, test first\n\nSkills: tdd')
})

test('the band draws the spark label letter by letter in the blue-to-ultraviolet gradient', async ($) => {
  const tree = await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 },
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('#38BDF8')
  expect(json).toContain('#A855F7')
  expect(json).toContain('gemini off: run spark key set')
})
