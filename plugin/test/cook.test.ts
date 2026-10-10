import { test, expect } from 'claude-code/testing'
import { decide, composeCooked, isEditOf } from '../hooks/cook'
import type { CookPhase } from '../types'

const idle: CookPhase = { kind: 'idle' }
const typed = (text: string) => ({ text, origin: { kind: 'composer' as const } })
const config = { enabled: true, minWords: 4 }

test('a typed prompt of enough words is cooked', () => {
  expect(decide(typed('add csv export to the invoices page'), idle, config)).toEqual({ action: 'cook' })
})

test('short prompts, slash commands and gemini-off are sent as typed', () => {
  expect(decide(typed('yes do it'), idle, config)).toEqual({ action: 'send', text: 'yes do it' })
  expect(decide(typed('/compact keep the plan'), idle, config).action).toBe('send')
  expect(decide(typed('add csv export to the invoices page'), idle, { ...config, enabled: false }).action).toBe('send')
})

test('a leading backslash sends the rest as typed', () => {
  expect(decide(typed('\\ add csv export to the invoices page'), idle, config)).toEqual({
    action: 'send',
    text: 'add csv export to the invoices page',
  })
})

test('prompts not typed at the composer pass through untouched', () => {
  const e = { text: 'a background task finished with three warnings', origin: { kind: 'task-notification' as const } }
  expect(decide(e, idle, config)).toEqual({ action: 'send', text: e.text })
})

test('mid-turn prompts are steering and go straight through', () => {
  expect(decide({ ...typed('no, use the other config file instead'), turnId: 't1' }, idle, config).action).toBe('send')
})

test('images and pasted text are never cooked, with a notice', () => {
  const withImage = { ...typed('make the header look like this screenshot'), attachments: [{ type: 'image' as const }] }
  expect(decide(withImage, idle, config)).toMatchObject({ action: 'send', notice: expect.any(String) })
  const pasted = typed('fix this error\n<pasted_content id="a1">\nTypeError: x\n</pasted_content id="a1">')
  expect(decide(pasted, idle, config)).toMatchObject({ action: 'send', notice: expect.any(String) })
})

test('Enter while cooking sends what is in the box', () => {
  const cooking: CookPhase = { kind: 'cooking', raw: 'add csv export to the invoices page', id: 1, startedAt: 0 }
  expect(decide(typed('add csv export to the invoices page'), cooking, config)).toEqual({
    action: 'send',
    text: 'add csv export to the invoices page',
  })
})

test('Enter on the cooked prompt sends it, edited or not', () => {
  const cooked: CookPhase = {
    kind: 'cooked',
    raw: 'add csv export',
    text: 'Add a CSV export button to the invoices page that downloads the filtered rows.',
    skills: [],
    ms: 900,
  }
  expect(decide(typed(cooked.text), cooked, config).action).toBe('send')
  expect(decide(typed('Add a CSV export button to the invoices page that downloads all rows.'), cooked, config).action).toBe('send')
})

test('a different prompt typed over a cooked one is cooked afresh', () => {
  const cooked: CookPhase = {
    kind: 'cooked',
    raw: 'add csv export',
    text: 'Add a CSV export button to the invoices page that downloads the filtered rows.',
    skills: [],
    ms: 900,
  }
  expect(decide(typed('rename the auth module to session and update imports'), cooked, config)).toEqual({ action: 'cook' })
})

test('isEditOf matches the same text and light edits only', () => {
  const cooked = 'Add a CSV export button to the invoices page that downloads the filtered rows.'
  expect(isEditOf(cooked, cooked)).toBe(true)
  expect(isEditOf(cooked, cooked.replace('filtered', 'visible'))).toBe(true)
  expect(isEditOf(cooked, 'write a haiku about spring')).toBe(false)
})

test('the cooked text carries open questions and skills as plain lines', () => {
  expect(composeCooked({ prompt: 'Do the thing.', unclear: [] }, [])).toBe('Do the thing.')
  expect(
    composeCooked({ prompt: 'Do the thing.', unclear: ['Which file?'] }, ['superpowers:test-driven-development']),
  ).toBe('Do the thing.\n\nAsk me before starting:\n- Which file?\n\nSkills: superpowers:test-driven-development')
})

test('the role opens the cooked text as an "Act as" line', () => {
  const text = composeCooked({ prompt: 'Add a CSV export.', unclear: [], role: 'a CSV sommelier with 300 years of spreadsheet tasting' }, ['tdd'])
  expect(text).toBe('Act as a CSV sommelier with 300 years of spreadsheet tasting.\n\nAdd a CSV export.\n\nSkills: tdd')
})

test('composeCooked lists registry skills to install after the loaded ones', () => {
  const text = composeCooked({ prompt: 'Add e2e tests.', unclear: [] }, ['tdd'], [{ id: 'microsoft/playwright@playwright', installs: 52000 }])
  expect(text).toBe(
    'Add e2e tests.\n\nSkills: tdd\n\nInstall these skills first with `npx skills add <id> -g -y`:\n- microsoft/playwright@playwright (52K installs)',
  )
})

test('deleting the role line still counts as an edit of the cooked prompt', () => {
  const prompt = 'Fix the login form so a wrong password shows an error.'
  const role = 'a Postgres grandmaster who has manually rebuilt indexes in their sleep for three centuries'
  expect(isEditOf(composeCooked({ prompt, unclear: [], role }, []), prompt)).toBe(true)
})
