import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPRITE, rgba, png, ico } from '../src/sparky-pixels.js';
import { wtFragment, install, uninstall } from '../src/install.js';
import { backgroundPng } from '../src/sparky-pixels.js';
import { SPARKY_RGBA } from '../plugin/hooks/sparky-image.ts';

test('the sprite is a symmetric-width 16×16 grid', () => {
  assert.equal(SPRITE.length, 16);
  assert.ok(SPRITE.every((row) => row.length === 16));
});

test('rgba scales each pixel into a square, transparent where the sprite has dots', () => {
  const px = rgba(2);
  assert.equal(px.length, 32 * 32 * 4);
  assert.equal(px[3], 0);
  const bolt = (0 * 32 + 2 * 2) * 4;
  assert.deepEqual([...px.subarray(bolt, bolt + 4)], [0x7d, 0xf9, 0xff, 0xff]);
});

test('png is a valid RGBA PNG of the scaled size whose pixels round-trip', () => {
  const file = png(16);
  assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(file.readUInt32BE(16), 256);
  assert.equal(file.readUInt32BE(20), 256);
  const idatLength = file.readUInt32BE(33);
  const raw = inflateSync(file.subarray(41, 41 + idatLength));
  assert.equal(raw.length, 256 * (1 + 256 * 4));
});

test('ico lists one PNG entry per size, 256 written as 0', () => {
  const file = ico();
  assert.equal(file.readUInt16LE(2), 1);
  assert.equal(file.readUInt16LE(4), 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => file[6 + 16 * i]), [16, 32, 48, 0]);
  const firstOffset = file.readUInt32LE(6 + 12);
  assert.equal(file.subarray(firstOffset + 1, firstOffset + 4).toString('ascii'), 'PNG');
});

test('the mod carries the same 16×16 pixels', () => {
  assert.equal(SPARKY_RGBA, rgba(1).toString('base64'));
});

test('the Windows Terminal fragment adds a Spark profile with Sparky as icon and the Spark scheme', () => {
  const f = wtFragment('C:\\spark\\assets\\sparky.png', 'ultraviolet', 'C:\\spark\\assets\\bg-ultraviolet.png');
  assert.equal(f.profiles[0].name, 'Spark');
  assert.equal(f.profiles[0].icon, 'C:\\spark\\assets\\sparky.png');
  assert.equal(f.profiles[0].colorScheme, f.schemes[0].name);
  assert.match(f.profiles[0].commandline, /spark$/);
  assert.equal(f.profiles[0].backgroundImage, 'C:\\spark\\assets\\bg-ultraviolet.png');
  assert.deepEqual(f.schemes.map((s) => s.name), ['Spark', 'Spark Teal']);
  assert.equal(wtFragment('i.png', 'teal', 'bg-teal.png').profiles[0].colorScheme, 'Spark Teal');
});

test('backgrounds are PNGs of the asked size, dark everywhere so text stays readable', () => {
  for (const theme of ['ultraviolet', 'teal']) {
    const file = backgroundPng(theme, 64, 36);
    assert.equal(file.readUInt32BE(16), 64);
    assert.equal(file.readUInt32BE(20), 36);
    const raw = inflateSync(file.subarray(41, 41 + file.readUInt32BE(33)));
    let brightest = 0;
    for (let y = 0; y < 36; y++)
      for (let x = 0; x < 64; x++) {
        const i = y * (1 + 64 * 4) + 1 + x * 4;
        brightest = Math.max(brightest, raw[i], raw[i + 1], raw[i + 2]);
      }
    assert.ok(brightest < 140, `${theme} background peaks at ${brightest}`);
  }
});

test('install writes the fragment and Sparky shortcuts; uninstall removes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-install-'));
  const paths = {
    fragmentDir: join(dir, 'Fragments', 'Spark'),
    shortcuts: [join(dir, 'Start Menu', 'Spark.lnk'), join(dir, 'Desktop', 'Spark.lnk')],
    wt: 'C:\\Windows\\System32\\cmd.exe',
  };
  install({ pngPath: join(dir, 'sparky.png'), icoPath: join(dir, 'sparky.ico'), theme: 'ultraviolet', background: join(dir, 'bg.png'), paths });
  const fragment = JSON.parse(readFileSync(join(paths.fragmentDir, 'spark.json'), 'utf8'));
  assert.equal(fragment.profiles[0].icon, join(dir, 'sparky.png'));
  assert.ok(paths.shortcuts.every((lnk) => existsSync(lnk)));
  uninstall(paths);
  assert.equal(existsSync(paths.fragmentDir), false);
  assert.ok(paths.shortcuts.every((lnk) => !existsSync(lnk)));
});
