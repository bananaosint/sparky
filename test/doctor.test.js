import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findModels } from '../src/doctor.js';

const page = (names, nextPageToken) => ({
  ok: true,
  status: 200,
  json: async () => ({ models: names.map((n) => ({ name: `models/${n}` })), nextPageToken }),
});

test('reports which wanted models the key can use, across pages', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, key: init.headers['x-goog-api-key'] });
    return url.includes('pageToken=p2') ? page(['gemini-3.5-flash-lite']) : page(['gemini-3.6-flash'], 'p2');
  };
  const found = await findModels({ key: 'k', wanted: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'nope'], fetch });
  assert.deepEqual(found, { 'gemini-3.6-flash': true, 'gemini-3.5-flash-lite': true, nope: false });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.key === 'k' && !c.url.includes('k&') && !c.url.includes('key=')));
});

test('a rejected key throws with the status', async () => {
  const fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await assert.rejects(findModels({ key: 'bad', wanted: ['x'], fetch }), /400/);
});
