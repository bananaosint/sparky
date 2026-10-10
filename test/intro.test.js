import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frames, playIntro, halfBlocks, FRAME_COUNT, FPS } from '../src/intro.js';

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const width = (s) => [...strip(s)].length;
const WHITE_HOT = '38;2;255;255;255';

test('the intro is under a second and every frame has the same shape, so nothing jumps', () => {
  const all = frames({ subline: 'Spark · gemini on' });
  assert.equal(all.length, FRAME_COUNT);
  assert.ok((FRAME_COUNT / FPS) * 1000 < 900);
  const shape = (f) => f.split('\n').map(width);
  const first = shape(all[0]).slice(0, -1);
  for (const f of all) assert.deepEqual(shape(f).slice(0, -1), first);
  assert.equal(all[0].split('\n').length, 9);
});

test('the eyes start unlit, flicker on white-hot, and the final frame keeps the wordmark and status', () => {
  const all = frames({ subline: 'Spark · gemini on' });
  assert.equal(all[0].includes(WHITE_HOT), false);
  assert.ok(all.slice(12).some((f) => f.includes(WHITE_HOT)));
  const last = strip(all.at(-1));
  assert.match(last, /▄▀▀▀ █▀▀▄ ▄▀▀▄ █▀▀▄ █ ▄▀/);
  assert.match(last, /Spark · gemini on$/);
  assert.equal(strip(all[0]).includes('█▀▀▄'), false);
});

test('the teal theme paints in teal and electric green, not ultraviolet', () => {
  const last = frames({ theme: 'teal' }).at(-1);
  assert.ok(last.includes('57;255;20'));
  assert.equal(last.includes('180;92;255'), false);
});

test('halfBlocks puts two pixel rows in one text row', () => {
  const A = [1, 2, 3];
  const B = [4, 5, 6];
  const [row] = halfBlocks([
    [A, A, null, null],
    [B, null, B, null],
  ]);
  assert.equal(strip(row), '▀▀▄ ');
  assert.match(row, /38;2;1;2;3m\x1b\[48;2;4;5;6m▀/);
});

test('playIntro redraws each frame over the last and restores the cursor', async () => {
  let written = '';
  const all = ['a\nb', 'c\nd', 'e\nf'];
  await playIntro(all, { out: { write: (s) => (written += s) }, sleep: async () => {} });
  assert.ok(written.startsWith('\x1b[?25l'));
  assert.equal(written.split('\x1b[1A\r').length, 3);
  assert.ok(written.endsWith('\n\x1b[?25h'));
});
