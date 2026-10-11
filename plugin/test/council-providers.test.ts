import { test, expect } from 'claude-code/testing'
import { callError, claudeArgv, geminiRequest, ollamaRequest, openrouterRequest, parseClaude, parseGemini, parseOllama, parseOpenRouter, retryAfterMs } from '../hooks/council-providers'

const req = { system: 'be a judge', user: 'the brief', maxTokens: 2500 }

test('openrouter: bearer key, both messages, max_tokens and the data-collection choice; usage.cost read as dollars', () => {
  const { url, init } = openrouterRequest('deepseek/deepseek-r2:free', req, { key: 'sk-or-1', dataCollection: 'deny' })
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(init.headers.authorization).toBe('Bearer sk-or-1')
  expect(JSON.parse(init.body)).toEqual({
    model: 'deepseek/deepseek-r2:free',
    messages: [
      { role: 'system', content: 'be a judge' },
      { role: 'user', content: 'the brief' },
    ],
    max_tokens: 2500,
    provider: { data_collection: 'deny' },
  })
  expect(parseOpenRouter({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0012 } })).toEqual({ text: 'hello', usd: 0.0012, inTokens: 10, outTokens: 4 })
  expect(() => parseOpenRouter({ choices: [{ message: { content: '' } }] })).toThrow('empty answer')
  expect(() => parseOpenRouter({ error: { code: 429, message: 'rate limited' } })).toThrow('rate limited')
})

test('gemini: key in a header, system and token cap in the body; no cost reported', () => {
  const { url, init } = geminiRequest('gemini-3.5-flash', req, { key: 'AIza-x' })
  expect(url).toContain('/models/gemini-3.5-flash:generateContent')
  expect(init.headers['x-goog-api-key']).toBe('AIza-x')
  const body = JSON.parse(init.body)
  expect(body.systemInstruction.parts[0].text).toBe('be a judge')
  // Thinking tokens count against the cap: a live run showed Gemma spending all of it on thought.
  expect(body.generationConfig.maxOutputTokens).toBe(2500 + 8192)
  expect(() => parseGemini({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'thinking', thought: true }] } }] })).toThrow('empty answer (MAX_TOKENS)')
  expect(parseGemini({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'answer' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } })).toEqual({ text: 'answer', inTokens: 9, outTokens: 3 })
})

test('ollama: local chat with a 32k context and the token cap', () => {
  const { url, init } = ollamaRequest('qwen3:32b', req)
  expect(url).toBe('http://127.0.0.1:11434/api/chat')
  expect(JSON.parse(init.body)).toMatchObject({ model: 'qwen3:32b', stream: false, options: { num_ctx: 32768, num_predict: 2500 } })
  expect(parseOllama({ message: { content: 'local answer' }, prompt_eval_count: 7, eval_count: 2 })).toEqual({ text: 'local answer', usd: 0, inTokens: 7, outTokens: 2 })
})

test('claude: settings and MCP always off; read-only tools in plan mode only when asked', () => {
  const plain = claudeArgv('sonnet', 'sys', { readOnly: false })
  expect(plain).toEqual(['-p', '--model', 'sonnet', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--system-prompt', 'sys', '--output-format', 'json', '--no-session-persistence'])
  const reading = claudeArgv('fable', 'sys', { readOnly: true })
  expect(reading.slice(3, 7)).toEqual(['--tools', 'Read,Grep,Glob', '--permission-mode', 'plan'])
  expect(parseClaude({ result: 'done', is_error: false, total_cost_usd: 0.03, usage: { input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 50 } })).toEqual({ text: 'done', usd: 0.03, inTokens: 114, outTokens: 50 })
  expect(() => parseClaude({ is_error: true, result: 'Credit balance too low' })).toThrow('Credit balance too low')
})

test('errors carry their status; 429 and 5xx retry, 404 is unavailable; Retry-After is capped at 30 s', () => {
  expect(callError(429, 'slow down')).toMatchObject({ status: 429, retry: true })
  expect(callError(503, 'busy')).toMatchObject({ retry: true })
  expect(callError(404, 'No endpoints found matching your data policy')).toMatchObject({ retry: false, unavailable: true })
  expect(retryAfterMs('12')).toBe(12_000)
  expect(retryAfterMs('600')).toBe(30_000)
  expect(retryAfterMs(null)).toBe(5_000)
})
