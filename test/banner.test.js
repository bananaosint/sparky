import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBanner } from '../src/banner.js';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => [...s].length;
const MASCOT_WIDTH = 15;

test('plain banner is five rows of equal width with Sparky Bug on the left', () => {
  const lines = renderBanner({ color: false }).split('\n');
  assert.equal(lines.length, 5);
  assert.equal(new Set(lines.map(width)).size, 1);
  assert.match(lines[0], /ϟ.*ϟ/);
  assert.match(lines[2], /◕.*◕/);
});

test('the wordmark sits beside the middle three rows, starting in the same column', () => {
  const lines = renderBanner({ color: false }).split('\n');
  const word = (line) => [...line].slice(MASCOT_WIDTH).join('');
  for (const i of [1, 2, 3]) assert.match(word(lines[i]), /^[▄▀█ ]*[▄▀█][▄▀█ ]*$/);
  for (const i of [0, 4]) assert.equal(word(lines[i]).trim(), '');
  assert.notEqual([...lines[1]][MASCOT_WIDTH], ' ');
});

test('plain banner has no escape codes', () => {
  assert.doesNotMatch(renderBanner({ color: false }), /\x1b/);
});

test('colored banner shows the same text once escape codes are stripped', () => {
  assert.equal(stripAnsi(renderBanner({ color: true })), renderBanner({ color: false }));
});

test('colored banner paints in blue to ultraviolet, with no amber left', () => {
  const banner = renderBanner({ color: true });
  assert.match(banner, /38;2;56;189;248m/);
  assert.match(banner, /38;2;168;85;247m/);
  assert.doesNotMatch(banner, /38;2;255;176;0m/);
});

test('subline is added as a sixth line', () => {
  const lines = renderBanner({ color: false, subline: 'cc 2.1.296 · gemini on' }).split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[5].trim(), 'cc 2.1.296 · gemini on');
});
