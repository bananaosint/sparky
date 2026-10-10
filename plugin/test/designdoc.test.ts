import { test, expect, mock } from 'claude-code/testing'
import { designDocName } from '../hooks/designdoc'
import { MISP } from '../hooks/misp'

const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('an approved plan is saved to docs/design at the repo root; a rejected one is not', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 10, 17) })
  on('process.run', (_$, e) => (e.argv.includes('--show-toplevel') ? ran('C:/code/app\n') : ran('', 128)))
  on('fs.list', () => ({ value: [{ name: '2026-10-10--add-csv-export--design.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  const written: [string, string][] = []
  on('fs.write', (_$, e) => {
    written.push([e.path, e.text])
    return { value: undefined }
  })
  let answer: any = { result: { plan: '# Add CSV export\n\n1. Test first', isAgent: false } }
  on('tool.call', () => answer)

  await $.tool.call({ tool: 'ExitPlanMode' } as any)
  expect(written).toEqual([['C:\\code\\app\\docs\\design\\2026-10-10--add-csv-export-2--design.md', '# Add CSV export\n\n1. Test first\n']])

  for (answer of [{ deny: 'The user chose to keep planning' }, { isError: true, result: undefined, text: 'rejected' }, { result: { plan: null, isAgent: false } }])
    await $.tool.call({ tool: 'ExitPlanMode' } as any)
  expect(written.length).toBe(1)
})

const none = new Set<string>()

test('an approved plan is named after its first heading and the day', () => {
  expect(designDocName('# Add CSV export\n\nSteps…', '2026-10-10', none)).toBe('2026-10-10--add-csv-export--design.md')
  expect(designDocName('Intro text\n## Plan: Cache the API (v2)!\nmore', '2026-10-10', none)).toBe('2026-10-10--plan-cache-the-api-v2--design.md')
})

test('without a heading the first non-empty line names it', () => {
  expect(designDocName('\n\n  Fix the login redirect loop.\nDetails', '2026-10-10', none)).toBe('2026-10-10--fix-the-login-redirect-loop--design.md')
})

test('same-day collisions get -2, then -3', () => {
  const taken = new Set(['2026-10-10--add-csv-export--design.md'])
  expect(designDocName('# Add CSV export', '2026-10-10', taken)).toBe('2026-10-10--add-csv-export-2--design.md')
  taken.add('2026-10-10--add-csv-export-2--design.md')
  expect(designDocName('# Add CSV export', '2026-10-10', taken)).toBe('2026-10-10--add-csv-export-3--design.md')
})

test('long titles are cut on a word, a title with no letters still gets a name, a blank plan gets none', () => {
  const name = designDocName(`# ${'word '.repeat(40)}`, '2026-10-10', none)!
  expect(name).toMatch(/^2026-10-10--(word-)*word--design\.md$/)
  expect(name.length).toBeLessThanOrEqual('2026-10-10----design.md'.length + 60)
  expect(designDocName('# !!!', '2026-10-10', none)).toBe('2026-10-10--plan--design.md')
  expect(designDocName('  \n ', '2026-10-10', none)).toBeUndefined()
})

test('the rules tell Claude where approved plans go', () => {
  expect(MISP).toContain('Spark saves the approved plan to docs/design/.')
})
