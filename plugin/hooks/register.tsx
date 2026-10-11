import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CookPhase, ModeName } from '../types'
import { linkModules, mergeWorktree, parseWorktrees, testCommand, worktreeStamp } from './agents'
import type { Worktree } from './agents'
import { composeCooked, decide } from './cook'
import { designDocName } from './designdoc'
import {
  MAX_SKILLS,
  endpoint,
  forModel,
  parsePick,
  parseReview,
  parseRewrite,
  parseRoute,
  parseSearch,
  pickRequest,
  reviewRequest,
  rewriteRequest,
  routeRequest,
  searchUrl,
} from './gemini'
import type { RemoteSkill, SkillInfo } from './gemini'
import { MISP } from './misp'
import { MODE_DESCRIPTIONS, MODE_NAMES, modesContext, toggleMode } from './modes'
import { failurePrompt, parseFailure, trimOutput } from './failure'
import { budgetLine, overLimit, parseGoal, turnTokens } from './goal'
import { HALT_AFTER, HALT_CONTEXT, HALT_REASON, SPARK_DIR_REASON, editAllowedWhileHalted, inSparkDir, isBuild } from './halt'
import {
  DRAFT_DENIAL,
  DRAFT_DENIED,
  FINAL,
  asMission,
  asRecord,
  criteriaCount,
  draftText,
  move,
  newMission,
  parseGateLines,
  recordsFor,
  runText,
  turnEnded,
  youRecord,
} from './mission'
import type { GateCheck, Mission, MissionRecord } from './mission'
import { buildReport, describe, gitFacts, reportSections } from './mission-report'
import type { Row } from './mission-report'
import { CLAUDE_CANDIDATES, briefPrompt, normalizeGemini, normalizeOllama, normalizeOpenRouter, parseBrief } from './council'
import type { Candidate, Mode } from './council'
import { BRIEF_SYSTEM, councilId, missionPlan, panelOf, preflightRecord, runRefusal } from './council-flow'
import type { Preflight } from './council-flow'
import { callError, claudeArgv, geminiRequest, ollamaRequest, openrouterRequest, parseClaude, parseGemini, parseOllama, parseOpenRouter, retryAfterMs } from './council-providers'
import { runCouncil } from './council-run'
import type { Call, CouncilRecord } from './council-run'
import { pruneOutput, readDenied } from './prune'
import { classify, mergeTargets, parseVerdict, previewArgv } from './gate'
import type { Preview } from './gate'
import { FACES, mood } from './mascot'
import { SPARKY_RGBA } from './sparky-image'
import { redact } from './redact'
import { fileDiffs, listSnapshots, pinSnapshot, restoreSnapshot, takeSnapshot, treeNow } from './snapshot'
import type { FileDiff, Run } from './snapshot'
import { testGate } from './testgate'
import type { GateIo } from './testgate'
import { CHECK_RUNNER, CHECK_TIMED_OUT, changedScripts, configuredFor, planChecks } from './verify'
import type { CheckResult, PlannedCheck } from './verify'

const PHASE = { plugin: 'spark', key: 'phase' } as const
const MODES = { plugin: 'spark', key: 'modes' } as const
const KEY = { plugin: 'spark', key: 'geminiKey' } as const

const IDLE: CookPhase = { kind: 'idle' }

// The find-skills bar for a registry skill worth suggesting.
const MIN_INSTALLS = 1000

// Tries per model, each up to the timeout, before the next model is asked.
const TRIES = 3

// Fast first (about 2 s each when timed on 2026-10-09), then Gemma for its large
// free quota, then 3.7 and 3.8, which took 34 s and 82 s and so rarely fit a try.
const REWRITE_MODELS =
  'gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemma-4-31b-it,gemini-3.7-flash,gemini-3.8-flash'
const ROUTE_MODELS = 'gemini-3.5-flash-lite,gemini-3.1-flash-lite'

// Sparky's face in the banner's blue-to-ultraviolet gradient, a color per cell.
const LABEL_COLORS = ['#38BDF8', '#38BDF8', '#4C8EF5', '#6366F1', '#7A5EF3', '#915AF5', '#A855F7']
const TEAL_LABEL_COLORS = ['#5EEAD4', '#5EEAD4', '#2DD4BF', '#14B8A6', '#22C55E', '#2FE070', '#39FF14']
const ERROR = '#FB7185'

// --plain and NO_COLOR get the plain label instead of a face.
let plainBand = false
// The launcher's theme (spark theme), handed over as SPARK_THEME.
let labelColors = LABEL_COLORS

const models = (list: unknown) =>
  String(list)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)

type Config = {
  rewriteModels: string[]
  rewriteThinking: string
  routeModels: string[]
  skillSearch: boolean
  minWords: number
  timeoutMs: number
}

function within<T>($: EngineInterface, ms: number, work: Promise<T>, what: string): Promise<T> {
  const timeout = $.clock.sleep(ms).then(() => {
    throw new Error(`${what} took longer than ${ms} ms`)
  })
  return Promise.race([work, timeout])
}

function gemini($: EngineInterface, key: string, model: string, body: object, timeoutMs: number): Promise<unknown> {
  const call = $.http
    .fetch(endpoint(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    })
    .then((res) => {
      if (!res.ok) throw Object.assign(new Error(`${model} answered HTTP ${res.status}`), { status: res.status })
      return JSON.parse(res.text) as unknown
    })
  return within($, timeoutMs, call, model)
}

// The first answer from `models`, tried in order. Spent quota, a retired model
// or a server error moves on to the next; a refused key would refuse them all.
async function firstAnswer(
  $: EngineInterface,
  key: string,
  models: readonly string[],
  body: Parameters<typeof forModel>[1],
  timeoutMs: number,
): Promise<{ model: string; answer: unknown }> {
  let last: unknown = new Error('no Gemini model to try')
  for (const model of models) {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      try {
        return { model, answer: await gemini($, key, model, forModel(model, body), timeoutMs) }
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 401 || status === 403) throw err
        last = err
      }
    }
  }
  throw last
}

async function skillsOnOffer($: EngineInterface): Promise<SkillInfo[]> {
  const commands = await $.command.list()
  return commands
    .filter((c) => (c.source === 'user' || c.source === 'plugin') && c.plugin !== 'spark')
    .filter((c) => !(MODE_NAMES as readonly string[]).includes(c.name))
    .map((c) => ({ name: c.name, description: c.description }))
}

// Registry hits for Gemini's queries, in relevance order: popular enough, not
// already installed under the same name, each once.
async function searchRegistry($: EngineInterface, queries: readonly string[], installed: readonly SkillInfo[], ms: number) {
  const search = (q: string) =>
    $.http
      .fetch(searchUrl(q))
      .then((res) => (res.ok ? parseSearch(JSON.parse(res.text)) : []))
      .catch(() => [])
  const pages = await within($, ms, Promise.all(queries.map(search)), 'skills.sh')
  const names = new Set(installed.map((s) => s.name.split(':').pop()))
  const found = new Map<string, RemoteSkill>()
  for (const s of pages.flat()) if (s.installs >= MIN_INSTALLS && !names.has(s.skillId) && !found.has(s.id)) found.set(s.id, s)
  return [...found.values()].slice(0, 12)
}

// Picks installed skills; when Gemini says they miss something, searches
// skills.sh and asks Gemini which hits to install. A failed search keeps the
// installed picks.
async function routeSkills(
  $: EngineInterface,
  key: string,
  prompt: string,
  skills: readonly SkillInfo[],
  config: Config,
): Promise<{ skills: string[]; install: RemoteSkill[] }> {
  if (!skills.length && !config.skillSearch) return { skills: [], install: [] }
  const body = routeRequest(prompt, skills, 'minimal', config.skillSearch)
  const { answer } = await firstAnswer($, key, config.routeModels, body, config.timeoutMs)
  const route = parseRoute(answer, new Set(skills.map((s) => s.name)))
  const room = Math.min(3, MAX_SKILLS - route.skills.length)
  if (!config.skillSearch || !route.search.length || room <= 0) return { skills: route.skills, install: [] }
  try {
    const candidates = await searchRegistry($, route.search, skills, config.timeoutMs)
    if (!candidates.length) return { skills: route.skills, install: [] }
    const ask = pickRequest(prompt, route.skills, candidates, room, 'minimal')
    const picked = parsePick((await firstAnswer($, key, config.routeModels, ask, config.timeoutMs)).answer, new Set(candidates.map((c) => c.id)), room)
    return { skills: route.skills, install: picked.map((id) => candidates.find((c) => c.id === id)!) }
  } catch {
    return { skills: route.skills, install: [] }
  }
}

// Runs after the first Enter was dropped: puts the prompt back in the box,
// asks Gemini, and swaps in the cooked text if the box still holds the prompt.
async function cook($: EngineInterface, raw: string, id: number, config: Config) {
  await $.clock.sleep(30)
  const restored = await $.prompt.fill({ text: raw })
  if (!restored.isFilled) {
    await $.state.set(PHASE, IDLE)
    $.ui.toast('✦ Could not put your prompt back in the box. Press ↑ to recall it.')
    return
  }

  const { value: key } = await $.state.get(KEY)
  const startedAt = await $.clock.now()
  const { text: safe, restore } = redact(raw)
  const skills = await skillsOnOffer($)

  const [rewritten, routed] = await Promise.allSettled([
    firstAnswer($, key!, config.rewriteModels, rewriteRequest(safe, config.rewriteThinking), config.timeoutMs),
    routeSkills($, key!, safe, skills, config),
  ])
  const ms = (await $.clock.now()) - startedAt

  const { value: phase } = await $.state.get(PHASE)
  if (phase?.kind !== 'cooking' || phase.id !== id) return

  const rewrite = rewritten.status === 'fulfilled' ? parseRewrite(rewritten.value.answer) : undefined
  const model = rewrite && rewritten.status === 'fulfilled' ? rewritten.value.model : undefined
  const { skills: picked, install } = routed.status === 'fulfilled' ? routed.value : { skills: [], install: [] }
  const note = rewrite
    ? undefined
    : rewritten.status === 'rejected'
      ? `rewrite failed: ${String(rewritten.reason?.message ?? rewritten.reason)}`
      : 'rewrite came back empty'
  const text = restore(composeCooked(rewrite ? { ...rewrite, by: model } : { prompt: raw, unclear: [] }, picked, install))

  const box = await $.prompt.read()
  if (box.text !== raw) {
    await $.state.set(PHASE, IDLE)
    $.ui.toast('✦ Cooked prompt not placed: the prompt box changed while Gemini worked.')
    return
  }
  await $.prompt.fill({ text })
  await $.state.set(PHASE, {
    kind: 'cooked',
    raw,
    text,
    skills: picked,
    install: install.map((s) => s.id),
    ms,
    ...(model ? { model } : {}),
    ...(note ? { note } : {}),
  })
  if (note) $.ui.toast(`✦ ${note}. Enter sends your prompt as typed.`)
}

// A prompt with an image can't go back into the box without losing the image, so
// Spark asks where it stands: promptify with Gemini, then send Gemini's version or the original.
async function promptify($: EngineInterface, text: string, key: string, config: Config): Promise<string> {
  const choice = await $.ui.ask('Promptify this prompt with Gemini first? The image stays attached.', ['Promptify', 'Send as typed'])
  if (choice !== 'Promptify') return text
  try {
    const { text: safe, restore } = redact(text)
    const { answer, model } = await firstAnswer($, key, config.rewriteModels, rewriteRequest(safe, config.rewriteThinking), config.timeoutMs)
    const rewrite = parseRewrite(answer)
    if (!rewrite) throw new Error('the rewrite came back empty')
    const cooked = restore(composeCooked({ ...rewrite, by: model }, []))
    const pick = await $.ui.ask(`Gemini's version:\n\n${cooked}`, ["Send Gemini's version", 'Send mine as typed'])
    return pick === "Send Gemini's version" ? cooked : text
  } catch (err) {
    $.ui.toast(`✦ Promptify failed (${String((err as Error)?.message ?? err)}). Sending your prompt as typed.`)
    return text
  }
}

async function cookOrGiveUp($: EngineInterface, raw: string, id: number, config: Config) {
  try {
    await cook($, raw, id, config)
  } catch (err) {
    const reason = String((err as Error)?.message ?? err)
    $.ui.toast(`✦ Cooking failed (${reason}). Enter sends your prompt as typed.`)
    // The session may have ended or the module reloaded; then there is no state to fix.
    await $.state.set(PHASE, { kind: 'cooked', raw, text: raw, skills: [], ms: 0, note: reason }).catch(() => {})
  }
}

async function toggle($: EngineInterface, mode: ModeName) {
  const modes = await update($, MODES, (m) => toggleMode(m ?? [], mode))
  return modes.includes(mode) ? `✦ ${mode} on` : `✦ ${mode} off`
}

const SANDBOX = { plugin: 'spark', key: 'sandbox' } as const
const TURN = { plugin: 'spark', key: 'turn' } as const
const REVIEW = { plugin: 'spark', key: 'review' } as const
const FAILURE = { plugin: 'spark', key: 'failure' } as const
const DIFFSTAT = { plugin: 'spark', key: 'diffstat' } as const
const TOUCHED = { plugin: 'spark', key: 'touched' } as const
const GOAL = { plugin: 'spark', key: 'goal' } as const
const STREAK = { plugin: 'spark', key: 'streak' } as const
const HALT = { plugin: 'spark', key: 'halt' } as const
const VERDICTS = { plugin: 'spark', key: 'verdicts' } as const
const MISSION = { plugin: 'spark', key: 'mission' } as const
const OPENROUTER_KEY = { plugin: 'spark', key: 'openrouterKey' } as const

const DIFF_PANE = 'spark:diff'
const AGENTS_PANE = 'spark:agents'
// ui.open ids are letters, digits, _ and - only.
const MISSION_PANE = 'spark-mission'
const COUNCIL_PANE = 'spark-council'
const TONE: Record<Row['tone'], string | undefined> = { ok: '#4ADE80', fail: ERROR, warn: '#FACC15', info: undefined }
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// The pane is for a glance; past this it says how many lines it left out.
const PATCH_LINES = 400
const TICK_MS = 2000
// Each gate dry run gets this long before the raw command is shown instead.
const PREVIEW_MS = 1500
const NOTE: Partial<Record<FileDiff['kind'], string>> = { new: 'new file', deleted: 'deleted', lockfile: 'lockfile, not shown', binary: 'binary' }

const COMMANDS = [
  { name: 'spark-diff', description: 'Spark: show what this turn changed' },
  { name: 'spark-fix', description: 'Spark: send the last failed spark try command to Claude' },
  { name: 'spark-restore', description: 'Spark: list turn snapshots, or restore one by number', argumentHint: '[N]' },
  { name: 'sandbox', description: 'Spark: end each turn with keep or revert' },
  { name: 'spark-agents', description: 'Spark: subagents and worktrees, with test and merge' },
  { name: 'spark-unhalt', description: 'Spark: lift the halt once the post-mortem is written' },
  { name: 'mission', description: 'Spark: work toward criteria you approve, with a recorded report', argumentHint: '<objective> | approve | cancel' },
  { name: 'council', description: 'Spark: several models propose, others judge blind, one synthesizes', argumentHint: '[full] <question> | run | cancel | mission' },
  {
    name: 'goal',
    description: 'Spark: work toward a goal; after each turn Gemini reviews the changes and proposes the next step',
    argumentHint: '<goal> [--time 30m] [--tokens 500k] | stop',
  },
]

const runner =
  ($: EngineInterface): Run =>
  (argv, init) =>
    $.process.run(argv, init)
const message = (err: unknown) => String((err as Error)?.message ?? err)

// Kept in the module, not in state: patches can be large and only the panes read them.
let diffs: FileDiff[] = []
let failureFile: string | undefined
let failureMtime = 0
let inRepo = false
let snapshotWarned = false
// Subagents spawned as spark:compliance-reviewer, by agent id: their reports are verdicts.
const reviewers = new Set<string>()
const tested = new Map<string, { stamp: string; ok: boolean; summary: string } | 'running'>()

async function setDiffs($: EngineInterface, next: FileDiff[]) {
  diffs = next
  const stat = next.length
    ? { files: next.length, added: next.reduce((n, d) => n + d.added, 0), removed: next.reduce((n, d) => n + d.removed, 0) }
    : null
  await $.state.set(DIFFSTAT, stat)
  $.ui.invalidate('ui.render')
}

const openPane = ($: EngineInterface, id: string, title: string) => $.ui.open({ id, title, focus: true, closeOnEscape: true })

async function beginTurn($: EngineInterface, text: string) {
  try {
    const snap = await takeSnapshot(runner($), `before: ${text.replace(/\s+/g, ' ').slice(0, 60)}`)
    await $.state.set(TURN, { n: snap.n, base: snap.sha })
  } catch (err) {
    await $.state.set(TURN, null)
    if (!snapshotWarned) $.ui.toast(`✦ snapshots off: ${message(err)}`)
    snapshotWarned = true
  }
  await $.state.set(REVIEW, null)
  await $.state.set(TOUCHED, [])
  await setDiffs($, [])
}

async function noteEdit($: EngineInterface, file: string) {
  const turn = await read($, TURN)
  if (!turn) return
  const touched = await update($, TOUCHED, (t) => [...new Set([...(t ?? []), file])])
  if (touched.length === 1) await $.ui.open({ id: DIFF_PANE, title: 'diff' })
  await setDiffs($, await fileDiffs(runner($), turn.base, touched))
}

const gateIo = ($: EngineInterface): GateIo => ({
  run: runner($),
  list: async (dir) => (await $.fs.list(dir)).map((f) => f.name),
  read: (path) => $.fs.read(path).catch(() => undefined),
})

// Spark's own config, where per-repo settings live; the repo itself is never asked.
async function sparkConfig($: EngineInterface): Promise<unknown> {
  const appData = await $.env.get('APPDATA')
  if (!appData) return {}
  try {
    return JSON.parse(await $.fs.read(`${appData}/spark/config.json`))
  } catch {
    return {}
  }
}

async function repoTop($: EngineInterface) {
  const r = await runner($)(['git', 'rev-parse', '--show-toplevel']).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : '.'
}

// F10: counts a build or test outcome; true when this failure is the one that halts.
async function countOutcome($: EngineInterface, ok: boolean) {
  if (ok) {
    await $.state.set(STREAK, 0)
    return false
  }
  const streak = await update($, STREAK, (n) => (n ?? 0) + 1)
  if (streak < HALT_AFTER || (await read($, HALT))) return false
  await $.state.set(HALT, { at: await $.clock.now() })
  await recordGate($, 'halt', false).catch(() => {})
  $.ui.toast(HALT_REASON)
  return true
}

// F2: a reviewer's verdict holds for the commit its branch was at when it was given.
async function recordVerdict($: EngineInterface, report: string) {
  const verdict = parseVerdict(report)
  if (!verdict) return
  const head = await runner($)(['git', 'rev-parse', verdict.branch])
  if (head.exitCode !== 0) return
  await update($, VERDICTS, (v) => ({ ...(v ?? {}), [verdict.branch]: { head: head.stdout.trim(), pass: verdict.pass } }))
}

// The agent worktree branch a merge would bring in without a PASS for its current commit, if any.
async function unreviewedMerge($: EngineInterface, command: string) {
  const targets = mergeTargets(command)
  if (!targets.length) return undefined
  const run = runner($)
  const agentBranches = parseWorktrees((await run(['git', 'worktree', 'list', '--porcelain'])).stdout)
    .slice(1)
    .map((w) => w.branch)
  const verdicts = (await read($, VERDICTS)) ?? {}
  for (const target of targets) {
    const branch = target
    // A worktree-* branch is an agent's even after its worktree was removed.
    if (!agentBranches.includes(branch) && !branch.startsWith('worktree-')) continue
    const head = (await run(['git', 'rev-parse', branch])).stdout.trim()
    if (!(verdicts[branch]?.pass && verdicts[branch]!.head === head)) return branch
  }
  return undefined
}

// The dry runs behind a gate question, each within its budget; past it, or on any failure,
// the person sees the raw command instead.
async function previewText($: EngineInterface, previews: readonly Preview[], top: string, command: string) {
  if (!previews.length) return `$ ${command}`
  try {
    const shown: string[] = []
    for (const p of previews) {
      const r = await $.process.run(previewArgv(p), { cwd: top, timeoutMs: PREVIEW_MS })
      shown.push(trimOutput(`${r.stdout}\n${r.stderr}`, 20) || '(nothing)')
    }
    return shown.join('\n')
  } catch {
    return `$ ${command}`
  }
}

// F5: a long successful shell result reaches Claude as head and tail; the whole output is
// saved under .spark/out, which git is told to ignore.
async function pruneShell<R extends { result?: unknown; context?: readonly string[] }>($: EngineInterface, id: string | undefined, result: R) {
  const stdout = (result.result as { stdout?: unknown } | undefined)?.stdout
  if (typeof stdout !== 'string') return undefined
  const saved = `${await repoTop($)}/.spark/out/${(id ?? String(await $.clock.now())).replace(/[^\w-]/g, '_')}.txt`
  const short = pruneOutput(stdout, saved)
  if (!short) return undefined
  await $.fs.write(saved, stdout)
  await ignoreSparkDir($)
  // A fresh result, not a copy: without core's ref, core maps this one for the model.
  return { result: { ...(result.result as object), stdout: short }, ...(result.context ? { context: result.context } : {}) } as unknown as R
}

async function ignoreSparkDir($: EngineInterface) {
  const r = await runner($)(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  if (r.exitCode !== 0) return
  const path = r.stdout.trim()
  const now = await $.fs.read(path).catch(() => '')
  if (now.split(/\r?\n/).includes('.spark/')) return
  await $.fs.write(path, `${now}${now && !now.endsWith('\n') ? '\n' : ''}.spark/\n`)
}

const GATE_LOG = '.spark/gate.jsonl'

// The mod appends by reading a file and writing it back, and Claude Code runs tool calls in
// parallel: every write to .spark/ goes through this one queue so none is lost.
let sparkWrites: Promise<unknown> = Promise.resolve()
function queued<T>(work: () => Promise<T>): Promise<T> {
  const next = sparkWrites.then(work, work)
  sparkWrites = next.catch(() => {})
  return next
}

// F4 and F10 outcomes, one line each in .spark/gate.jsonl at the repo top, for mission reports.
// `tree` is what the check ran on, so a report can tell whether the final code is what passed.
const recordGate = ($: EngineInterface, check: GateCheck, ok: boolean, more: { exit?: number; tree?: string } = {}) =>
  queued(async () => {
    if (!inRepo) return
    const path = `${await repoTop($)}/${GATE_LOG}`
    const tree = more.tree ?? (await treeNow(runner($)).catch(() => undefined))
    const line = JSON.stringify({ at: await $.clock.now(), check, ok, ...(more.exit === undefined ? {} : { exit: more.exit }), ...(tree ? { tree } : {}) })
    const before = await $.fs.read(path).catch(() => '')
    await $.fs.write(path, `${before}${line}\n`)
    await ignoreSparkDir($)
  })

// Terminal missions keep the app's files: .spark/missions/<id>/{mission.json,events.jsonl,report.json}.
const missionFile = (root: string, id: string, name: string) => `${root}/.spark/missions/${id}/${name}`
const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
// After a command the engine clears the box; fill it once that has happened.
const fillLater = ($: EngineInterface, text: string) => void $.clock.sleep(30).then(() => $.prompt.fill({ text })).catch(() => {})

async function loadMission($: EngineInterface, at: { id: string; root: string }) {
  const m = asMission(JSON.parse(await $.fs.read(missionFile(at.root, at.id, 'mission.json'))))
  if (!m || m.id !== at.id) throw new Error('the mission file is unreadable')
  return m
}

async function missionRecords($: EngineInterface, at: { id: string; root: string }) {
  const text = await $.fs.read(missionFile(at.root, at.id, 'events.jsonl')).catch(() => '')
  return text.split('\n').flatMap((line): MissionRecord[] => {
    try {
      const r = asRecord(JSON.parse(line))
      return r ? [r] : []
    } catch {
      return []
    }
  })
}

async function appendEvents($: EngineInterface, root: string, id: string, records: MissionRecord[]) {
  if (!records.length) return
  const path = missionFile(root, id, 'events.jsonl')
  const before = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, before + records.map((r) => `${JSON.stringify(r)}\n`).join(''))
}

async function saveMission($: EngineInterface, root: string, m: Mission, records: MissionRecord[] = []) {
  await $.fs.write(missionFile(root, m.id, 'mission.json'), `${JSON.stringify(m, null, 2)}\n`)
  await appendEvents($, root, m.id, records)
  await $.state.set(MISSION, { id: m.id, root, status: m.status })
  $.ui.invalidate('ui.render')
}

const CHECK_MS = 300_000

// One planned check, through Spark's check runner (verify.ts): cmd gets the command verbatim,
// and past the limit the whole tree ends. Output is redacted before it is kept.
async function runCheck($: EngineInterface, root: string, id: string, check: PlannedCheck, n: number): Promise<CheckResult> {
  const base = { name: check.name, ...(check.criterion === undefined ? {} : { criterion: check.criterion }) }
  if (!check.command) return { ...base, status: 'not-run', reason: check.reason ?? '' }
  const tree = inRepo ? await treeNow(runner($)).catch(() => undefined) : undefined
  const started = await $.clock.now()
  try {
    const r = await $.process.run(['node', '-e', CHECK_RUNNER, '--', check.command, String(CHECK_MS)], { cwd: root, timeoutMs: CHECK_MS + 30_000 })
    const late = r.exitCode === 124 && r.stderr.includes(CHECK_TIMED_OUT)
    const text = redact(`${r.stdout}${r.stderr}`).text
    const log = `${n}.log`
    await $.fs.write(missionFile(root, id, `checks/${log}`), text)
    const ms = (await $.clock.now()) - started
    return {
      ...base,
      command: check.command,
      status: late ? 'timed-out' : r.exitCode === 0 ? 'pass' : 'fail',
      exit: r.exitCode,
      ms,
      ...(tree ? { tree } : {}),
      tail: text.trimEnd().split('\n').slice(-40).join('\n'),
      log,
    }
  } catch (err) {
    return { ...base, command: check.command, status: 'fail', reason: redact(message(err)).text, ms: (await $.clock.now()) - started }
  }
}

// Spark's own checks before a terminal mission's report: the app's plan (verify.ts), one at a
// time. The results come back from memory for the report; only the records go to disk, queued.
async function missionChecks($: EngineInterface, root: string, m: Mission): Promise<{ at: number; again: boolean; checks: CheckResult[] }> {
  const pass = { at: await $.clock.now(), again: false, checks: [] as CheckResult[] }
  try {
    await planAndRun($, root, m, pass)
  } catch (err) {
    $.ui.toast(`✦ Spark's checks could not run: ${message(err)}`)
  }
  return pass
}

async function planAndRun($: EngineInterface, root: string, m: Mission, pass: { at: number; checks: CheckResult[] }) {
  const io = gateIo($)
  const files = await io.list(root)
  const packageJson = files.includes('package.json') ? await io.read(`${root}/package.json`) : undefined
  let changed: string[] | undefined
  if (inRepo && m.startSha) {
    const before = await io.run(['git', 'show', `${m.startSha}:package.json`], { cwd: root })
    changed = changedScripts(before.exitCode === 0 ? before.stdout : '', packageJson ?? '')
  }
  const home = (await $.env.get('USERPROFILE')) ?? ''
  const plan = planChecks({
    files,
    packageJson,
    configured: configuredFor(await sparkConfig($), root),
    criteria: m.criteria,
    trusted: !(await $.env.get('SPARK_UNTRUSTED')),
    changedScripts: changed,
    classify: (command) => classify(command, 'powershell', { repo: root, home }),
  })
  await queued(() => appendEvents($, root, m.id, [{ at: pass.at, kind: 'verify', again: false }]))
  for (const [i, check] of plan.entries()) {
    const result = await runCheck($, root, m.id, check, i + 1)
    pass.checks.push(result)
    await queued(async () => appendEvents($, root, m.id, [{ at: await $.clock.now(), kind: 'check', ...result }]))
  }
}

// Runs outside the write queue, which the mod's other writes (gate records, tool calls) wait on:
// a suite can take minutes. Only its writes are queued. Callers inside the queue don't await it.
async function missionReport($: EngineInterface, root: string, m: Mission) {
  const { mission, facts } = await gitFacts(inRepo ? runner($) : undefined, m, await $.clock.now())
  // A pass whose checks could not run still reads as "Not verified", and the toast says why.
  const pass = mission.status === 'finished' || mission.status === 'blocked' ? await missionChecks($, root, mission) : undefined
  await queued(async () => {
    const report = buildReport(mission, await missionRecords($, { id: m.id, root }), facts, pass)
    await $.fs.write(missionFile(root, m.id, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await saveMission($, root, mission)
  })
  await openPane($, MISSION_PANE, 'mission')
}

async function missionAction($: EngineInterface, at: { id: string; root: string }, action: 'approve' | 'cancel') {
  const m = await loadMission($, at)
  const now = await $.clock.now()
  if (action === 'cancel') {
    if (FINAL.has(m.status)) return `✦ the mission is already ${m.status}`
    const moved = move(m, 'cancelled', 'you cancelled it', now)
    await saveMission($, at.root, moved.mission, [moved.record])
    void missionReport($, at.root, moved.mission).catch(() => {})
    return '✦ mission cancelled'
  }
  if (m.status !== 'review') return `✦ the mission is ${m.status}, not waiting for approval`
  if (!m.criteria.length) return '✦ no criteria came back: /mission cancel and draft again, or edit them in the app'
  const startSha = inRepo ? await pinSnapshot(runner($), `refs/spark/missions/${m.id}/start`, `mission ${m.id} start`).catch(() => undefined) : undefined
  const moved = move(m, 'running', `you approved ${criteriaCount(m.criteria.length)}`, now)
  const running: Mission = { ...moved.mission, approvedAt: now, ...(startSha ? { startSha } : {}) }
  await saveMission($, at.root, running, [moved.record])
  fillLater($, `\\${runText(running)}`)
  return '✦ approved: Enter sends the mission to Claude'
}

// A prompt sent while a mission runs, waits or is paused is yours; one sent to a waiting or
// paused mission sets it running again.
async function missionPrompt($: EngineInterface, text: string) {
  const at = await read($, MISSION)
  if (!at || !text || (at.status !== 'running' && at.status !== 'waiting' && at.status !== 'paused')) return
  const m = await loadMission($, at)
  const now = await $.clock.now()
  const you = youRecord(text, now)
  if (m.status === 'running') return appendEvents($, at.root, m.id, [you])
  const moved = move(m, 'running', m.status === 'waiting' ? 'you answered' : 'you wrote to Claude', now)
  await saveMission($, at.root, moved.mission, [you, moved.record])
}

// Tool calls only add records: rewriting mission.json from here could undo a status a turn end
// wrote in the meantime.
async function missionTool(
  $: EngineInterface,
  at: { id: string; root: string },
  e: { tool: string; tool_use_id?: string },
  result: { isError?: boolean; deny?: string; text?: unknown },
) {
  const now = await $.clock.now()
  const id = e.tool_use_id ?? String(now)
  await appendEvents($, at.root, at.id, [
    ...recordsFor({ kind: 'tool', id, name: e.tool, input: e as unknown as Record<string, unknown> }, now),
    ...recordsFor({ kind: 'tool-result', id, isError: Boolean(result.isError || result.deny), output: String(result.text ?? result.deny ?? '') }, now),
  ])
}

async function missionTurn($: EngineInterface, e: { answer: string; isAborted?: boolean; durationMs?: number }) {
  const at = await read($, MISSION)
  if (!at || (at.status !== 'draft' && at.status !== 'running')) return
  const m = await loadMission($, at)
  const now = await $.clock.now()
  // Esc stopped the turn: nothing finished, so the mission waits for the next prompt.
  if (e.isAborted) {
    const moved = move(m, m.status === 'draft' ? 'interrupted' : 'paused', m.status === 'draft' ? 'you stopped the draft' : 'you stopped the turn', now)
    return saveMission($, at.root, moved.mission, [moved.record])
  }
  const log = await $.fs.read(`${at.root}/${GATE_LOG}`).catch(() => '')
  const done = turnEnded(m, await missionRecords($, at), { ok: true, text: e.answer }, parseGateLines(log.slice(m.gateOffset)), log.length, now)
  await saveMission($, at.root, done.mission, [...recordsFor({ kind: 'result', ok: true, text: e.answer, durationMs: e.durationMs }, now), ...done.records])
  if (done.mission.status === 'review') {
    $.ui.toast(`✦ ${criteriaCount(done.mission.criteria.length)} drafted: /mission shows them, /mission approve starts`)
    await openPane($, MISSION_PANE, 'mission')
  }
  if (FINAL.has(done.mission.status)) void missionReport($, at.root, done.mission).catch(() => {})
}

// ---------- /council in the terminal: the shared steps, with $.http and $.process as the I/O ----------

// The council this session runs, kept in the module: its record can be large, and only the pane reads it.
let councilNow: { record: Preflight & { run?: CouncilRecord; reduced?: boolean }; root: string; controller?: AbortController } | undefined

async function councilKeys($: EngineInterface) {
  return { openrouter: await read($, OPENROUTER_KEY), gemini: await read($, KEY) }
}

// One model call for the orchestrator. Claude proposers and judges need no tools, so they go
// through the session's own client, which Stop cuts. The brief and the synthesis read the project:
// a one-shot `claude -p` with read-only tools, which the mod can't stop (it ends within 10 minutes).
// Hosted requests can't be stopped either; runCouncil counts what they cost if they answer late.
function terminalCall($: EngineInterface, keys: { openrouter?: string; gemini?: string }, cwd: string, dataCollection: 'deny' | 'allow'): Call {
  return async (seat, role, request, signal) => {
    const { id, provider } = seat.candidate
    if (provider === 'claude' && role !== 'brief' && role !== 'synth') {
      const r = await $.model.complete({ model: id, system: request.system, prompt: request.user, maxTokens: Math.min(request.maxTokens, 64_000) }, { signal })
      if (r.isAnswered) {
        const u = r.usage
        return { text: r.text, inTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, outTokens: u.output_tokens }
      }
      throw callError(r.reason === 'api-error' ? (r.status ?? undefined) : undefined, r.reason === 'api-error' ? `API error ${r.status ?? 'with no response'}` : r.reason)
    }
    if (provider === 'claude') {
      const r = await $.process.run(['claude', ...claudeArgv(id, request.system, { readOnly: true })], { cwd, stdin: request.user, timeoutMs: 600_000 })
      let json: unknown
      try {
        json = JSON.parse(r.stdout)
      } catch {
        throw callError(undefined, `claude exited with ${r.exitCode}`)
      }
      return parseClaude(json)
    }
    const { url, init } =
      provider === 'openrouter'
        ? openrouterRequest(id, request, { key: keys.openrouter ?? '', dataCollection })
        : provider === 'gemini'
          ? geminiRequest(id, request, { key: keys.gemini ?? '' })
          : ollamaRequest(id, request)
    const res = await $.http.fetch(url, init).catch((err) => {
      throw callError(undefined, `network: ${message(err)}`)
    })
    let body: unknown = {}
    try {
      body = JSON.parse(res.text)
    } catch {}
    if (!res.ok) {
      const error = (body as { error?: { message?: unknown } }).error?.message
      throw Object.assign(callError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`), { waitMs: retryAfterMs(res.headers['retry-after']) })
    }
    return provider === 'openrouter' ? parseOpenRouter(body) : provider === 'gemini' ? parseGemini(body) : parseOllama(body)
  }
}

// The terminal fetches catalogs each time; the app keeps them for 6 hours.
async function councilCatalogs($: EngineInterface, keys: { openrouter?: string; gemini?: string }) {
  const candidates: Candidate[] = [...CLAUDE_CANDIDATES]
  const notes: string[] = []
  const fetchJson = async (url: string, headers: Record<string, string>) => {
    const res = await $.http.fetch(url, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return JSON.parse(res.text) as unknown
  }
  const sources: [string, string | undefined, () => Promise<unknown>, (j: unknown) => Candidate[]][] = [
    ['openrouter', keys.openrouter, () => fetchJson('https://openrouter.ai/api/v1/models', { authorization: `Bearer ${keys.openrouter}` }), normalizeOpenRouter],
    ['gemini', keys.gemini, () => fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': keys.gemini ?? '' }), normalizeGemini],
  ]
  for (const [name, key, get, normalize] of sources) {
    if (!key) {
      notes.push(`${name}: no key`)
      continue
    }
    try {
      candidates.push(...normalize(await get()))
    } catch (err) {
      notes.push(`${name}: catalog not reachable (${message(err)})`)
    }
  }
  try {
    candidates.push(...normalizeOllama(await fetchJson('http://127.0.0.1:11434/api/tags', {})))
  } catch {
    notes.push('ollama: not running')
  }
  return { candidates, notes }
}

const saveCouncil = ($: EngineInterface, root: string, record: unknown) =>
  queued(async () => {
    const id = (record as { id: string }).id
    await $.fs.write(`${root}/.spark/councils/${id}.json`, `${JSON.stringify(record, null, 2)}\n`)
    if (inRepo) await ignoreSparkDir($)
  })

// Running a council from the pane is the consent it asked for: remembered in Spark's config,
// where the app keeps it too.
async function rememberCouncilConsent($: EngineInterface, providers: readonly string[], dataCollection: 'deny' | 'allow') {
  const appData = await $.env.get('APPDATA')
  if (!appData || !providers.length) return
  const config = ((await sparkConfig($)) ?? {}) as { councilConsent?: Record<string, unknown> }
  const at = await $.clock.now()
  const councilConsent = { ...(config.councilConsent ?? {}), ...Object.fromEntries(providers.map((p) => [p, { at, dataCollection }])) }
  await $.fs.write(`${appData}/spark/config.json`, `${JSON.stringify({ ...config, councilConsent }, null, 2)}\n`)
}

async function councilPreflight($: EngineInterface, question: string, mode: Mode) {
  const root = await repoTop($)
  const keys = await councilKeys($)
  const call = terminalCall($, keys, root, 'deny')
  const sonnet = CLAUDE_CANDIDATES.find((c) => c.id === 'sonnet')!
  const reply = await call({ candidate: sonnet, reason: 'writes the brief' }, 'brief', { system: BRIEF_SYSTEM, user: briefPrompt(question), maxTokens: 6000 }, new AbortController().signal)
  const brief = parseBrief(reply.text)
  if (!brief) throw new Error('the brief came back without a brief block; ask again with a clearer question')
  const { candidates, notes } = await councilCatalogs($, keys)
  const config = ((await sparkConfig($)) ?? {}) as { councilConsent?: Record<string, unknown> }
  const at = await $.clock.now()
  const record = preflightRecord({ id: councilId(at, hex4()), question, mode, at, brief, ...(reply.usd === undefined ? {} : { briefCost: reply.usd }), candidates, notes, consents: config.councilConsent ?? {} })
  councilNow = { record, root }
  await saveCouncil($, root, record)
  $.ui.invalidate('ui.render')
  await openPane($, COUNCIL_PANE, 'council')
}

async function councilRun($: EngineInterface) {
  const c = councilNow
  if (!c || c.record.run) return '✦ no council is waiting to run'
  const config = ((await sparkConfig($)) ?? {}) as { councilConsent?: Record<string, { dataCollection?: string }>; councilBudgetUsd?: unknown }
  const budget = typeof config.councilBudgetUsd === 'number' && config.councilBudgetUsd >= 0 ? config.councilBudgetUsd : 1
  const refusal = runRefusal(c.record, { consent: true, reduced: true }, budget)
  if (refusal) return `✦ ${refusal}`
  const dataCollection = config.councilConsent?.openrouter?.dataCollection === 'allow' ? 'allow' : 'deny'
  await queued(() => rememberCouncilConsent($, c.record.consentNeeded, dataCollection)).catch(() => {})
  const controller = new AbortController()
  c.controller = controller
  c.record = { ...c.record, consentNeeded: [], reduced: c.record.empty.length > 0 }
  const shuffle = (n: number) => {
    const order = [...Array(n).keys()]
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    return order
  }
  const keep = (record: CouncilRecord) => {
    c.record = { ...c.record, run: record }
    $.ui.invalidate('ui.render')
    return saveCouncil($, c.root, c.record).catch(() => {})
  }
  void runCouncil({
    brief: c.record.brief,
    panel: panelOf(c.record),
    mode: c.record.mode,
    call: terminalCall($, await councilKeys($), c.root, dataCollection),
    notify: ({ record }) => void keep(record),
    shuffle,
    sleep: (ms) => $.clock.sleep(ms),
    deadline: (ms) => $.clock.sleep(ms),
    signal: controller.signal,
  })
    .then(keep)
    .catch((err) => $.ui.toast(`✦ council: ${message(err)}`))
  return '✦ council running: the pane shows each model as it answers'
}

async function councilMission($: EngineInterface) {
  const c = councilNow
  if (!c) return '✦ no council in this session'
  const plan = missionPlan(c.record)
  if ('error' in plan) return `✦ ${plan.error}`
  const at = await read($, MISSION)
  if (at && !FINAL.has(at.status)) return `✦ a mission is ${at.status}: /mission cancel ends it first`
  return queued(async () => {
    const root = await repoTop($)
    const gateOffset = (await $.fs.read(`${root}/${GATE_LOG}`).catch(() => '')).length
    const { mission, record } = newMission(plan.objective, await $.clock.now(), hex4(), gateOffset, { criteria: plan.criteria, plan: plan.plan })
    await saveMission($, root, mission, [record])
    return `✦ mission created from the council with ${criteriaCount(mission.criteria.length)}: /mission shows them, /mission approve starts it`
  })
}

const pad = (n: number) => String(n).padStart(2, '0')

// F7: the approved plan goes to docs/design/ at the repo root (the working directory outside a repo).
async function saveDesignDoc($: EngineInterface, plan: string) {
  try {
    const top = await runner($)(['git', 'rev-parse', '--show-toplevel'])
    const dir = top.exitCode === 0 ? `${top.stdout.trim()}/docs/design` : 'docs/design'
    const taken = new Set((await $.fs.list(dir).catch(() => [])).map((f) => f.name))
    const now = new Date(await $.clock.now())
    const name = designDocName(plan, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, taken)
    if (!name) return
    await $.fs.write(`${dir}/${name}`, plan.endsWith('\n') ? plan : `${plan}\n`)
    $.ui.toast(`✦ plan saved to docs/design/${name}`)
  } catch (err) {
    $.ui.toast(`✦ plan not saved: ${message(err)}`)
  }
}

async function endTurn($: EngineInterface) {
  const turn = await read($, TURN)
  if (!turn) return
  await setDiffs($, await fileDiffs(runner($), turn.base))
  if (!diffs.length || !(await read($, SANDBOX))) return
  await $.state.set(REVIEW, turn)
  await $.ui.open({ id: DIFF_PANE, title: 'review' })
}

async function keepTurn($: EngineInterface) {
  await $.state.set(REVIEW, null)
  $.ui.invalidate('ui.render')
}

async function revertTurn($: EngineInterface) {
  const review = await read($, REVIEW)
  if (!review) return
  try {
    const run = runner($)
    const target = (await listSnapshots(run)).find((s) => s.n === review.n)
    if (!target) throw new Error(`snapshot ${review.n} is gone`)
    const undo = await restoreSnapshot(run, target)
    await $.state.set(REVIEW, null)
    await setDiffs($, [])
    $.ui.toast(`✦ reverted the turn. /spark-restore ${undo.n} brings it back.`)
  } catch (err) {
    $.ui.toast(`✦ not reverted: ${message(err)}`)
  }
}

const openDiff = ($: EngineInterface) => openPane($, DIFF_PANE, 'diff')

async function pollFailure($: EngineInterface) {
  if (!failureFile) return
  if (!(await $.fs.exists(failureFile))) {
    if (await read($, FAILURE)) {
      await $.state.set(FAILURE, null)
      $.ui.invalidate('ui.render')
    }
    return
  }
  const { mtimeMs } = await $.fs.stat(failureFile)
  if (mtimeMs === failureMtime) return
  failureMtime = mtimeMs
  const failure = parseFailure(await $.fs.read(failureFile))
  if (!failure) return
  await $.state.set(FAILURE, failure)
  $.ui.invalidate('ui.render')
}

async function attachFailure($: EngineInterface) {
  const failure = await read($, FAILURE)
  if (!failure) return false
  await $.state.set(FAILURE, null)
  $.ui.invalidate('ui.render')
  // After a command the engine clears the box; fill it once that has happened.
  void $.clock
    .sleep(30)
    .then(() => $.prompt.fill({ text: redact(failurePrompt(failure)).text }))
    .catch(async () => {
      await $.state.set(FAILURE, failure)
      $.ui.toast('✦ Could not fill the prompt box. Run /spark-fix again.')
    })
  return true
}

async function dismissFailure($: EngineInterface) {
  await $.state.set(FAILURE, null)
  $.ui.invalidate('ui.render')
}

async function testWorktree($: EngineInterface, main: Worktree, wt: Worktree) {
  tested.set(wt.path, 'running')
  $.ui.invalidate('ui.render')
  const run = runner($)
  try {
    const names = (await $.fs.list(wt.path)).map((f) => f.name)
    const pkg = names.includes('package.json') ? await $.fs.read(`${wt.path}/package.json`) : undefined
    const argv = testCommand(names, pkg)
    if (!argv) throw new Error('no test command found')
    if (pkg !== undefined) await linkModules(run, main.path, wt.path)
    const r = await $.process.run(argv, { cwd: wt.path, timeoutMs: 600_000 })
    const summary = trimOutput(`${r.stdout}\n${r.stderr}`, 1) || `exit ${r.exitCode}`
    tested.set(wt.path, { stamp: await worktreeStamp(run, wt.path), ok: r.exitCode === 0, summary })
  } catch (err) {
    tested.set(wt.path, { stamp: '', ok: false, summary: message(err) })
  }
  $.ui.invalidate('ui.render')
}

async function mergeAgent($: EngineInterface, main: Worktree, wt: Worktree) {
  const run = runner($)
  const name = wt.branch ?? wt.head.slice(0, 7)
  try {
    const t = tested.get(wt.path)
    if (!t || t === 'running' || !t.ok) throw new Error('its tests have not passed')
    if ((await worktreeStamp(run, wt.path)) !== t.stamp) throw new Error('it changed since its tests passed; test again')
    await mergeWorktree(run, main.path, wt, `Agent work from ${name}`)
    tested.delete(wt.path)
    $.ui.toast(`✦ merged ${name}`)
  } catch (err) {
    $.ui.toast(`✦ ${name} not merged: ${message(err)}`)
  }
  $.ui.invalidate('ui.render')
}

const AGENT_MARK: Record<string, [string, string]> = {
  running: ['●', '#38BDF8'],
  pending: ['○', '#94A3B8'],
  waiting: ['…', '#FACC15'],
  completed: ['✓', '#4ADE80'],
  failed: ['✗', '#FB7185'],
}

async function endGoal($: EngineInterface, how: 'met' | 'stopped' | string) {
  const goal = await read($, GOAL)
  if (!goal) return
  await $.state.set(GOAL, null)
  $.ui.toast(how === 'met' ? `✦ goal met in ${goal.step} steps` : `✦ goal ended: ${how}`)
  $.ui.invalidate('ui.render')
}

// After each turn toward a goal: count its tokens, end the goal at a limit, else
// have Gemini compare the turn's changes with the goal and put the next step in the
// prompt box, where Enter sends it as written. The person decides; nothing is sent for them.
async function reviewGoal($: EngineInterface, e: { answer: string; usage?: Parameters<typeof turnTokens>[0] }, config: Config) {
  const goal = await read($, GOAL)
  if (!goal) return
  const tokens = goal.tokens + (e.usage ? turnTokens(e.usage) : 0)
  const spent = { ms: (await $.clock.now()) - goal.startedAt, tokens }
  const over = overLimit(spent, goal.limits)
  if (over) return endGoal($, `${over} (${budgetLine(spent, goal.limits)})`)
  const next = { ...goal, tokens, step: goal.step + 1, review: null }
  const key = await read($, KEY)
  if (!key) {
    await $.state.set(GOAL, next)
    $.ui.invalidate('ui.render')
    return
  }
  const changes = diffs.map((d) => `${d.path} +${d.added} -${d.removed}`).join('\n') || 'no file changes'
  const summary = redact(`${changes}\n\nThe agent's closing message:\n${e.answer.slice(-2000)}`).text
  try {
    const { answer } = await firstAnswer($, key, config.rewriteModels, reviewRequest(goal.text, summary, config.rewriteThinking), config.timeoutMs)
    const review = parseReview(answer)
    if (!review) throw new Error('the review came back empty')
    await $.state.set(GOAL, { ...next, review })
    if (!review.met && review.next) {
      await $.prompt.fill({ text: review.next })
      await $.state.set(PHASE, { kind: 'cooked', raw: review.next, text: review.next, skills: [], ms: 0, note: 'next goal step' })
    }
  } catch (err) {
    await $.state.set(GOAL, next)
    $.ui.toast(`✦ goal review failed (${message(err)}); type the next step yourself`)
  }
  $.ui.invalidate('ui.render')
}

async function startWorkbench($: EngineInterface) {
  // One refusal (Claude Code may have a /goal of its own) mustn't cost the rest of the workbench.
  for (const command of COMMANDS)
    await $.command.register(command).catch((err) => $.ui.toast(`✦ /${command.name} not added: ${message(err)}`))
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'spark-failure.json'])
    inRepo = r.exitCode === 0
    failureFile = inRepo ? r.stdout.trim() : undefined
  } catch {
    inRepo = false
  }
  // Nothing useful to do when a tick fails, and a toast every two seconds would bury the session.
  $.clock.every(TICK_MS, () => {
    void (async () => {
      await pollFailure($)
      if ((await $.ui.panes()).some((p) => p.id === AGENTS_PANE && p.isShown)) $.ui.invalidate('ui.render')
    })().catch(() => {})
  })
}

export const register: Register = (on, options) => {
  const config: Config = {
    rewriteModels: models(options.rewrite_models ?? REWRITE_MODELS),
    rewriteThinking: String(options.rewrite_thinking ?? 'low'),
    routeModels: models(options.route_models ?? ROUTE_MODELS),
    skillSearch: options.skill_search !== false,
    minWords: Number(options.min_words ?? 4),
    timeoutMs: Number(options.timeout_ms ?? 10000),
  }

  on('session.start', async ($, e, next) => {
    // Hand the key from the launcher's environment to session state, then
    // unset it so shell commands Claude runs later don't inherit it.
    const key = await $.env.get('SPARK_GEMINI_KEY')
    if (key) {
      await $.state.set(KEY, key)
      await $.env.set('SPARK_GEMINI_KEY', undefined)
    }
    const openrouter = await $.env.get('SPARK_OPENROUTER_KEY')
    if (openrouter) {
      await $.state.set(OPENROUTER_KEY, openrouter)
      await $.env.set('SPARK_OPENROUTER_KEY', undefined)
    }
    await $.command.register({ name: 'thinking-red-team', description: MODE_DESCRIPTIONS['thinking-red-team'] })
    await $.command.register({ name: 'anti-slop', description: MODE_DESCRIPTIONS['anti-slop'] })
    await $.command.register({ name: 'spark-modes', description: 'Spark: show active modes, or "off" to clear them', argumentHint: '[off]' })
    plainBand = Boolean((await $.env.get('SPARK_PLAIN')) || (await $.env.get('NO_COLOR')))
    labelColors = (await $.env.get('SPARK_THEME')) === 'teal' ? TEAL_LABEL_COLORS : LABEL_COLORS
    await startWorkbench($)
    return next(e)
  })

  on('command.run', { command: 'thinking-red-team' }, async ($) => ({ text: await toggle($, 'thinking-red-team') }))
  on('command.run', { command: 'anti-slop' }, async ($) => ({ text: await toggle($, 'anti-slop') }))
  // grillme is your own skill; Spark toggles the mode and lets the skill run.
  on('command.run', { command: 'grillme' }, async ($, e, next) => {
    $.ui.toast(await toggle($, 'grillme'))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('command.run', { command: 'spark-modes' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'off') {
      await $.state.set(MODES, [])
      return { text: '✦ all modes off' }
    }
    const { value: modes = [] } = await $.state.get(MODES)
    return { text: modes.length ? `✦ modes on: ${modes.join(', ')}` : '✦ no modes on' }
  })

  on('prompt.submit', async ($, e, next) => {
    const [{ value: phase = IDLE }, { value: key }, { value: modes = [] }] = await Promise.all([
      $.state.get(PHASE),
      $.state.get(KEY),
      $.state.get(MODES),
    ])
    const decision = decide(e, phase, { enabled: Boolean(key), minWords: config.minWords })

    if (decision.action === 'cook') {
      const id = await $.clock.now()
      await $.state.set(PHASE, { kind: 'cooking', raw: e.text, id, startedAt: id })
      void cookOrGiveUp($, e.text, id, config)
      return { drop: '✦ cooking with Gemini · Enter again sends it as typed' }
    }

    if (phase.kind !== 'idle') await $.state.set(PHASE, IDLE)
    if (decision.action === 'send' && decision.notice) $.ui.toast(`✦ ${decision.notice}`)
    const text = decision.action === 'offer' ? await promptify($, e.text, key!, config) : decision.text
    const notes = e.origin.kind === 'composer' ? [modesContext(modes), (await read($, HALT)) ? HALT_CONTEXT : undefined].filter((n) => n !== undefined) : []
    return next({
      ...e,
      text,
      ...(notes.length ? { context: [...(e.context ?? []), ...notes] } : {}),
    })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'spark:misp', text: MISP, scope: 'session' as const }] }
  })


  on('turn.start', async ($, e, next) => {
    // A continuation (empty text, as after the test gate's block) is the same piece of work:
    // its snapshot stays, so what the turn changed is still measured from the prompt.
    if (inRepo && !(e.text === '' && (await read($, TURN)))) await beginTurn($, e.text)
    void queued(() => missionPrompt($, e.text)).catch(() => {})
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as { file_path?: unknown; notebook_path?: unknown; command?: unknown }
    const file = input.file_path ?? input.notebook_path
    if (EDIT_TOOLS.has(e.tool) && typeof file === 'string' && inSparkDir(file, await repoTop($))) return { deny: SPARK_DIR_REASON }
    // A draft only reads, subagents included: the terminal has no plan mode behind this.
    const missionAt = await read($, MISSION)
    if (missionAt?.status === 'draft' && DRAFT_DENIED.has(e.tool)) return { deny: DRAFT_DENIAL }
    if (EDIT_TOOLS.has(e.tool) && typeof file === 'string' && (await read($, HALT)) && !editAllowedWhileHalted(file, await repoTop($)))
      return { deny: HALT_REASON }
    const unread = e.tool === 'Read' && typeof file === 'string' ? readDenied(file, await repoTop($)) : undefined
    if (unread) return { deny: unread }
    const result = await next(e)
    const shell = e.tool === 'Bash' || e.tool === 'PowerShell'
    let out = result
    if (shell && !e.agentId && typeof input.command === 'string' && isBuild(input.command) && !result.deny) {
      await recordGate($, 'build', !result.isError).catch(() => {})
      if (await countOutcome($, !result.isError)) out = { ...result, context: [...(result.context ?? []), HALT_REASON] } as typeof result
    }
    // The tool has run: a failure from here on must not lose its result.
    if (shell && result.deny === undefined && !result.isError) out = (await pruneShell($, e.tool_use_id, out).catch(() => undefined)) ?? out
    if (!e.agentId && EDIT_TOOLS.has(e.tool) && typeof file === 'string' && !result.deny && !result.isError) {
      // Off the tool's path: the model shouldn't wait on git.
      void noteEdit($, file).catch(() => {})
    }
    const plan = e.tool === 'ExitPlanMode' && !e.agentId && !result.deny && !result.isError ? (result.result as { plan?: unknown })?.plan : undefined
    if (typeof plan === 'string' && plan.trim()) await saveDesignDoc($, plan)
    if (missionAt && !e.agentId && (missionAt.status === 'draft' || missionAt.status === 'running'))
      await queued(() => missionTool($, missionAt, e, result as { isError?: boolean; deny?: string; text?: unknown })).catch(() => {})
    return out
  })

  // F1: shell commands are classified before they run. The gate only tightens core's verdict:
  // a deny stays a deny, and it never turns an ask into an allow.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const command = (e.input as { command?: unknown } | undefined)?.command
    if (verdict.decision === 'deny' || (e.tool !== 'Bash' && e.tool !== 'PowerShell') || typeof command !== 'string') return verdict
    try {
      const unreviewed = await unreviewedMerge($, command)
      if (unreviewed)
        return { ...verdict, decision: 'deny', reason: `✦ spark gate: blocked: merge of ${unreviewed} without a PASS from spark:compliance-reviewer for its current commit` }
      const top = await repoTop($)
      const branch = /\bpush\b/.test(command) ? (await runner($)(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined))?.stdout.trim() : undefined
      const v = classify(command, e.tool === 'Bash' ? 'bash' : 'powershell', { repo: top, home: (await $.env.get('USERPROFILE')) ?? '', branch })
      if (v?.kind === 'deny') return { ...verdict, decision: 'deny', reason: v.reason }
      if (v?.kind !== 'ask') return verdict
      if (await read($, HALT)) return { ...verdict, decision: 'deny', reason: HALT_REASON }
      return { ...verdict, decision: 'ask', reason: `✦ spark gate: ${v.reason}\n${await previewText($, v.previews, top, command)}` }
    } catch {
      return verdict
    }
  }).catch(($, e, next) => next(e))

  // F4: a turn that changed files can't end on failing tests; the tail goes back to Claude.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    const turn = await read($, TURN)
    if (!turn || (await read($, HALT)) || (await $.env.get('SPARK_NO_TESTS'))) return done
    try {
      const untrusted = Boolean(await $.env.get('SPARK_UNTRUSTED'))
      const gate = await testGate(gateIo($), { base: turn.base, answer: e.last_assistant_message ?? '' }, await sparkConfig($), { untrusted })
      if (gate) await recordGate($, 'tests', gate.ok, gate.ok ? { tree: gate.tree } : { exit: gate.exit, tree: gate.tree }).catch(() => {})
      if (gate && !(await countOutcome($, gate.ok)) && !gate.ok) return { ...done, block: gate.block }
    } catch (err) {
      $.ui.toast(`✦ tests not run: ${message(err)}`)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (e.subagentType === 'spark:compliance-reviewer' && spawned.agentId) reviewers.add(spawned.agentId)
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId && reviewers.has(e.agentId)) await recordVerdict($, e.answer).catch(() => {})
    if (!e.agentId) {
      // The mission's turn end goes first, not behind the goal review's Gemini call.
      void queued(() => missionTurn($, e)).catch(() => {})
      void endTurn($)
        .catch(() => {})
        .then(() => reviewGoal($, e, config))
        .catch(() => {})
    }
    return done
  })

  on('command.run', { command: 'council' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (!args) return { text: '✦ /council [full] <question>; then /council run, /council cancel or /council mission' }
    if (args === 'run') return { text: await councilRun($) }
    if (args === 'mission') return { text: await councilMission($) }
    if (args === 'cancel') {
      if (councilNow?.record.run?.status !== 'running') return { text: '✦ no council is running' }
      councilNow.controller?.abort()
      return { text: "✦ council cancelled; finished answers are kept. Hosted requests and Claude's synthesis can't be stopped from here: if one still answers, its cost is added to the record" }
    }
    if (councilNow?.record.run?.status === 'running') return { text: '✦ a council is running: /council cancel stops it' }
    const full = /^full\b/i.test(args)
    const question = full ? args.slice(4).trim() : args
    if (!question) return { text: '✦ /council [full] <question>' }
    void councilPreflight($, question, full ? 'full' : 'light').catch((err) => $.ui.toast(`✦ council not started: ${message(err)}`))
    return { text: '✦ council: Claude is writing the brief (read-only); the pane shows the panel when it is ready. Nothing leaves this machine until /council run.' }
  })

  on('ui.render', { component: 'Pane', requestId: COUNCIL_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = councilNow?.record
    if (!c) return <Text dimColor>no council in this session</Text>
    const run = c.run
    const seats = [...c.panel.proposers.map((s) => ['proposer', s] as const), ...c.panel.judges.map((s) => ['judge', s] as const), ['synth', c.panel.synth] as const]
    const STATE_TONE: Record<string, string | undefined> = { done: '#4ADE80', failed: ERROR, 'timed out': ERROR, unavailable: '#FACC15', running: '#38BDF8' }
    const a = run?.aggregate
    return (
      <Box flexDirection="column">
        <Text bold>
          council · {c.mode} · {run ? `${run.status}${run.status === 'running' ? ` · ${run.stage}` : ''}` : 'waiting for /council run'}
        </Text>
        <Text>{c.question}</Text>
        <Text dimColor>brief: {c.brief.objective}</Text>
        <Box marginTop={1} flexDirection="column">
          {seats.map(([role, s]) => {
            const log = run?.seats[`${role}:${s.id}`]
            const state = log?.state ?? 'selected'
            return (
              <Text color={STATE_TONE[state]}>{`${role.padEnd(8)} ${s.id} · ${s.estimate.label} · ${state}${log && log.tries > 1 ? ` (${log.tries} tries)` : ''}${log?.error && state !== 'done' ? ` · ${log.error}` : ''}`}</Text>
            )
          })}
        </Box>
        {c.empty.length ? <Text color="#FACC15">{`empty seats: ${c.empty.join(', ')}; /council run uses a reduced panel`}</Text> : null}
        {c.notes.map((n) => (
          <Text dimColor>{n}</Text>
        ))}
        {!run && c.consentNeeded.length ? <Text color="#FACC15">{`/council run sends the brief to ${c.consentNeeded.join(' and ')} (free endpoints may keep prompts); Spark remembers it`}</Text> : null}
        {!run && c.estimate.meteredUsd > 0 ? <Text>{`paid models: ~$${c.estimate.meteredUsd.toFixed(2)} estimated`}</Text> : null}
        {a ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>{`case: ${a.case} · ${a.judged} judges answered`}</Text>
            {a.ranking.map((l) => (
              <Text color={a.flags.some((f) => f.proposal === l) ? ERROR : undefined}>{`${l} ${run!.mapping[l] ?? ''}: mean ${a.mean[l]} · ${a.totals[l]!.join(' / ')} · Borda ${a.borda[l]}${a.flags.filter((f) => f.proposal === l).map((f) => ` · critical: ${f.issue}`).join('')}`}</Text>
            ))}
          </Box>
        ) : null}
        {run?.synthesis ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>synthesis</Text>
            {run.synthesis
              .split('\n')
              .slice(0, 60)
              .map((line) => (
                <Text>{line}</Text>
              ))}
          </Box>
        ) : null}
        {run?.reason ? <Text color="#FACC15">{run.reason}</Text> : null}
        <Box marginTop={1}>
          {!run ? <Button key="council-run" label={c.empty.length ? 'run with a reduced panel' : 'run'} onPress={() => void councilRun($).then((t) => $.ui.toast(t))} /> : null}
          {run?.status === 'running' ? <Button key="council-stop" label="stop" onPress={() => councilNow?.controller?.abort()} /> : null}
          {run?.synthesis ? <Button key="council-mission" label="start as mission" onPress={() => void councilMission($).then((t) => $.ui.toast(t))} /> : null}
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const at = await read($, MISSION)
    try {
      if (!args) {
        if (!at) return { text: '✦ no mission. /mission <what should be true when it is done>' }
        await openPane($, MISSION_PANE, 'mission')
        return { text: '✦ mission pane open' }
      }
      if (args === 'approve' || args === 'cancel') return { text: at ? await queued(() => missionAction($, at, args)) : '✦ no mission' }
      if (at && !FINAL.has(at.status)) return { text: `✦ a mission is ${at.status}: /mission cancel ends it first` }
      const root = await repoTop($)
      await queued(async () => {
        const gateOffset = (await $.fs.read(`${root}/${GATE_LOG}`).catch(() => '')).length
        const { mission, record } = newMission(args, await $.clock.now(), hex4(), gateOffset)
        await saveMission($, root, mission, [record])
        if (inRepo) await ignoreSparkDir($)
      })
      fillLater($, `\\${draftText(args)}`)
      return { text: '✦ mission created: Enter sends the draft request (Claude only reads). Then /mission approve.' }
    } catch (err) {
      return { text: `✦ ${message(err)}` }
    }
  })

  on('command.run', { command: 'sandbox' }, async ($) => {
    const isOn = await update($, SANDBOX, (v) => !v)
    if (!isOn) await $.state.set(REVIEW, null)
    return { text: isOn ? '✦ sandbox on: each turn ends with keep or revert' : '✦ sandbox off' }
  })

  on('command.run', { command: 'spark-unhalt' }, async ($) => {
    const halt = await read($, HALT)
    if (!halt) return { text: '✦ not halted' }
    const written = (await $.fs.list(`${await repoTop($)}/docs/postmortems`).catch(() => [])).some((f) => f.name.endsWith('.md') && f.mtimeMs > halt.at)
    if (!written) return { text: '✦ still halted: write the post-mortem first (/spark:postmortem)' }
    await $.state.set(HALT, null)
    await $.state.set(STREAK, 0)
    return { text: '✦ halt lifted' }
  })

  on('command.run', { command: 'spark-fix' }, async ($) => ({
    text: (await attachFailure($))
      ? '✦ failure attached: edit it, then Enter cooks it'
      : '✦ no failed command to attach. Run it with spark try <command> first.',
  }))

  on('command.run', { command: 'spark-diff' }, async ($) => {
    if (!(await read($, TURN))) return { text: '✦ nothing to diff yet: Spark snapshots each turn in a git repo' }
    await openDiff($)
    return { text: diffs.length ? '✦ diff pane open' : '✦ no changes this turn' }
  })

  on('command.run', { command: 'goal' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const goal = await read($, GOAL)
    if (!args) {
      if (!goal) return { text: '✦ no goal. /goal <what done looks like> [--time 30m] [--tokens 500k]' }
      const spent = { ms: (await $.clock.now()) - goal.startedAt, tokens: goal.tokens }
      return { text: `✦ goal: ${goal.text} · step ${goal.step} · ${budgetLine(spent, goal.limits)}` }
    }
    if (args === 'stop') {
      await endGoal($, 'stopped')
      return { text: goal ? '✦ goal stopped' : '✦ no goal to stop' }
    }
    const parsed = parseGoal(args)
    if ('error' in parsed) return { text: `✦ ${parsed.error}` }
    await $.state.set(GOAL, { text: parsed.text, limits: parsed.limits, startedAt: await $.clock.now(), tokens: 0, step: 1, review: null })
    $.ui.invalidate('ui.render')
    // After a command the engine clears the box; fill it once that has happened.
    void $.clock
      .sleep(30)
      .then(() => $.prompt.fill({ text: parsed.text }))
      .catch(() => {})
    return { text: `✦ goal set (${budgetLine({ ms: 0, tokens: 0 }, parsed.limits)}). Enter starts the first step.` }
  })

  on('command.run', { command: 'spark-agents' }, async ($) => {
    await openPane($, AGENTS_PANE, 'agents')
    return { text: '✦ agents pane open' }
  })

  on('command.run', { command: 'spark-restore' }, async ($, e) => {
    const run = runner($)
    try {
      const snaps = await listSnapshots(run)
      const arg = (e.args ?? '').trim()
      if (!arg) {
        if (!snaps.length) return { text: '✦ no snapshots yet' }
        const now = await $.clock.now()
        const rows = snaps.map((s) => `  ${s.n}  ${Math.round((now - s.at) / 60000)}m ago  ${s.label}`)
        return { text: ['✦ snapshots, newest first (/spark-restore N):', ...rows].join('\n') }
      }
      const target = snaps.find((s) => String(s.n) === arg)
      if (!target) return { text: `✦ no snapshot ${arg}. /spark-restore lists them.` }
      const answer = await $.ui.ask(
        `Restore the working tree to snapshot ${target.n} (${target.label})? Files changed since are overwritten or removed; the current state is snapshotted first.`,
        ['Restore', 'Cancel'],
      )
      if (answer !== 'Restore') return { text: '✦ restore cancelled' }
      const undo = await restoreSnapshot(run, target)
      await $.state.set(REVIEW, null)
      await setDiffs($, [])
      return { text: `✦ restored snapshot ${target.n}. /spark-restore ${undo.n} undoes it.` }
    } catch (err) {
      return { text: `✦ ${message(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const review = await read($, REVIEW)
    let budget = PATCH_LINES
    return (
      <Box flexDirection="column">
        {review ? (
          <Box>
            <Text color="#C084FC">turn {review.n}: keep these changes? </Text>
            <Button key="keep" hotkey="k" label="keep" onPress={() => keepTurn($)} />
            <Text> </Text>
            <Button key="revert" hotkey="r" label="revert" onPress={() => revertTurn($)} />
          </Box>
        ) : null}
        {diffs.length ? null : <Text dimColor>no changes this turn</Text>}
        {diffs.map((d) => {
          const lines = d.patch?.split('\n') ?? []
          const shown = lines.slice(0, Math.max(0, budget))
          budget -= shown.length
          return (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>{d.path}</Text>
                <Text color="#4ADE80"> +{d.added}</Text>
                <Text color="#FB7185"> −{d.removed}</Text>
                {NOTE[d.kind] ? <Text dimColor> {NOTE[d.kind]}</Text> : null}
              </Box>
              {shown.length ? <Code source={shown.join('\n')} format="diff" path={d.path} /> : null}
              {shown.length < lines.length ? <Text dimColor>… {lines.length - shown.length} more lines</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MISSION_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const at = await read($, MISSION)
    if (!at) return <Text dimColor>no mission</Text>
    const m = await loadMission($, at).catch(() => undefined)
    if (!m) return <Text color={ERROR}>the mission file is unreadable</Text>
    const rows = (await missionRecords($, at)).map(describe).filter((r): r is Row => r !== undefined).slice(-30)
    const report = await $.fs
      .read(missionFile(at.root, at.id, 'report.json'))
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => undefined)
    return (
      <Box flexDirection="column">
        <Text bold>{m.title}</Text>
        <Text dimColor>
          {m.status} · {m.reason}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>criteria</Text>
          {m.criteria.length ? null : <Text dimColor>none yet</Text>}
          {m.criteria.map((c, i) => (
            <Text>{`${i + 1}. ${c.text} · ${c.how}`}</Text>
          ))}
        </Box>
        {report
          ? reportSections(report).map((s) => (
              <Box marginTop={1} flexDirection="column">
                <Text bold>{s.heading}</Text>
                {s.lines.length ? s.lines.map((l) => <Text color={l.tone ? TONE[l.tone] : undefined}>{l.text}</Text>) : <Text dimColor>none</Text>}
              </Box>
            ))
          : null}
        <Box marginTop={1} flexDirection="column">
          <Text bold>timeline</Text>
          {rows.map((r) => (
            <Text color={TONE[r.tone]}>{`${r.glyph} ${r.text}`}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [agents, listed] = await Promise.all([$.agent.list(), runner($)(['git', 'worktree', 'list', '--porcelain'])])
    const [main, ...others] = listed.exitCode === 0 ? parseWorktrees(listed.stdout) : []
    // git lists the main tree first, so any other worktree means `main` is set.
    return (
      <Box flexDirection="column">
        <Text bold>agents</Text>
        {agents.length ? null : <Text dimColor>none this session</Text>}
        {agents.map((a) => {
          const [mark, color] = AGENT_MARK[a.status] ?? ['·', '#94A3B8']
          return (
            <Box>
              <Text color={color}>{mark} </Text>
              <Text>{a.description} </Text>
              <Text dimColor>
                {a.type} · {a.status}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text bold>worktrees</Text>
        </Box>
        {others.length ? null : <Text dimColor>none besides the main tree</Text>}
        {others.map((wt) => {
          const t = tested.get(wt.path)
          return (
            <Box>
              <Text>{wt.branch ?? wt.head.slice(0, 7)} </Text>
              <Text dimColor>{wt.path} </Text>
              {t === 'running' ? <Text color="#38BDF8">testing… </Text> : null}
              {t && t !== 'running' ? <Text color={t.ok ? '#4ADE80' : '#FB7185'}>{`${t.ok ? '✓' : '✗'} ${t.summary} `}</Text> : null}
              <Button key={`test:${wt.path}`} label="test" onPress={() => void testWorktree($, main!, wt)} />
              {t && t !== 'running' && t.ok ? (
                <Button key={`merge:${wt.path}`} label="merge" onPress={() => void mergeAgent($, main!, wt)} />
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [phase = IDLE, modes = [], key, failure, review, sandbox, stat, goal] = await Promise.all([
      read($, PHASE),
      read($, MODES),
      read($, KEY),
      read($, FAILURE),
      read($, REVIEW),
      read($, SANDBOX),
      read($, DIFFSTAT),
      read($, GOAL),
    ])
    const now = goal ? await $.clock.now() : 0
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Only the terminal surface draws images.
    const Image = 'Image' in elements && !plainBand ? elements.Image : undefined
    const face = FACES[
      mood({
        working: e.props.isWorking,
        cooking: phase.kind === 'cooking',
        cooked: phase.kind === 'cooked',
        failed: Boolean(failure),
        review: Boolean(review),
      })
    ]

    const status =
      phase.kind === 'cooking' ? (
        <Text color="#38BDF8">cooking with Gemini · Enter sends it as typed</Text>
      ) : phase.kind === 'cooked' ? (
        <Text color="#4ADE80">
          {phase.note ? `not rewritten (${phase.note})` : `cooked in ${(phase.ms / 1000).toFixed(1)}s by ${phase.model}`}
          {phase.skills.length ? ` · skills: ${phase.skills.join(', ')}` : ''}
          {phase.install?.length ? ` · install: ${phase.install.join(', ')}` : ''} · edit freely · Enter sends
        </Text>
      ) : key ? (
        <Text dimColor>Enter cooks · \ at the start sends as typed</Text>
      ) : (
        <Text dimColor>gemini off: run spark key set</Text>
      )

    // A bare digit in the empty composer presses these buttons.
    return (
      <Box flexDirection="column">
        <Box>
          {/* Pixel Sparky where the terminal draws images; nothing extra where it can't. */}
          {Image ? <Image source={{ rgba: SPARKY_RGBA, width: 16, height: 16 }} columns={2} rows={1} alt=" " /> : null}
          {Image ? <Text> </Text> : null}
          {[...(plainBand ? '✦ spark' : face)].map((ch, i) => (
            <Text color={failure ? ERROR : labelColors[i]} bold>
              {ch}
            </Text>
          ))}
          <Text> </Text>
          {status}
          {modes.length ? <Text color="#C084FC"> · modes: {modes.join(', ')}</Text> : null}
          {sandbox ? <Text color="#E879F9"> · sandbox</Text> : null}
          {stat ? <Text dimColor>{` · ${stat.files} files +${stat.added} −${stat.removed}`}</Text> : null}
        </Box>
        {review ? (
          <Box>
            <Text color="#C084FC">turn {review.n} changed {stat?.files ?? 0} files: </Text>
            <Button key="keep" hotkey="1" label="1 keep" onPress={() => keepTurn($)} />
            <Text> </Text>
            <Button key="revert" hotkey="2" label="2 revert" onPress={() => revertTurn($)} />
            <Text> </Text>
            <Button key="diff" hotkey="3" label="3 diff" onPress={() => void openDiff($)} />
          </Box>
        ) : null}
        {goal ? (
          <Box>
            <Text color="#38E8FF">{`◎ goal: ${goal.text} · step ${goal.step} · ${budgetLine({ ms: now - goal.startedAt, tokens: goal.tokens }, goal.limits)} `}</Text>
            {goal.review ? (
              <Text dimColor>{goal.review.met ? `· Gemini thinks it's done: ${goal.review.why} ` : '· next step is in the box, Enter sends it '}</Text>
            ) : null}
            <Button key="goal-met" hotkey="6" label="6 goal met" onPress={() => void endGoal($, 'met')} />
            <Text> </Text>
            <Button key="goal-stop" hotkey="7" label="7 stop" onPress={() => void endGoal($, 'stopped')} />
          </Box>
        ) : null}
        {failure ? (
          <Box>
            <Text color={ERROR}>{`✗ ${failure.command} failed (exit ${failure.exitCode}) `}</Text>
            <Button key="fix" hotkey="4" label="4 send to Claude" onPress={() => void attachFailure($)} />
            <Text> </Text>
            <Button key="dismiss" hotkey="5" label="5 dismiss" onPress={() => dismissFailure($)} />
          </Box>
        ) : null}
      </Box>
    )
  })
}
