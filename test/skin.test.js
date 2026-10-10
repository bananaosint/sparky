import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkin } from '../src/skin.js';

const E = '\x1b';
const CRAB = `${E}[38;2;215;119;87m`;
const GRAY = `${E}[38;2;153;153;153m`;

// Claude Code's header as it comes out of a pseudo-terminal: the crab is the
// first 11 columns of three rows. Placeholder text stands in for the details.
const HEADER =
  `${E}[?2026l${E}[K` +
  `${CRAB}\n ▐${E}[48;2;0;0;0m▛███▛█${E}[m   ${E}[1mClaude Code${E}[22m ${GRAY}v9.9.9${E}[K` +
  `${CRAB}\n▝▜${E}[48;2;0;0;0m█████${E}[49m█▀  ${GRAY}Model · Plan${E}[K` +
  `${CRAB}\n ▝▝   ▝▝   ${GRAY}~\\project${E}[K${E}[m\n`;

const strip = (s) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '');
// Glyphs the crab uses and Sparky doesn't.
const CRAB_GLYPHS = /[▛▜█]/;

function skinned(chunks) {
  let out = '';
  const timers = [];
  const skin = createSkin((s) => (out += s), { setTimer: (fn) => timers.push(fn), clearTimer: () => {} });
  for (const chunk of chunks) skin(chunk);
  for (const fn of timers.splice(0)) fn();
  return out;
}

test('the crab rows become Sparky, and the header text keeps its column', () => {
  const out = skinned([HEADER]);
  const lines = strip(out).split('\n').slice(1, 4);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotMatch(line.slice(0, 11), CRAB_GLYPHS);
  assert.doesNotMatch(lines[2], /▝▝   ▝▝/);
  assert.match(lines[0], /ϟ/);
  assert.match(lines[1], /◕/);
  assert.equal(lines[0].slice(11), 'Claude Code v9.9.9');
  assert.equal(lines[1].slice(11), 'Model · Plan');
  assert.equal(lines[2].slice(11), '~\\project');
});

test('the header comes out the same however the stream is split', () => {
  const whole = skinned([HEADER]);
  for (let i = 1; i < HEADER.length; i++) assert.equal(skinned([HEADER.slice(0, i), HEADER.slice(i)]), whole, `split at ${i}`);
});

test('the arms-up pose is recognised as the top row', () => {
  const up = `${CRAB}\n▗▟${E}[48;2;0;0;0m▛███▛█${E}[m▄  ${E}[1mClaude Code${E}[22m`;
  const line = strip(skinned([up])).split('\n')[1];
  assert.match(line, /ϟ/);
  assert.equal(line.slice(11), 'Claude Code');
});

test('the teal theme draws Sparky in teal and electric green', () => {
  let out = '';
  createSkin((s) => (out += s), { theme: 'teal', setTimer: () => {}, clearTimer: () => {} })(HEADER);
  assert.ok(out.includes('38;2;94;234;212'));
  assert.equal(out.includes('38;2;67;133;255'), false);
});

test('everything else passes through byte for byte', () => {
  const other = `${E}[38;2;74;222;128m\n█████░░░ 60%${E}[m\n plain text ▐ with a block${E}[K\n`;
  assert.equal(skinned([other]), other);
});
