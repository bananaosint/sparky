// A goal the user set with /goal, and the limits that end it.
export type GoalLimits = { timeMs: number; tokens: number }

export const DEFAULT_LIMITS: GoalLimits = { timeMs: 30 * 60_000, tokens: 500_000 }

const UNITS_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }
const UNITS_TOKENS: Record<string, number> = { '': 1, k: 1000, m: 1_000_000 }

// `/goal all tests pass --time 45m --tokens 200k`: the text, then optional limits.
export function parseGoal(args: string): { text: string; limits: GoalLimits } | { error: string } {
  const limits = { ...DEFAULT_LIMITS }
  const words: string[] = []
  const parts = args.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const flag = parts[i]!
    if (flag !== '--time' && flag !== '--tokens') {
      words.push(flag)
      continue
    }
    const value = (parts[++i] ?? '').toLowerCase()
    const m = flag === '--time' ? /^(\d+(?:\.\d+)?)([smh])$/.exec(value) : /^(\d+(?:\.\d+)?)([km]?)$/.exec(value)
    if (!m) return { error: flag === '--time' ? '--time takes a duration like 45m, 90s or 2h' : '--tokens takes a count like 200k or 1m' }
    if (flag === '--time') limits.timeMs = Number(m[1]) * UNITS_MS[m[2]!]!
    else limits.tokens = Number(m[1]) * UNITS_TOKENS[m[2]!]!
  }
  const text = words.join(' ').replace(/^["']|["']$/g, '')
  return text ? { text, limits } : { error: 'say what the goal is, e.g. /goal all tests pass --time 30m --tokens 500k' }
}

// New tokens a turn cost: what it read uncached, wrote to the cache, and generated.
export const turnTokens = (u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + u.output_tokens + u.cache_creation_input_tokens

export function overLimit(spent: { ms: number; tokens: number }, limits: GoalLimits): string | undefined {
  if (spent.ms >= limits.timeMs) return 'time limit reached'
  if (spent.tokens >= limits.tokens) return 'token limit reached'
  return undefined
}

const short = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export const budgetLine = (spent: { ms: number; tokens: number }, limits: GoalLimits) =>
  `${Math.round(spent.ms / 60_000)}/${Math.round(limits.timeMs / 60_000)}m · ${short(spent.tokens)}/${short(limits.tokens)} tokens`
