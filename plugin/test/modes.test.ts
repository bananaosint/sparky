import { test, expect } from 'claude-code/testing'
import { toggleMode, modesContext, MODE_NAMES } from '../hooks/modes'

test('the three modes are the ones Spark toggles', () => {
  expect([...MODE_NAMES]).toEqual(['thinking-red-team', 'grillme', 'anti-slop'])
})

test('toggling adds a mode, toggling again removes it', () => {
  expect(toggleMode([], 'grillme')).toEqual(['grillme'])
  expect(toggleMode(['grillme', 'anti-slop'], 'grillme')).toEqual(['anti-slop'])
})

test('no context when no mode is on', () => {
  expect(modesContext([])).toBeUndefined()
})

test('context names the active modes in a spark-modes block', () => {
  expect(modesContext(['thinking-red-team', 'anti-slop'])).toBe(
    '<spark-modes>thinking-red-team, anti-slop</spark-modes>',
  )
})
