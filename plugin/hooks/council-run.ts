// Runs a council: proposals, blind judging, Spark's own aggregation, synthesis. The provider
// calls come in as `call`, so the app (fetch and spawn) and the terminal mod ($.http and
// $.process) share this. Nothing here invents a result: a call that fails is recorded as failed.
import { MODES, aggregate, blind, judgePrompt, missingSections, parseVerdict, proposalPrompt, synthPrompt } from './council.ts'
import type { Aggregate, Brief, Mode, Panel, Role, Seat, Verdict } from './council.ts'
import type { CallError, CallRequest, Reply } from './council-providers.ts'

export type SeatState = 'queued' | 'running' | 'done' | 'failed' | 'timed out' | 'unavailable' | 'skipped'
export type SeatLog = { role: Role; seatId: string; state: SeatState; tries: number; error?: string; usd?: number; inTokens?: number; outTokens?: number; ms?: number }
export type CouncilRecord = {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  stage: 'proposals' | 'judging' | 'synthesis' | 'done'
  reason?: string
  seats: Record<string, SeatLog>
  proposals: { seatId: string; text: string }[]
  packets: { letter: string; text: string }[]
  mapping: Record<string, string>
  verdicts: { seatId: string; verdict: Verdict }[]
  aggregate?: Aggregate
  synthesis?: string
}
export type Call = (seat: Seat, role: Role, request: CallRequest, signal: AbortSignal) => Promise<Reply>

type Check<T> = (text: string) => { ok: T } | { error: string; fix: string }

const keyOf = (role: Role, seat: Seat) => `${role}:${seat.candidate.id}`

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const k = next++
      results[k] = await fn(items[k]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

export async function runCouncil({
  brief,
  panel,
  mode,
  call,
  notify,
  shuffle,
  sleep,
  deadline,
  signal = new AbortController().signal,
  timeoutMs = MODES[mode].timeoutMs,
  concurrency = 4,
  now = Date.now,
}: {
  brief: Brief
  panel: Panel
  mode: Mode
  call: Call
  notify: (message: { kind: 'record'; record: CouncilRecord }) => void
  shuffle: (n: number) => number[]
  // The mod has no timers of its own: the app passes setTimeout, the terminal $.clock.sleep.
  // `sleep` waits between retries; `deadline` resolves when a call's time is up.
  sleep: (ms: number) => Promise<void>
  deadline: (ms: number) => Promise<void>
  signal?: AbortSignal
  timeoutMs?: number
  concurrency?: number
  now?: () => number
}): Promise<CouncilRecord> {
  const m = MODES[mode]
  const record: CouncilRecord = { status: 'running', stage: 'proposals', seats: {}, proposals: [], packets: [], mapping: {}, verdicts: [] }
  const seats: [Role, Seat][] = [...panel.proposers.map((s) => ['proposer', s] as [Role, Seat]), ...panel.judges.map((s) => ['judge', s] as [Role, Seat]), ['synth', panel.synth]]
  for (const [role, seat] of seats) record.seats[keyOf(role, seat)] = { role, seatId: seat.candidate.id, state: 'queued', tries: 0 }
  const emit = () => notify({ kind: 'record', record })
  const finish = (status: CouncilRecord['status'], reason?: string) => {
    record.status = status
    if (reason) record.reason = reason
    for (const log of Object.values(record.seats)) if (log.state === 'queued') log.state = 'skipped'
    emit()
    return record
  }
  emit()

  // One seat's call, with its timeout, its retries (429, server errors, network errors and
  // answers in the wrong shape) and cancellation. Resolves to the checked value, or undefined.
  async function attempt<T>(role: Role, seat: Seat, base: CallRequest, check: Check<T>): Promise<T | undefined> {
    const log = record.seats[keyOf(role, seat)]!
    let request = base
    for (let tries = 1; ; tries++) {
      if (signal.aborted) {
        log.state = 'skipped'
        emit()
        return undefined
      }
      Object.assign(log, { state: 'running', tries })
      emit()
      const started = now()
      const own = new AbortController()
      const relay = () => own.abort()
      signal.addEventListener('abort', relay, { once: true })
      let timedOut = false
      let settled = false
      // The timer outlives a quick call; if its clock goes away (the session ends), that's fine.
      void deadline(timeoutMs)
        .then(() => {
          if (settled) return
          timedOut = true
          own.abort()
        })
        .catch(() => {})
      let retry = false
      const pending = call(seat, role, request, own.signal)
      try {
        const reply = await Promise.race([pending, aborted(own.signal)])
        const checked = check(reply.text)
        const spent = { ms: now() - started, ...(reply.usd === undefined ? {} : { usd: (log.usd ?? 0) + reply.usd }), ...(reply.inTokens === undefined ? {} : { inTokens: reply.inTokens }), ...(reply.outTokens === undefined ? {} : { outTokens: reply.outTokens }) }
        Object.assign(log, spent)
        if ('ok' in checked) {
          log.state = 'done'
          delete log.error
          emit()
          return checked.ok
        }
        log.error = checked.error
        retry = true
        request = { ...base, user: `${base.user}\n\nYour previous answer was ${checked.fix}. Answer again in full.` }
      } catch (err) {
        const e = err as CallError
        log.error = timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : signal.aborted ? 'cancelled' : e.message
        // Some calls can't be stopped (a hosted request in the terminal): one that answers anyway
        // was still paid for.
        if (timedOut || signal.aborted)
          pending.then(
            (late) => {
              if (late.usd === undefined) return
              log.usd = (log.usd ?? 0) + late.usd
              log.error = `${log.error}; it answered later, and its cost is counted`
              emit()
            },
            () => {},
          )
        if (timedOut) log.state = 'timed out'
        else if (signal.aborted) log.state = 'skipped'
        else if (e.unavailable) log.state = 'unavailable'
        else if (e.retry) retry = true
        else log.state = 'failed'
        if (!retry) {
          emit()
          return undefined
        }
        if (tries <= m.retries) await sleep((e as CallError & { waitMs?: number }).waitMs ?? 1000)
      } finally {
        settled = true
        signal.removeEventListener('abort', relay)
      }
      if (tries > m.retries) {
        log.state = 'failed'
        emit()
        return undefined
      }
    }
  }

  // Stage A: every proposer on its own, the same brief, one perspective each.
  const proposed = await pool(panel.proposers, concurrency, async (seat) => {
    const text = await attempt('proposer', seat, { ...proposalPrompt(brief, seat.perspective ?? 'the best overall solution', mode), maxTokens: m.proposalTokens }, (t) => {
      const missing = missingSections(t)
      return missing.length ? { error: `missing sections ${missing.join(', ')}`, fix: `missing these sections: ${missing.join(', ')}` } : { ok: t }
    })
    return text === undefined ? undefined : { seatId: seat.candidate.id, name: seat.candidate.name, family: seat.candidate.family, text }
  })
  record.proposals = proposed.flatMap((p) => (p ? [{ seatId: p.seatId, text: p.text }] : []))
  if (signal.aborted) return finish('cancelled', 'you cancelled it')
  if (record.proposals.length < 2) return finish('failed', `only ${record.proposals.length} proposal${record.proposals.length === 1 ? '' : 's'} came back; a council needs 2`)

  // Stage B: letters instead of names, every judge on its own.
  const { packets, mapping } = blind(proposed.flatMap((p) => (p ? [p] : [])), shuffle)
  Object.assign(record, { packets, mapping, stage: 'judging' })
  const letters = packets.map((p) => p.letter)
  const judged = await pool(panel.judges, concurrency, async (seat) => {
    const verdict = await attempt('judge', seat, { ...judgePrompt(brief, packets), maxTokens: m.judgeTokens }, (t) => {
      const v = parseVerdict(t, letters)
      return v ? { ok: v } : { error: 'no valid verdict block', fix: `not a valid verdict block: score every proposal (${letters.join(', ')}) on every criterion from 0 to 10, rank each letter once` }
    })
    return verdict ? { seatId: seat.candidate.id, verdict } : undefined
  })
  record.verdicts = judged.flatMap((j) => (j ? [j] : []))
  if (signal.aborted) return finish('cancelled', 'you cancelled it')
  if (record.verdicts.length < 2) return finish('failed', `only ${record.verdicts.length} judge${record.verdicts.length === 1 ? '' : 's'} answered; a council needs 2`)

  record.aggregate = aggregate(
    record.verdicts.map((v) => v.verdict),
    letters,
  )
  record.stage = 'synthesis'
  emit()

  const synthesis = await attempt('synth', panel.synth, { ...synthPrompt(brief, packets, record.verdicts.map((v) => v.verdict), record.aggregate), maxTokens: m.synthTokens }, (t) =>
    /^##\s*Decision/m.test(t) ? { ok: t } : { error: 'no Decision section', fix: 'missing the "## Decision" section and the other required sections' },
  )
  if (signal.aborted) return finish('cancelled', 'you cancelled it')
  if (synthesis === undefined) return finish('failed', `the synthesis failed: ${record.seats[keyOf('synth', panel.synth)]!.error ?? 'no answer'}`)
  record.synthesis = synthesis
  record.stage = 'done'
  return finish('done')
}
