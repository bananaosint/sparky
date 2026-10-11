import { test } from 'node:test';
import assert from 'node:assert/strict';
import { councilCard } from '../lib/council-view.js';

// Just enough of the DOM for a card: nodes that hold text, children and properties.
const el = (tag, cls = '', text = '') => {
  const node = { tag, className: cls, textContent: text, children: [], dataset: {}, style: {} };
  node.append = (...kids) => node.children.push(...kids);
  node.replaceChildren = (...kids) => (node.children = kids);
  node.addEventListener = () => {};
  node.setAttribute = () => {};
  return node;
};
const textOf = (n) => (typeof n === 'string' ? n : [n.textContent, ...n.children.map(textOf)].join(' '));

const seat = (id, over = {}) => ({ id, provider: 'claude', name: id, family: 'claude', access: 'claude-plan', openWeights: false, reason: 'r', estimate: { label: 'on your plan' }, ...over });
const preflight = {
  id: 'c-20261010-200000-beef',
  question: 'speed up the cache',
  mode: 'light',
  createdAt: 1,
  brief: { objective: 'speed up the cache', context: [], constraints: [], criteria: [], verification: [] },
  panel: { proposers: [seat('sonnet'), seat('deepseek/a', { provider: 'openrouter', family: 'deepseek', access: 'free-hosted', estimate: { label: 'free' } })], judges: [seat('opus')], synth: seat('sonnet') },
  empty: [],
  notes: [],
  estimate: { meteredUsd: 0, freeCalls: 1 },
  consentNeeded: [],
};
const API_KEY = { label: 'your Anthropic API key', billed: true, note: 'charged to the Anthropic Console account that owns the key' };

test('a council card says who pays for Claude, as the turn footer does: never "your plan" when a key pays', () => {
  const card = councilCard({ el, markdown: (s) => s, spark: {}, note: () => {}, cap: () => 1, payer: () => API_KEY });
  card.update(preflight);
  const text = textOf(card.node);
  assert.ok(!/your (Claude )?plan/.test(text), text);
  assert.match(text, /charged to the Anthropic Console account that owns the key/);
  assert.match(text, /your Anthropic API key/);
});
