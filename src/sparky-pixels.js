import { deflateSync, crc32 } from 'node:zlib';
import { THEMES, gradientAt } from './palettes.js';

// Sparky Bug as 16×16 pixel art. Digits are body pixels, shaded by row along the
// theme's gradient; letters are fixed parts; dots are transparent.
export const SPRITE = [
  '..B..........B..',
  '..BB........BB..',
  '...BA......AB...',
  '....A......A....',
  '.....111111.....',
  '...1111111111...',
  '..111111111111..',
  '..11EE1111EE11..',
  '.W11EP1111EP11W.',
  'WW111111111111WW',
  '.W1CC111111CC1W.',
  '..111111111111..',
  '...1111MM1111...',
  '....11111111....',
  '....11....11....',
  '...111....111...',
];

const EYE = [0xf8, 0xfa, 0xfc];
const DARK = [0x0b, 0x0a, 0x1f];

// The sprite as rows of colors, null where transparent.
export function grid(theme = 'ultraviolet') {
  const t = THEMES[theme];
  const fixed = { B: t.bolt, A: t.antenna, E: EYE, P: DARK, C: t.bolt, W: t.wing, M: DARK };
  return SPRITE.map((line, y) =>
    [...line].map((ch) => (ch === '.' ? null : (fixed[ch] ?? gradientAt(t.gradient, (y - 4) / (SPRITE.length - 1 - 4))))),
  );
}

// RGBA bytes, each sprite pixel drawn as a scale×scale square.
export function rgba(scale = 1, theme = 'ultraviolet') {
  const size = SPRITE.length * scale;
  const out = Buffer.alloc(size * size * 4);
  grid(theme).forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) out.set([...color, 0xff], ((y * scale + dy) * size + x * scale + dx) * 4);
    }),
  );
  return out;
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};

export function encodePng(width, height, pixels) {
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const png = (scale = 1, theme = 'ultraviolet') => encodePng(SPRITE.length * scale, SPRITE.length * scale, rgba(scale, theme));

// A Windows .ico holding PNG images, which Windows reads since Vista.
export function ico(scales = [1, 2, 3, 16]) {
  const images = scales.map((s) => ({ size: SPRITE.length * s, data: png(s) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

// The terminal background: a dark diagonal gradient with two soft glows of the theme's colors.
export function backgroundPng(theme, width = 960, height = 540) {
  const { from, to, glows } = THEMES[theme].background;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const color = from.map((c, k) => c + (to[k] - c) * (u * 0.6 + v * 0.4));
      for (const g of glows) {
        // Distance in screen proportions, so the glows are round on a wide terminal.
        const d2 = (u - g.x) ** 2 + (((v - g.y) * height) / width) ** 2;
        const w = g.strength * Math.exp(-d2 / 0.09);
        for (let k = 0; k < 3; k++) color[k] += (g.color[k] - color[k]) * w;
      }
      out.set([...color.map((c) => Math.round(c)), 0xff], (y * width + x) * 4);
    }
  return encodePng(width, height, out);
}
