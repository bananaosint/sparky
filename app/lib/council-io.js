// Council's I/O in the app: provider catalogs (kept 6 hours), calls over fetch, Claude one-shots
// over spawn (tracked so ■ can stop them), and OpenRouter's free requests left today.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CLAUDE_CANDIDATES, normalizeGemini, normalizeOllama, normalizeOpenRouter } from '../staged/plugin/hooks/council.ts';
import {
  callError,
  claudeArgv,
  geminiRequest,
  ollamaRequest,
  openrouterRequest,
  parseClaude,
  parseGemini,
  parseOllama,
  parseOpenRouter,
  retryAfterMs,
} from '../staged/plugin/hooks/council-providers.ts';

const KEEP_MS = 6 * 3600_000;
const ago = (ms) => (ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3600_000)} h`);

// `keys`: { openrouter?, gemini? }. `cwd`: the project (the brief and synthesis read it).
// `scratch`: an empty folder for proposers and judges, so no project file reaches them.
export function createCouncilIo({ fetchImpl = fetch, spawn, keys, cwd, scratch, env, cachePath, now = Date.now, dataCollection = 'deny' }) {
  const children = new Set();

  async function getJson(url, headers, timeoutMs = 15_000) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw callError(res.status, `HTTP ${res.status}`);
    return res.json();
  }

  const readCache = () => {
    try {
      return existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
    } catch {
      return {};
    }
  };

  // Hosted catalogs come from the cache while fresh; a failed fetch falls back to the kept copy
  // and says how old it is. Ollama is asked every time: it is local, and off more often than on.
  async function catalogs() {
    const cache = readCache();
    const candidates = [...CLAUDE_CANDIDATES];
    const notes = [];
    const hosted = [
      ['openrouter', keys.openrouter, () => getJson('https://openrouter.ai/api/v1/models', { authorization: `Bearer ${keys.openrouter}` }), normalizeOpenRouter],
      ['gemini', keys.gemini, () => getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': keys.gemini }), normalizeGemini],
    ];
    for (const [name, key, fetchIt, normalize] of hosted) {
      if (!key) {
        notes.push(`${name}: no key`);
        continue;
      }
      const kept = cache[name];
      if (kept && now() - kept.at < KEEP_MS) {
        candidates.push(...normalize(kept.json));
        continue;
      }
      try {
        const json = await fetchIt();
        cache[name] = { at: now(), json };
        candidates.push(...normalize(json));
      } catch (err) {
        if (!kept) {
          notes.push(`${name}: catalog not reachable (${err.message})`);
          continue;
        }
        notes.push(`${name}: catalog fetch failed (${err.message}); using the copy from ${ago(now() - kept.at)} ago`);
        candidates.push(...normalize(kept.json));
      }
    }
    try {
      candidates.push(...normalizeOllama(await getJson('http://127.0.0.1:11434/api/tags', {}, 1500)));
    } catch {
      notes.push('ollama: not running');
    }
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
    return { candidates, notes };
  }

  function runClaude(model, request, readOnly, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', claudeArgv(model, request.system, { readOnly }), { cwd: readOnly ? cwd : scratch, env, windowsHide: true });
      children.add(child);
      const stop = () => child.kill();
      signal.addEventListener('abort', stop, { once: true });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', (err) => reject(callError(undefined, err.message)));
      child.on('close', (code) => {
        children.delete(child);
        signal.removeEventListener('abort', stop);
        if (signal.aborted || child.killed) return reject(new Error('stopped'));
        let json;
        try {
          json = JSON.parse(out);
        } catch {
          return reject(callError(undefined, `claude exited with ${code}`));
        }
        try {
          resolve(parseClaude(json));
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.end(request.user);
    });
  }

  const PARSE = { openrouter: parseOpenRouter, gemini: parseGemini, ollama: parseOllama };

  // One model call for the orchestrator (council-run.ts `Call`). The brief and the synthesis may
  // read the project; everyone else answers from the brief alone.
  async function call(seat, role, request, signal) {
    const { id, provider } = seat.candidate;
    if (provider === 'claude') return runClaude(id, request, role === 'brief' || role === 'synth', signal);
    const { url, init } =
      provider === 'openrouter'
        ? openrouterRequest(id, request, { key: keys.openrouter, dataCollection })
        : provider === 'gemini'
          ? geminiRequest(id, request, { key: keys.gemini })
          : ollamaRequest(id, request);
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw callError(undefined, `network: ${err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      throw Object.assign(callError(res.status, message), { waitMs: retryAfterMs(res.headers.get('retry-after')) });
    }
    return PARSE[provider](body);
  }

  return {
    catalogs,
    call,
    async freeRequestsLeft() {
      if (!keys.openrouter) return undefined;
      try {
        const j = await getJson('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${keys.openrouter}` });
        const left = j?.data?.free_model_daily_requests?.remaining;
        return typeof left === 'number' ? left : undefined;
      } catch {
        return undefined;
      }
    },
    killAll() {
      for (const child of children) child.kill();
    },
  };
}
