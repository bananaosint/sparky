// Gemini for the app: the prompt rewrite and skill picks the Spark mod makes, and quick answers.
import { endpoint, forModel, parseRewrite, parseRoute, rewriteRequest, routeRequest } from '../staged/plugin/hooks/gemini.ts';
import { composeCooked } from '../staged/plugin/hooks/cook.ts';
import { redact } from '../staged/plugin/hooks/redact.ts';

// Each model gets `tries` tries of `timeoutMs`, then the next is asked; a refused key ends it.
export async function askChain(models, body, parse, { key, timeoutMs = 10_000, tries = 3, fetchImpl = fetch }) {
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
        const value = parse(await res.json());
        if (value === undefined) throw new Error(`${model} gave an empty answer`);
        return { value, model };
      } catch (err) {
        if (err.fatal) throw err;
        last = err;
      }
    }
  throw last;
}

// Rewrite and skill picks run side by side; either may be off or fail without stopping the other.
export async function cookPrompt(text, { rewrite = true, pickSkills = true, skills = [], rewriteModels, routeModels, thinking = 'low', ...options }) {
  const { text: safe, restore } = redact(text);
  const known = new Set(skills.map((s) => s.name));
  const [rewritten, routed] = await Promise.allSettled([
    rewrite ? askChain(rewriteModels, rewriteRequest(safe, thinking), parseRewrite, options) : Promise.resolve(undefined),
    pickSkills && skills.length
      ? askChain(routeModels, routeRequest(safe, skills, 'minimal', false), (r) => parseRoute(r, known).skills, options)
      : Promise.resolve(undefined),
  ]);
  if (rewritten.status === 'rejected' && rewritten.reason?.fatal) throw rewritten.reason;
  const picked = routed.status === 'fulfilled' ? routed.value?.value ?? [] : [];
  const base = rewritten.status === 'fulfilled' && rewritten.value ? rewritten.value.value : { prompt: safe, unclear: [] };
  return {
    text: restore(composeCooked(base, picked)),
    model: rewritten.status === 'fulfilled' ? rewritten.value?.model : undefined,
    rewriteError: rewritten.status === 'rejected' ? rewritten.reason.message : undefined,
    skills: picked,
    skillsModel: routed.status === 'fulfilled' ? routed.value?.model : undefined,
  };
}

const QUICK_SYSTEM = `You are Sparky, a quick-answer assistant inside Spark, a coding app. Answer briefly and directly in Markdown. You can't see or change the person's files; for work on the project, say they can switch the model to Claude.`;

const answerText = (response) => {
  const parts = response?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim() : '';
  return text || undefined;
};

// A quick answer from Gemini: the recent chat as context, pasted images included.
export async function quickAnswer(history, { rewriteModels, ...options }) {
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } })), { text: m.text || ' ' }],
  }));
  const body = { systemInstruction: { parts: [{ text: QUICK_SYSTEM }] }, contents, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } };
  const { value, model } = await askChain(rewriteModels, body, answerText, options);
  return { text: value, model };
}
