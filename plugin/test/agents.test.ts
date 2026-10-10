import { test, expect } from 'claude-code/testing'
import { parseWorktrees, testCommand } from '../hooks/agents'

test('parseWorktrees reads git worktree list --porcelain, main tree first', () => {
  const porcelain = [
    'worktree C:/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/app/.claude/worktrees/agent-1',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/agent-1',
    '',
    'worktree C:/tmp/detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n')
  expect(parseWorktrees(porcelain)).toEqual([
    { path: 'C:/app', head: '1111111111111111111111111111111111111111', branch: 'main' },
    { path: 'C:/app/.claude/worktrees/agent-1', head: '2222222222222222222222222222222222222222', branch: 'agent-1' },
    { path: 'C:/tmp/detached', head: '3333333333333333333333333333333333333333' },
  ])
})

test('testCommand picks the runner from the files at the root, through cmd for .cmd shims', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run' } })
  expect(testCommand(['package.json', 'pnpm-lock.yaml'], pkg)).toEqual(['cmd', '/d', '/c', 'pnpm', 'test'])
  expect(testCommand(['package.json'], pkg)).toEqual(['cmd', '/d', '/c', 'npm', 'test'])
  expect(testCommand(['package.json'], JSON.stringify({ scripts: {} }))).toBeUndefined()
  expect(testCommand(['Cargo.toml'])).toEqual(['cmd', '/d', '/c', 'cargo', 'test'])
  expect(testCommand(['go.mod'])).toEqual(['cmd', '/d', '/c', 'go', 'test', './...'])
  expect(testCommand(['pyproject.toml'])).toEqual(['cmd', '/d', '/c', 'python', '-m', 'pytest'])
  expect(testCommand(['README.md'])).toBeUndefined()
})
