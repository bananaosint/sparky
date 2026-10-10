import { test, expect } from 'claude-code/testing'
import { parseFailure, trimOutput, failurePrompt } from '../hooks/failure'

test('trimOutput strips colors and passing-test lines and keeps the last lines', () => {
  const output = ['\x1b[32m✓ adds\x1b[0m', 'PASS src/a.test.ts', '\x1b[31m✗ subtracts\x1b[0m', 'expected 1, got 2', '', ''].join('\r\n')
  expect(trimOutput(output)).toBe('✗ subtracts\nexpected 1, got 2')
  expect(trimOutput(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), 3)).toBe('line 97\nline 98\nline 99')
})

test('parseFailure accepts a record and rejects anything else', () => {
  const record = { command: 'npm test', cwd: 'C:/app', exitCode: 1, output: 'x', at: 5 }
  expect(parseFailure(JSON.stringify(record))).toEqual(record)
  expect(parseFailure('{"command":"npm test"}')).toBeUndefined()
  expect(parseFailure('not json')).toBeUndefined()
})

test('the failure prompt names the command and exit code and fences the output', () => {
  const text = failurePrompt({ command: 'npm test', cwd: 'C:/app', exitCode: 1, output: '✓ ok 1\n✗ login shows error\nexpected "Wrong password"', at: 5 })
  expect(text).toBe(
    '`npm test` failed with exit code 1 (in C:/app). Find the cause and fix it.\n\nOutput:\n```\n✗ login shows error\nexpected "Wrong password"\n```',
  )
})
