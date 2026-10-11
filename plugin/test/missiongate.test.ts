import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { isBuild } from '../hooks/halt'
import { fakeRepo, startTurn, stop } from './fake'

function capture(on: any) {
  const written = new Map<string, string>()
  on('fs.write', (_$: unknown, e: any) => {
    written.set(String(e.path).replace(/\//g, '\\'), e.text)
    return { value: undefined }
  })
  const gate = () => (written.get('C:\\app\\.spark\\gate.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { written, gate }
}

function tools(on: any) {
  on('tool.call', (_$: unknown, e: any) =>
    e.tool === 'Bash' && isBuild(e.command) ? { isError: true, result: 'Exit code 2', text: 'Exit code 2' } : { result: { stdout: '', stderr: '', interrupted: false } },
  )
}

test('each test-gate run goes to .spark/gate.jsonl with the tree it saw, and a halt adds its own line', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate, written } = capture(on)
  await startTurn($)
  await stop($)
  await stop($)
  // fakeRepo's fs.read refuses everything but package.json, so each write starts the file over:
  // the last write holds the halt alone, and the second run's line came just before it.
  expect(gate().map((l) => [l.check, l.ok, l.tree])).toEqual([['halt', false, 'tree1']])
  expect(written.get('C:\\app\\.git\\info\\exclude')).toBe('.spark/\n')
})

test('a failing test run is written with its exit code', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate } = capture(on)
  await startTurn($)
  await stop($)
  const [line] = gate()
  expect([line.check, line.ok, line.exit, line.tree, typeof line.at]).toEqual(['tests', false, 1, 'tree1', 'number'])
})

test('a counted build is written too', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  const { gate } = capture(on)
  await startTurn($)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as any)
  expect(gate().map((l) => [l.check, l.ok])).toEqual([['build', false]])
})

test('Claude never edits .spark/', async ($: Engine, on) => {
  fakeRepo(on)
  tools(on)
  await startTurn($)
  const denied: any = await $.tool.call({ tool: 'Write', file_path: 'C:\\app\\.spark\\gate.jsonl', content: '{}' } as any)
  expect(denied.deny).toBe("✦ .spark/ holds Spark's own records; it isn't edited")
  const sneaky: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/app/src/../.spark/missions/x/mission.json', old_string: 'a', new_string: 'b' } as any)
  expect(sneaky.deny).toBeDefined()
})
