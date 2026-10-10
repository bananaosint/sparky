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
// `refuse` lists, per model, what its next calls give instead of an answer: an
// HTTP status, or 'hang' for a call that never returns. `waitMs` is how long the
// test lets the cook run.
async function cookWith($: Engine, on: any, registry: Registry, refuse: Record<string, (number | 'hang')[]> = {}, waitMs = 30) {
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
    const outcome = refuse[model]?.shift()
    if (outcome === 'hang') return new Promise(() => {})
    if (outcome) return respond(outcome, { error: { code: outcome } })
    if (system.startsWith('You rewrite')) return answer({ prompt: 'Add Playwright e2e tests for checkout, test first.', unclear: [] })
    if (system.startsWith('You pick')) return answer({ skills: ['tdd'], search: ['playwright e2e'] })
    return answer({ install: ['microsoft/playwright@playwright', 'nobody/tiny@playwright-lite'] })
  })
  await $.session.start({ cwd: 'C:\\code\\app', surface: 'terminal', isInteractive: true })

  await typePrompt($, 'add playwright e2e tests for checkout, test first')
  for (let ms = 0; ms < waitMs; ms += 1000) {
    await clock.advance(Math.min(1000, waitMs - ms))
    await clock.settle()
  }
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

test('a model that fails three times hands the prompt to the next model in its chain', async ($, on) => {
  const { box, toasts, rewrites, routes } = await cookWith($, on, { status: 503 }, {
    'gemini-3.6-flash': [429, 429, 429],
    'gemini-3.5-flash': [500, 500, 500],
    'gemini-3.5-flash-lite': [429, 429, 429],
  })
  expect(rewrites).toEqual([...Array(3).fill('gemini-3.6-flash'), ...Array(3).fill('gemini-3.5-flash'), 'gemini-3-flash-preview'])
  expect(routes).toEqual([...Array(3).fill('gemini-3.5-flash-lite'), 'gemini-3.1-flash-lite'])
  expect(toasts).toEqual([])
  expect(box).toBe('Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd')
})

test('a slow model gets three tries of 10 seconds, then the next model answers', async ($, on) => {
  const { box, toasts, rewrites } = await cookWith($, on, { status: 503 }, { 'gemini-3.6-flash': ['hang', 'hang', 'hang'] }, 31_000)
  expect(rewrites).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'])
  expect(toasts).toEqual([])
  expect(box).toBe('Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd')
})

test('a model that fails once is asked again before the chain moves on', async ($, on) => {
  const { box, rewrites } = await cookWith($, on, { status: 503 }, { 'gemini-3.6-flash': [503] })
  expect(rewrites).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash'])
  expect(box).toBe('Add Playwright e2e tests for checkout, test first.\n\nSkills: tdd')
})

test('a refused key stops the chain instead of trying every model', async ($, on) => {
  const { box, rewrites } = await cookWith($, on, { status: 503 }, { 'gemini-3.6-flash': [403] })
  expect(rewrites).toEqual(['gemini-3.6-flash'])
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
  expect(json).toContain('"type":"Image"')
})

// Types a prompt with an image attached and answers Spark's two questions in turn.
async function imagePrompt($: Engine, on: any, answers: string[]) {
  mock.env(on, { SPARK_GEMINI_KEY: 'test-key' })
  const clock = mock.clock(on)
  on('env.set', () => ({ value: undefined }))
  on('command.register', (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  const asked: string[] = []
  // $.ui.ask is a tool call of AskUserQuestion; the test answers it.
  on('tool.call', (_$: unknown, e: any) => {
    const question = e.questions?.[0]?.question ?? JSON.stringify(e)
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: answers.shift() } } }
  })
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ prompt: 'Restyle the header to match the attached screenshot.', unclear: [] }) }] } }] }),
    },
  }))
  const reached: { text: string; attachments?: readonly unknown[] }[] = []
  on('prompt.submit', (_$: unknown, e: any) => {
    reached.push({ text: e.text, attachments: e.attachments })
    return { text: e.text }
  })
  await $.session.start({ cwd: 'C:\\code\\app', surface: 'terminal', isInteractive: true })
  const submitted = $.prompt.submit({
    text: 'make the header look like this screenshot',
    wait: false,
    origin: composer,
    attachments: [{ type: 'image', mediaType: 'image/png' }],
  } as any)
  await clock.settle()
  await submitted
  return { asked, reached }
}

test('a prompt with an image asks first; "Send as typed" sends it unchanged with the image', async ($, on) => {
  const { asked, reached } = await imagePrompt($, on, ['Send as typed'])
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Promptify')
  expect(reached).toEqual([{ text: 'make the header look like this screenshot', attachments: [{ type: 'image', mediaType: 'image/png' }] }])
})

test('promptifying shows Gemini\'s version and sends it with the image when chosen', async ($, on) => {
  const { asked, reached } = await imagePrompt($, on, ['Promptify', "Send Gemini's version"])
  expect(asked.length).toBe(2)
  expect(asked[1]).toContain('Restyle the header to match the attached screenshot.')
  expect(reached).toEqual([{ text: 'Restyle the header to match the attached screenshot.', attachments: [{ type: 'image', mediaType: 'image/png' }] }])
})
