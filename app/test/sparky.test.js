import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grid } from '../staged/src/sparky-pixels.js';
import { MOVES, HATS, frameAt, emits } from '../lib/sparky.js';

const sprite = grid('ultraviolet');
const glow = [56, 232, 255];
const at = (name, t, o = {}) => frameAt(name, t, { sprite, glow, ...o });
const lit = (pixels) => pixels.flat().filter(Boolean).length;
const white = (c) => Boolean(c) && c.every((v) => v > 230);
const dark = (c) => Boolean(c) && c[0] + c[1] + c[2] < 100;
const EYE_PIXELS = [[4, 7], [5, 7], [4, 8], [5, 8], [10, 7], [11, 7], [10, 8], [11, 8]];

test('every move draws a whole 16×16 Sparky at any moment', () => {
  for (const name of Object.keys(MOVES))
    for (const t of [0, 100, 450, 900, 2000, 9000]) {
      const { pixels } = at(name, t, { level: 5 });
      assert.equal(pixels.length, 16);
      for (const row of pixels) assert.equal(row.length, 16);
      if (name !== 'assemble') assert.ok(lit(pixels) >= lit(sprite) - 2, `${name} at ${t}ms`);
    }
});

test('one-shot moves end and hand back; loops never end', () => {
  for (const name of ['assemble', 'cheer', 'oops', 'alert', 'charge', 'poke']) {
    assert.equal(at(name, 0).done, false, name);
    assert.equal(at(name, 5000).done, true, name);
  }
  for (const name of ['idle', 'work', 'cook', 'sleep', 'power']) assert.equal(at(name, 60000).done, false, name);
});

test('assemble flies the pixels home, eyes dark until they flicker on', () => {
  const mask = (pixels) => pixels.map((row) => row.map(Boolean));
  assert.notDeepEqual(mask(at('assemble', 0).pixels), mask(sprite));
  assert.deepEqual(mask(at('assemble', 700).pixels), mask(sprite));
  assert.ok(!white(at('assemble', 700).pixels[7][4]));
  assert.ok(white(at('assemble', 1050).pixels[7][4]));
});

test('pupils follow where he looks', () => {
  const up = at('idle', 0, { look: { x: 0, y: 0 } }).pixels;
  assert.ok(dark(up[7][4]) && dark(up[7][10]));
  assert.ok(white(up[8][5]));
  const down = at('idle', 0, { look: { x: 1, y: 1 } }).pixels;
  assert.ok(dark(down[8][5]) && white(down[7][4]));
});

test('cheer jumps and lands, with happy eyes and a burst of sparks', () => {
  assert.ok(at('cheer', 350).move.y < -3);
  assert.equal(at('cheer', 1200).move.y, 0);
  const face = at('cheer', 350).pixels;
  assert.ok(white(face[7][4]) && white(face[8][3]) && !white(face[8][4]));
  assert.ok(emits('cheer', 0, 300, { sprite, glow }).filter((p) => p.kind === 'spark').length >= 10);
});

test('oops shakes him with ×_× eyes, then settles', () => {
  const { pixels, move } = at('oops', 200);
  assert.notEqual(move.x, 0);
  assert.deepEqual(pixels[6][3], pixels[8][5]);
  assert.deepEqual(pixels[6][3], pixels[7][4]);
  assert.notDeepEqual(pixels[6][3], sprite[6][3]);
  assert.equal(at('oops', 1399).move.x, 0);
  assert.ok(emits('oops', 0, 1400, { sprite, glow }).some((p) => p.kind === 'smoke'));
});

test('asleep, his eyes are shut and z’s drift up', () => {
  const { pixels } = at('sleep', 500);
  for (const [x, y] of EYE_PIXELS) assert.ok(!white(pixels[y][x]), `eye pixel ${x},${y}`);
  assert.ok(emits('sleep', 0, 3600, { sprite, glow }).some((p) => p.kind === 'z'));
});

test('he wears the hat of the model answering, and a new one drops in on a charge', () => {
  for (const [name, hat] of Object.entries(HATS)) {
    const { pixels } = at('idle', 0, { hat: name });
    for (const [x, y, color] of hat) assert.deepEqual(pixels[y][x], color, `${name} at ${x},${y}`);
  }
  const bare = at('idle', 0).pixels;
  for (let y = 0; y < 4; y++) for (let x = 5; x <= 10; x++) assert.equal(bare[y][x], null);
  const crown = HATS.opus.find(([, y]) => y === 3);
  assert.notDeepEqual(at('charge', 0, { hat: 'opus' }).pixels[crown[1]][crown[0]], crown[2]);
  assert.deepEqual(at('charge', 1499, { hat: 'opus' }).pixels[crown[1]][crown[0]], crown[2]);
});

test('power shows the effort: hotter eyes and more sparks the higher it goes', () => {
  const sparks = (level) => emits('power', 0, 4800, { sprite, glow, level }).length;
  assert.equal(sparks(2), 0);
  assert.ok(sparks(5) > sparks(4) && sparks(4) > sparks(3));
  const heat = (level) => at('power', 0, { level }).pixels[7][4].reduce((a, b) => a + b);
  assert.ok(heat(5) > heat(2));
});
