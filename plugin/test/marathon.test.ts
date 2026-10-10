import { test, expect } from 'claude-code/testing'
import { MISP } from '../hooks/misp'

test('the rules explain the work-session block', () => {
  expect(MISP).toContain('## Work sessions')
  expect(MISP).toContain('<spark-session> after a prompt means the user set a work session with a time and token budget.')
  expect(MISP).toContain("Spark sends the next pass when you finish, until a budget runs out. Don't wind down or write a long summary.")
  expect(MISP).toContain('If you find nothing, reply "Nothing found." and stop.')
})
