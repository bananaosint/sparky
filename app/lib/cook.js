// The Gemini rewrite, as the Spark mod does it, for the app's message box.
import { endpoint, forModel, parseRewrite, rewriteRequest } from '../staged/plugin/hooks/gemini.ts';
import { composeCooked } from '../staged/plugin/hooks/cook.ts';
import { redact } from '../staged/plugin/hooks/redact.ts';

// Each model gets `tries` tries of `timeoutMs`, then the next is asked; a refused key ends it.
export async function cookPrompt(text, { key, models, thinking = 'low', timeoutMs = 10_000, tries = 3, fetchImpl = fetch }) {
  const { text: safe, restore } = redact(text);
  const body = rewriteRequest(safe, thinking);
  let last = new Error('no Gemini model to try');
  for (const model of models)
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetchImpl(endpoint(model), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(forModel(model, body)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Gemini refused the key (HTTP ${res.status})`), { fatal: true });
        if (!res.ok) throw new Error(`${model} answered HTTP ${res.status}`);
        const rewrite = parseRewrite(await res.json());
        if (!rewrite) throw new Error(`${model} gave an empty rewrite`);
        return { text: restore(composeCooked(rewrite, [])), model };
      } catch (err) {
        if (err.fatal) throw err;
        last = err;
      }
    }
  throw last;
}
