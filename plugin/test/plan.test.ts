import { test, expect } from 'claude-code/testing'
import { afterCheck, layers, nextTask, readyTasks, removeTask, retryText, taskStates, taskText, validatePlan } from '../hooks/plan'
import type { Task, TaskRecord } from '../hooks/plan'

const raw = [
  { id: 't1', title: 'Read the auth flow', do: 'Map where logins are checked.', after: [] },
  { id: 't2', title: 'Limiter', do: 'Add a limiter to src/auth.js', after: ['t1'], check: 'npm test -- limiter' },
  { id: 't3', title: 'Message', do: 'Say when to retry', after: ['t1'], check: 'a new test in test/msg.test.js' },
  { id: 't4', title: 'Wire up', do: `Use both. token=ghp_${'c'.repeat(36)}`, after: ['t2', 't3'] },
]

test('a plan is kept when its ids are unique and each task waits only for earlier ones; checks must be commands', () => {
  const plan = validatePlan(raw)
  if (!('tasks' in plan)) throw new Error(plan.error)
  expect(plan.tasks.map((t) => [t.id, t.after, t.check])).toEqual([
    ['t1', [], undefined],
    ['t2', ['t1'], 'npm test -- limiter'],
    ['t3', ['t1'], undefined],
    ['t4', ['t2', 't3'], undefined],
  ])
  expect(plan.tasks[3]!.do).not.toContain('ghp_')
  expect(validatePlan(undefined)).toEqual({ tasks: [] })
  expect(validatePlan([raw[0]])).toEqual({ tasks: [] })
})

test('a plan that does not hold together is dropped with the reason', () => {
  expect(validatePlan([raw[0], { ...raw[1], id: 't1' }])).toEqual({ error: 'task id t1 is used twice' })
  expect(validatePlan([raw[0], { ...raw[1], after: ['t4'] }])).toEqual({ error: 'task t2 waits for t4, which is not an earlier task' })
  expect(validatePlan(Array.from({ length: 11 }, (_, i) => ({ id: `t${i + 1}`, title: 'x', do: 'x', after: [] })))).toEqual({ error: 'a plan has at most 10 tasks' })
  expect(validatePlan([raw[0], { id: '../x', title: 'x', do: 'x', after: [] }])).toEqual({ error: 'task ids are short words like t1' })
  expect(validatePlan([raw[0], { id: 't2', title: '', do: 'x', after: [] }])).toEqual({ error: 'task t2 has no title or instructions' })
})

const tasks = (validatePlan(raw) as { tasks: Task[] }).tasks

test('removing a task hands its dependencies to the tasks that waited for it', () => {
  expect(removeTask(tasks, 't2').map((t) => [t.id, t.after])).toEqual([
    ['t1', []],
    ['t3', ['t1']],
    ['t4', ['t1', 't3']],
  ])
})

test('layers: each task one layer below its longest chain of dependencies', () => {
  expect(layers(tasks)).toEqual([['t1'], ['t2', 't3'], ['t4']])
})

const rec = (at: number, id: string, event: TaskRecord['event'], attempt = 1, more: Partial<TaskRecord> = {}): TaskRecord => ({ at, kind: 'task', id, event, attempt, ...more })

test('task states come from the records; the next task is the first whose dependencies are done', () => {
  const records = [rec(1, 't1', 'started'), rec(2, 't1', 'done', 1, { note: 'no check: Claude\'s word' }), rec(3, 't2', 'started'), rec(4, 't2', 'retry', 2)]
  const states = taskStates(tasks, records, { over: false })
  expect([states.t1!.state, states.t2!.state, states.t2!.attempts, states.t3!.state, states.t4!.state]).toEqual(['done', 'running', 2, 'queued', 'queued'])
  // One task at a time: nothing is next while t2 runs.
  expect(nextTask(tasks, states)).toBeUndefined()
  const done = taskStates(tasks, [...records, rec(5, 't2', 'done', 2)], { over: false })
  expect(nextTask(tasks, done)?.id).toBe('t3')
  const after = taskStates(tasks, [...records, rec(5, 't2', 'done', 2), rec(6, 't3', 'started'), rec(7, 't3', 'done')], { over: false })
  expect(nextTask(tasks, after)?.id).toBe('t4')
  const failed = taskStates(tasks, [...records, rec(5, 't2', 'failed', 2)], { over: true })
  expect([failed.t2!.state, failed.t3!.state, failed.t4!.state]).toEqual(['failed', 'not reached', 'not reached'])
  expect(nextTask(tasks, failed)).toBeUndefined()
})

test('the task and retry messages name the task, and the retry carries the failing tail', () => {
  expect(taskText(tasks[1]!)).toBe('Do only task t2 (Limiter) now: Add a limiter to src/auth.js\nIts check: npm test -- limiter. End your turn when it is done.')
  expect(taskText(tasks[0]!)).toBe('Do only task t1 (Read the auth flow) now: Map where logins are checked.\nEnd your turn when it is done.')
  expect(retryText(tasks[1]!, { name: 'task t2', status: 'fail', exit: 1, tail: 'not ok 1 limiter' })).toBe(
    "Task t2's check failed (exit 1):\n\nnot ok 1 limiter\n\nFix it, then end your turn.",
  )
})

test("after a task's check: pass, no check or a check that didn't run is done; a failure retries once, then fails", () => {
  const [t1, t2] = [tasks[0]!, tasks[1]!]
  expect(afterCheck(t1, 1)).toEqual({ event: 'done', note: "no check: Claude's word" })
  expect(afterCheck(t2, 1, { name: 'task t2', status: 'pass', exit: 0 })).toEqual({ event: 'done' })
  expect(afterCheck(t2, 1, { name: 'task t2', status: 'not-run', reason: 'the folder is untrusted' })).toEqual({ event: 'done', note: 'check not run: the folder is untrusted' })
  expect(afterCheck(t2, 1, { name: 'task t2', status: 'fail', exit: 1 })).toEqual({ event: 'retry' })
  expect(afterCheck(t2, 2, { name: 'task t2', status: 'timed-out' })).toEqual({ event: 'failed', note: "task t2's check failed twice" })
})

test('parallel: every task whose dependencies are done is ready; a stopped or collided task waits to run again', () => {
  const t1done = [rec(1, 't1', 'started'), rec(2, 't1', 'done')]
  expect(readyTasks(tasks, taskStates(tasks, t1done, { over: false })).map((t) => t.id)).toEqual(['t2', 't3'])
  const layer = [...t1done, rec(3, 't2', 'started'), rec(3, 't3', 'started'), rec(4, 't2', 'done'), rec(5, 't3', 'collided', 1, { note: 'collided with t2: src/auth.js' })]
  const states = taskStates(tasks, layer, { over: false })
  expect([states.t3!.state, states.t3!.note]).toEqual(['queued', 'collided with t2: src/auth.js'])
  expect(nextTask(tasks, states)?.id).toBe('t3')
  const stopped = taskStates(tasks, [...t1done, rec(3, 't2', 'started'), rec(4, 't2', 'stopped')], { over: false })
  expect(stopped.t2!.state).toBe('queued')
  expect(readyTasks(tasks, stopped).map((t) => t.id)).toEqual(['t2', 't3'])
})
