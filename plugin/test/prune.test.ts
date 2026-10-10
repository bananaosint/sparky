import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { pruneOutput, readDenied } from '../hooks/prune'
import { MISP } from '../hooks/misp'
import { fakeRepo } from './fake'

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

test('output up to 200 lines is left alone', () => {
  expect(pruneOutput(numbered(200), 'out.txt')).toBeUndefined()
})

test('longer output keeps the first 40 and last 120 lines and says where the rest went', () => {
  const lines = pruneOutput(numbered(500), 'C:/app/.spark/out/t1.txt')!.split('\n')
  expect(lines.length).toBe(161)
  expect(lines[39]).toBe('line 40')
  expect(lines[40]).toBe('[spark: pruned 340 lines → C:/app/.spark/out/t1.txt]')
  expect(lines[41]).toBe('line 381')
  expect(lines.at(-1)).toBe('line 500')
})

test('colors are stripped and carriage-return progress keeps only what was last drawn', () => {
  const noisy = '\x1b[32mok\x1b[0m\n' + 'downloading 10%\rdownloading 50%\rdownloading 100%\n' + numbered(300)
  const pruned = pruneOutput(noisy, 'o.txt')!
  expect(pruned.startsWith('ok\ndownloading 100%\nline 1\n')).toBe(true)
  expect(pruned).not.toContain('\x1b')
})

test('lockfiles, build output, dependencies and minified files are not read', () => {
  for (const p of ['C:\\app\\package-lock.json', 'C:/app/web/yarn.lock', 'C:/app/node_modules/react/index.js', 'C:/app/dist/main.js', 'C:/app/build/out.js', 'C:/app/obj/Debug/x.dll', 'C:/app/public/vendor.min.js', 'C:/app/go.sum'])
    expect(readDenied(p, 'C:/app')).toBeDefined()
  for (const p of ['C:/app/src/build.ts', 'C:/app/bin/spark.js', 'C:/app/package.json', 'C:/app/docs/distribution.md', 'C:/app/src/admin.js', 'C:/app/scripts/build/run.js'])
    expect(readDenied(p, 'C:/app')).toBeUndefined()
})

test('only folders inside the repo count: a repo that lives under a build or dist folder stays readable', () => {
  expect(readDenied('D:\\build\\shop\\src\\cart.js', 'D:/build/shop')).toBeUndefined()
  expect(readDenied('C:/work/dist/shop/src/cart.js', 'C:/work/dist/shop')).toBeUndefined()
  expect(readDenied('src/cart.js', 'D:/build/shop')).toBeUndefined()
  expect(readDenied('D:/build/shop/dist/cart.js', 'D:/build/shop')).toBeDefined()
})

function tools(on: any, stdout: string) {
  on('tool.call', (_$: unknown, e: any) =>
    e.tool === 'Bash' && e.command === 'npm run fail'
      ? { isError: true, result: 'Exit code 1', text: stdout }
      : { result: { stdout, stderr: '', interrupted: false } },
  )
}

test('a long successful command result is pruned and the full output saved under .spark/out', async ($, on) => {
  fakeRepo(on)
  tools(on, numbered(500))
  const written: [string, string][] = []
  on('fs.write', (_$: unknown, e: any) => {
    written.push([e.path, e.text])
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:\\app', surface: 'terminal', isInteractive: true })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'npm ls --all', tool_use_id: 'toolu_01AB' } as any)
  expect(r.result.stdout.split('\n').length).toBe(161)
  expect(r.result.stdout).toContain('[spark: pruned 340 lines → C:/app/.spark/out/toolu_01AB.txt]')
  expect(written).toContainEqual(['C:\\app\\.spark\\out\\toolu_01AB.txt', numbered(500)])
  expect(written).toContainEqual(['C:\\app\\.git\\info\\exclude', '.spark/\n'])
  const failed: any = await $.tool.call({ tool: 'Bash', command: 'npm run fail' } as any)
  expect(failed.text).toBe(numbered(500))
})

test('a Read of a lockfile is refused before it reaches the tool', async ($: Engine, on) => {
  const reached: string[] = []
  on('tool.call', (_$: unknown, e: any) => {
    reached.push(e.file_path)
    return { result: { type: 'text', file: { content: 'x' } } }
  })
  const denied: any = await $.tool.call({ tool: 'Read', file_path: 'C:\\app\\package-lock.json' } as any)
  expect(denied.deny).toContain('package-lock.json')
  await $.tool.call({ tool: 'Read', file_path: 'C:\\app\\src\\a.js' } as any)
  expect(reached).toEqual(['C:\\app\\src\\a.js'])
  expect(MISP).toContain('- Trimmed output: long command output is cut to head and tail with a path to the full log.')
})

