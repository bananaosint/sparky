// How Council talks to each provider: request builders and reply parsers, pure. The app sends
// them with fetch and spawn; the terminal mod with $.http and $.process.
import { endpoint } from './gemini.ts'

export type CallRequest = { system: string; user: string; maxTokens: number }
export type Reply = { text: string; usd?: number; inTokens?: number; outTokens?: number }
export type CallError = Error & { status?: number; retry: boolean; unavailable?: boolean }

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const json = (headers: Record<string, string>, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers } as Record<string, string>,
  body: JSON.stringify(body),
})

// 429 and server errors are worth another try; a 404 means the model or the privacy setting
// leaves no endpoint, which no retry fixes.
export function callError(status: number | undefined, message: string): CallError {
  const retry = status === undefined || status === 429 || status >= 500
  return Object.assign(new Error(message), { status, retry, ...(status === 404 ? { unavailable: true } : {}) })
}

export function retryAfterMs(header: string | null | undefined) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(30_000, seconds * 1000) : 5_000
}

const usageOf = (u: Record<string, unknown>, inKey: string, outKey: string) => {
  const out: { inTokens?: number; outTokens?: number } = {}
  const i = num(u[inKey])
  const o = num(u[outKey])
  if (i !== undefined) out.inTokens = i
  if (o !== undefined) out.outTokens = o
  return out
}

// OpenRouter's chat completions. `dataCollection: 'deny'` keeps prompts away from endpoints that
// store or train on them.
export const openrouterRequest = (model: string, r: CallRequest, { key, dataCollection }: { key: string; dataCollection: 'deny' | 'allow' }) => ({
  url: 'https://openrouter.ai/api/v1/chat/completions',
  init: json(
    { authorization: `Bearer ${key}`, 'x-title': 'Spark' },
    {
      model,
      messages: [
        { role: 'system', content: r.system },
        { role: 'user', content: r.user },
      ],
      max_tokens: r.maxTokens,
      provider: { data_collection: dataCollection },
    },
  ),
})

export function parseOpenRouter(body: unknown): Reply {
  const j = obj(body)
  const error = obj(j.error)
  if (typeof error.message === 'string') throw callError(num(error.code), error.message)
  const text = String(obj(obj((j.choices as unknown[] | undefined)?.[0]).message).content ?? '').trim()
  if (!text) throw callError(undefined, 'empty answer')
  const usage = obj(j.usage)
  const usd = num(usage.cost)
  return { text, ...(usd === undefined ? {} : { usd }), ...usageOf(usage, 'prompt_tokens', 'completion_tokens') }
}

export const geminiRequest = (model: string, r: CallRequest, { key }: { key: string }) => ({
  url: endpoint(model),
  init: json(
    { 'x-goog-api-key': key },
    {
      systemInstruction: { parts: [{ text: r.system }] },
      contents: [{ role: 'user', parts: [{ text: r.user }] }],
      generationConfig: { maxOutputTokens: r.maxTokens },
    },
  ),
})

export function parseGemini(body: unknown): Reply {
  const j = obj(body)
  const parts = obj(obj((j.candidates as unknown[] | undefined)?.[0]).content).parts
  const text = Array.isArray(parts)
    ? parts
        .map(obj)
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim()
    : ''
  if (!text) throw callError(undefined, 'empty answer')
  return { text, ...usageOf(obj(j.usageMetadata), 'promptTokenCount', 'candidatesTokenCount') }
}

export const ollamaRequest = (model: string, r: CallRequest) => ({
  url: 'http://127.0.0.1:11434/api/chat',
  init: json(
    {},
    {
      model,
      stream: false,
      messages: [
        { role: 'system', content: r.system },
        { role: 'user', content: r.user },
      ],
      options: { num_ctx: 32768, num_predict: r.maxTokens },
    },
  ),
})

export function parseOllama(body: unknown): Reply {
  const j = obj(body)
  const text = String(obj(j.message).content ?? '').trim()
  if (!text) throw callError(undefined, 'empty answer')
  return { text, usd: 0, ...usageOf(j, 'prompt_eval_count', 'eval_count') }
}

// A one-shot Claude call: no settings sources, no MCP servers, no session. The brief and the
// synthesis may read the project; proposers and judges get no tools at all.
export const claudeArgv = (model: string, system: string, { readOnly }: { readOnly: boolean }) => [
  '-p',
  '--model',
  model,
  '--tools',
  readOnly ? 'Read,Grep,Glob' : '',
  ...(readOnly ? ['--permission-mode', 'plan'] : []),
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--system-prompt',
  system,
  '--output-format',
  'json',
  '--no-session-persistence',
]

// Input tokens count cache reads and writes too: what the model read for this call.
export function parseClaude(body: unknown): Reply {
  const j = obj(body)
  if (j.is_error) throw callError(undefined, String(j.result || 'Claude Code failed').slice(0, 300))
  const text = String(j.result ?? '').trim()
  if (!text) throw callError(undefined, 'empty answer')
  const u = obj(j.usage)
  const inTokens = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0)
  const usd = num(j.total_cost_usd)
  return { text, ...(usd === undefined ? {} : { usd }), inTokens, ...(num(u.output_tokens) === undefined ? {} : { outTokens: num(u.output_tokens) }) }
}
