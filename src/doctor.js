const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';

// The key goes in a header, never the URL, so it stays out of logs.
export async function findModels({ key, wanted, fetch = globalThis.fetch }) {
  const available = new Set();
  let pageToken;
  do {
    const url = pageToken ? `${MODELS_URL}&pageToken=${encodeURIComponent(pageToken)}` : MODELS_URL;
    const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new Error(`Gemini rejected the request (HTTP ${res.status})`);
    const body = await res.json();
    for (const m of body.models ?? []) available.add(m.name.replace(/^models\//, ''));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return Object.fromEntries(wanted.map((id) => [id, available.has(id)]));
}
