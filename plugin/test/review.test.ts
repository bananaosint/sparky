import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { mergeTargets, parseVerdict } from '../hooks/gate'
import { MISP } from '../hooks/misp'
import { fakeRepo, ran } from './fake'

test('a reviewer verdict is the last line: VERDICT, PASS or FAIL, then the branch', () => {
  expect(parseVerdict('Diff matches the task.\n\nVERDICT: PASS agent-csv\n')).toEqual({ pass: true, branch: 'agent-csv' })
  expect(parseVerdict('Missing tests.\nVERDICT: FAIL agent-csv')).toEqual({ pass: false, branch: 'agent-csv' })
  expect(parseVerdict('VERDICT: PASS agent-csv\nbut one more thing')).toBeUndefined()
  expect(parseVerdict('looks fine')).toBeUndefined()
})

test('merge targets are the refs a git merge or cherry-pick takes in', () => {
  expect(mergeTargets('git merge --no-ff agent-csv && npm test')).toEqual(['agent-csv'])
  expect(mergeTargets('git cherry-pick agent-csv~2')).toEqual(['agent-csv'])
  expect(mergeTargets('git merge --abort')).toEqual([])
  expect(mergeTargets('git log agent-csv')).toEqual([])
  expect(mergeTargets('git -C . merge agent-csv')).toEqual(['agent-csv'])
  expect(mergeTargets('git pull . agent-csv')).toEqual(['agent-csv'])
  expect(mergeTargets('git pull origin main')).toEqual([])
  expect(mergeTargets('git rebase agent-csv')).toEqual(['agent-csv'])
  expect(mergeTargets('git cherry-pick main..agent-csv')).toEqual(['main', 'agent-csv'])
  expect(mergeTargets('git merge refs/heads/agent-csv')).toEqual(['agent-csv'])
})

const PORCELAIN = 'worktree C:/app\nHEAD 1111\nbranch refs/heads/main\n\nworktree C:/app/.claude/worktrees/csv\nHEAD 2222\nbranch refs/heads/agent-csv\n\n'

function merging(on: any) {
  const git = { head: 'aaaa' }
  fakeRepo(on, {}, (argv) =>
    argv.includes('--porcelain') ? ran(PORCELAIN) : argv[1] === 'rev-parse' && /^agent-csv/.test(argv[2] ?? '') ? ran(`${git.head}\n`) : undefined,
  )
  on('tool.check', () => ({ decision: 'ask' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'rev-1' }))
  on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer }))
  return git
}

async function review($: Engine, report: string) {
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Review agent-csv', description: 'review', subagentType: 'spark:compliance-reviewer', provider: { plugin: 'spark', tier: 'plugin' }, parentModel: 'opus' } as any)
  await $.turn.complete({ answer: report, durationMs: 5, isAborted: false, turnId: 'r1', agentId: 'rev-1', reason: 'answer' } as any)
}

const merge = ($: Engine, command = 'git merge --no-ff agent-csv') => $.tool.check({ tool: 'Bash', input: { command } })

test("an agent's branch merges only with a PASS for its current commit", async ($, on) => {
  const git = merging(on)
  expect((await merge($)).decision).toBe('deny')
  await review($, 'All steps tested.\nVERDICT: PASS agent-csv')
  expect(await merge($)).toEqual({ decision: 'ask' })
  git.head = 'bbbb'
  expect(await merge($)).toMatchObject({ decision: 'deny', reason: '✦ spark gate: blocked: merge of agent-csv without a PASS from spark:compliance-reviewer for its current commit' })
})

test('a FAIL blocks the merge; branches outside agent worktrees are not gated', async ($, on) => {
  merging(on)
  await review($, 'No test for the export.\nVERDICT: FAIL agent-csv')
  expect((await merge($)).decision).toBe('deny')
  expect(await merge($, 'git merge feature')).toEqual({ decision: 'ask' })
  // A worktree-* branch is an agent's even after its worktree is gone.
  expect((await merge($, 'git merge worktree-old')).decision).toBe('deny')
  expect(MISP).toContain('Before its branch is merged, run spark:compliance-reviewer on the diff; Spark blocks a merge without a PASS for the branch\'s current commit.')
})
