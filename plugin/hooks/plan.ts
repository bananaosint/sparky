// A mission's task plan, pure: checked from the draft, laid out in layers, and its tasks' states
// read from Spark's own task records. The app and the mod drive the tasks one turn at a time.
import { redact } from './redact.ts'
import { isCommandHow } from './verify.ts'
import type { CheckResult } from './verify.ts'

export type Task = { id: string; title: string; do: string; after: string[]; check?: string }
export type TaskEvent = 'started' | 'retry' | 'done' | 'failed'
export type FileStat = { path: string; added: number; removed: number }
export type TaskRecord = { at: number; kind: 'task'; id: string; event: TaskEvent; attempt: number; files?: FileStat[]; check?: CheckResult; note?: string }
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'not reached'
export type TaskView = { state: TaskState; attempts: number; files?: FileStat[]; check?: CheckResult; note?: string; from?: number; to?: number }

const MAX_TASKS = 10
const ID = /^[A-Za-z][\w-]{0,19}$/
const clip = (s: string, n: number) => redact(s.trim()).text.slice(0, n)

// One task per element of the block's `tasks`. Fewer than 2 tasks is no plan: the mission runs
// as one piece. A plan that doesn't hold together is dropped whole, with the reason.
export function validatePlan(raw: unknown): { tasks: Task[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 2) return { tasks: [] }
  if (raw.length > MAX_TASKS) return { error: `a plan has at most ${MAX_TASKS} tasks` }
  const tasks: Task[] = []
  for (const item of raw) {
    const x = (item ?? {}) as Record<string, unknown>
    const id = typeof x.id === 'string' ? x.id.trim() : ''
    if (!ID.test(id)) return { error: 'task ids are short words like t1' }
    if (tasks.some((t) => t.id === id)) return { error: `task id ${id} is used twice` }
    const title = typeof x.title === 'string' ? clip(x.title, 80) : ''
    const instructions = typeof x.do === 'string' ? clip(x.do, 2000) : ''
    if (!title || !instructions) return { error: `task ${id} has no title or instructions` }
    const after = Array.isArray(x.after) ? x.after.map(String) : []
    // Only earlier tasks: no cycles can form.
    const missing = after.find((a) => !tasks.some((t) => t.id === a))
    if (missing) return { error: `task ${id} waits for ${missing}, which is not an earlier task` }
    const check = typeof x.check === 'string' && isCommandHow(x.check) ? clip(x.check, 300) : undefined
    tasks.push({ id, title, do: instructions, after: [...new Set(after)], ...(check ? { check } : {}) })
  }
  return { tasks }
}

// The tasks that waited for the removed one wait for what it waited for instead.
export function removeTask(tasks: readonly Task[], id: string): Task[] {
  const gone = tasks.find((t) => t.id === id)
  if (!gone) return [...tasks]
  const order = (ids: string[]) => tasks.filter((t) => ids.includes(t.id)).map((t) => t.id)
  return tasks.filter((t) => t.id !== id).map((t) => (t.after.includes(id) ? { ...t, after: order([...t.after.filter((a) => a !== id), ...gone.after]) } : t))
}

// Layer n holds the tasks whose longest chain of dependencies has length n. Tasks in one layer
// don't wait for each other.
export function layers(tasks: readonly Task[]): string[][] {
  const depth = new Map<string, number>()
  for (const t of tasks) depth.set(t.id, Math.max(-1, ...t.after.map((a) => depth.get(a) ?? 0)) + 1)
  const out: string[][] = []
  for (const t of tasks) (out[depth.get(t.id)!] ??= []).push(t.id)
  return out
}

// `over`: the mission ended, so tasks never started read "not reached" rather than "queued".
export function taskStates(tasks: readonly Task[], records: readonly { kind: string }[], { over }: { over: boolean }): Record<string, TaskView> {
  const views: Record<string, TaskView> = Object.fromEntries(tasks.map((t) => [t.id, { state: over ? 'not reached' : 'queued', attempts: 0 } as TaskView]))
  for (const r of records) {
    if (r.kind !== 'task') continue
    const t = r as TaskRecord
    const v = views[t.id]
    if (!v) continue
    v.attempts = Math.max(v.attempts, Number(t.attempt) || 1)
    if (t.event === 'started') Object.assign(v, { state: 'running', from: t.at })
    if (t.event === 'retry') v.state = 'running'
    if (t.event === 'done' || t.event === 'failed') {
      Object.assign(v, { state: t.event, to: t.at })
      if (t.files) v.files = t.files
      if (t.check) v.check = t.check
      if (t.note) v.note = t.note
    }
  }
  if (over) for (const v of Object.values(views)) if (v.state === 'running') v.state = 'not reached'
  return views
}

// The first task in plan order that hasn't started and whose dependencies are all done.
export function nextTask(tasks: readonly Task[], states: Record<string, TaskView>): Task | undefined {
  if (tasks.some((t) => states[t.id]?.state === 'running' || states[t.id]?.state === 'failed')) return undefined
  return tasks.find((t) => states[t.id]?.state === 'queued' && t.after.every((a) => states[a]?.state === 'done'))
}

// What a task's turn comes to once Spark has run its check. One retry, then the task fails.
export function afterCheck(t: Task, attempt: number, check?: Partial<CheckResult>): { event: 'done' | 'retry' | 'failed'; note?: string } {
  if (!t.check || !check) return { event: 'done', note: "no check: Claude's word" }
  if (check.status === 'pass') return { event: 'done' }
  if (check.status === 'not-run') return { event: 'done', note: `check not run: ${check.reason ?? ''}` }
  return attempt < 2 ? { event: 'retry' } : { event: 'failed', note: `task ${t.id}'s check failed twice` }
}

export const taskText = (t: Task) => `Do only task ${t.id} (${t.title}) now: ${t.do}\n${t.check ? `Its check: ${t.check}. ` : ''}End your turn when it is done.`

export const retryText = (t: Task, check: Partial<CheckResult>) =>
  `Task ${t.id}'s check ${check.status === 'timed-out' ? 'timed out' : `failed${check.exit === undefined ? '' : ` (exit ${check.exit})`}`}:\n\n${check.tail || check.reason || '(no output)'}\n\nFix it, then end your turn.`
