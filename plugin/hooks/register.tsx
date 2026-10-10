import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CookPhase, ModeName } from '../types'
import { composeCooked, decide } from './cook'
import {
  MAX_SKILLS,
  endpoint,
  forModel,
  parsePick,
  parseRewrite,
  parseRoute,
  parseSearch,
  pickRequest,
  rewriteRequest,
  routeRequest,
  searchUrl,
} from './gemini'
import type { RemoteSkill, SkillInfo } from './gemini'
import { MISP } from './misp'
import { MODE_DESCRIPTIONS, MODE_NAMES, modesContext, toggleMode } from './modes'
import { redact } from './redact'

const PHASE = { plugin: 'spark', key: 'phase' } as const
const MODES = { plugin: 'spark', key: 'modes' } as const
const KEY = { plugin: 'spark', key: 'geminiKey' } as const

const IDLE: CookPhase = { kind: 'idle' }

// The find-skills bar for a registry skill worth suggesting.
const MIN_INSTALLS = 1000

// Best first, then the ones with the most free daily quota.
const REWRITE_MODELS =
  'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemma-4-31b-it'
const ROUTE_MODELS = 'gemini-3.5-flash-lite,gemini-3.1-flash-lite'

// "✦ spark" in the banner's blue-to-ultraviolet gradient, a color per letter.
const LABEL_COLORS = ['#38BDF8', '#38BDF8', '#4C8EF5', '#6366F1', '#7A5EF3', '#915AF5', '#A855F7']

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
  deadline: number,
): Promise<{ model: string; answer: unknown }> {
  let last: unknown = new Error('no Gemini model to try')
  for (const model of models) {
    const ms = deadline - (await $.clock.now())
    if (ms <= 0) break
    try {
      return { model, answer: await gemini($, key, model, forModel(model, body), ms) }
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === undefined || status === 401 || status === 403) throw err
      last = err
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
// skills.sh and asks Gemini which hits to install. Everything shares the cook's
// deadline, and a failed search keeps the installed picks.
async function routeSkills(
  $: EngineInterface,
  key: string,
  prompt: string,
  skills: readonly SkillInfo[],
  config: Config,
  deadline: number,
): Promise<{ skills: string[]; install: RemoteSkill[] }> {
  if (!skills.length && !config.skillSearch) return { skills: [], install: [] }
  const body = routeRequest(prompt, skills, 'minimal', config.skillSearch)
  const { answer } = await firstAnswer($, key, config.routeModels, body, deadline)
  const route = parseRoute(answer, new Set(skills.map((s) => s.name)))
  const room = Math.min(3, MAX_SKILLS - route.skills.length)
  if (!config.skillSearch || !route.search.length || room <= 0) return { skills: route.skills, install: [] }
  try {
    const candidates = await searchRegistry($, route.search, skills, deadline - (await $.clock.now()))
    if (!candidates.length) return { skills: route.skills, install: [] }
    const ask = pickRequest(prompt, route.skills, candidates, room, 'minimal')
    const picked = parsePick((await firstAnswer($, key, config.routeModels, ask, deadline)).answer, new Set(candidates.map((c) => c.id)), room)
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
    firstAnswer($, key!, config.rewriteModels, rewriteRequest(safe, config.rewriteThinking), startedAt + config.timeoutMs),
    routeSkills($, key!, safe, skills, config, startedAt + config.timeoutMs),
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
  const text = restore(composeCooked(rewrite ?? { prompt: raw, unclear: [] }, picked, install))

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
    await $.command.register({ name: 'thinking-red-team', description: MODE_DESCRIPTIONS['thinking-red-team'] })
    await $.command.register({ name: 'anti-slop', description: MODE_DESCRIPTIONS['anti-slop'] })
    await $.command.register({ name: 'spark-modes', description: 'Spark: show active modes, or "off" to clear them', argumentHint: '[off]' })
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
    if (decision.notice) $.ui.toast(`✦ ${decision.notice}`)
    const modeNote = e.origin.kind === 'composer' ? modesContext(modes) : undefined
    return next({
      ...e,
      text: decision.text,
      ...(modeNote ? { context: [...(e.context ?? []), modeNote] } : {}),
    })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'spark:misp', text: MISP, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [phase = IDLE, modes = [], key] = await Promise.all([read($, PHASE), read($, MODES), read($, KEY)])
    const { Box, Text } = $.ui.resolve(e)

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

    return (
      <Box>
        {[...'✦ spark'].map((ch, i) => (
          <Text color={LABEL_COLORS[i]} bold>
            {ch}
          </Text>
        ))}
        <Text> </Text>
        {status}
        {modes.length ? <Text color="#C084FC"> · modes: {modes.join(', ')}</Text> : null}
      </Box>
    )
  })
}
