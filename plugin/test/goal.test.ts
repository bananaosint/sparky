import { test, expect } from 'claude-code/testing'
import { parseGoal, turnTokens, overLimit, budgetLine, DEFAULT_LIMITS } from '../hooks/goal'
import { reviewRequest, parseReview } from '../hooks/gemini'

test('parseGoal reads the goal and optional time and token limits', () => {
  expect(parseGoal('all tests pass')).toEqual({ text: 'all tests pass', limits: DEFAULT_LIMITS })
  expect(parseGoal('"ship the login page" --time 45m --tokens 200k')).toEqual({
    text: 'ship the login page',
    limits: { timeMs: 45 * 60_000, tokens: 200_000 },
  })
  expect(parseGoal('fix it --time 2h --tokens 1m')).toEqual({ text: 'fix it', limits: { timeMs: 7_200_000, tokens: 1_000_000 } })
  expect(parseGoal('fix it --time soon')).toEqual({ error: '--time takes a duration like 45m, 90s or 2h' })
  expect('error' in parseGoal('--tokens 5k')).toBe(true)
  expect(parseGoal('<"a full standalone app"> --time 90m --tokens 2m.  continue')).toEqual({
    text: 'a full standalone app continue',
    limits: { timeMs: 90 * 60_000, tokens: 2_000_000 },
  })
})

test('a turn costs its new tokens, not the cache reads', () => {
  expect(turnTokens({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 9999 } as any)).toBe(60)
})

test('limits end the goal and say which one', () => {
  const limits = { timeMs: 60_000, tokens: 1000 }
  expect(overLimit({ ms: 59_000, tokens: 999 }, limits)).toBeUndefined()
  expect(overLimit({ ms: 60_000, tokens: 0 }, limits)).toBe('time limit reached')
  expect(overLimit({ ms: 0, tokens: 1000 }, limits)).toBe('token limit reached')
  expect(budgetLine({ ms: 12 * 60_000, tokens: 140_000 }, DEFAULT_LIMITS)).toBe('12/30m · 140k/500k tokens')
})

test('the review request carries the goal and the turn summary; parseReview reads the verdict', () => {
  const body = reviewRequest('all tests pass', 'src/a.ts +3 -1\nClaude said: fixed the parser', 'low') as any
  const user: string = body.contents[0].parts[0].text
  expect(user).toContain('<goal>\nall tests pass\n</goal>')
  expect(user).toContain('src/a.ts +3 -1')
  const reply = { candidates: [{ content: { parts: [{ text: '{"met":false,"next":"Run the test suite and fix the failures.","why":"No tests were run."}' }] } }] }
  expect(parseReview(reply)).toEqual({ met: false, next: 'Run the test suite and fix the failures.', why: 'No tests were run.' })
  expect(parseReview({})).toBeUndefined()
})
