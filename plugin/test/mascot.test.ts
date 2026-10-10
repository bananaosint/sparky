import { test, expect } from 'claude-code/testing'
import { FACES, mood } from '../hooks/mascot'

test('every face is seven single-width cells with the bolts as ears', () => {
  for (const face of Object.values(FACES)) {
    expect([...face].length).toBe(7)
    expect(face.startsWith('ϟ(') && face.endsWith(')ϟ')).toBe(true)
  }
})

test('mood follows the most urgent state', () => {
  const calm = { working: false, cooking: false, cooked: false, failed: false, review: false }
  expect(mood(calm)).toBe('idle')
  expect(mood({ ...calm, cooked: true })).toBe('cooked')
  expect(mood({ ...calm, cooked: true, working: true })).toBe('working')
  expect(mood({ ...calm, working: true, cooking: true })).toBe('cooking')
  expect(mood({ ...calm, working: true, failed: true })).toBe('failed')
  expect(mood({ ...calm, failed: true, review: true })).toBe('review')
})
