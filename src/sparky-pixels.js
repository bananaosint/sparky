import { deflateSync, crc32 } from 'node:zlib';

// Sparky Bug as 16×16 pixel art. Digits are body pixels, shaded by row from
// blue to ultraviolet; letters are fixed colors; dots are transparent.
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

const FIXED = {
  B: [0x7d, 0xf9, 0xff],
  A: [0xa5, 0xb4, 0xfc],
  E: [0xf8, 0xfa, 0xfc],
  P: [0x0b, 0x0a, 0x1f],
  C: [0x7d, 0xf9, 0xff],
  W: [0x7d, 0xd3, 0xfc],
  M: [0x0b, 0x0a, 0x1f],
};
const TOP = [0x38, 0xbd, 0xf8];
const MID = [0x63, 0x66, 0xf1];
const BOTTOM = [0xa8, 0x55, 0xf7];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const bodyAt = (row) => {
  const t = (row - 4) / (SPRITE.length - 1 - 4);
  return t < 0.5 ? mix(TOP, MID, t * 2) : mix(MID, BOTTOM, (t - 0.5) * 2);
};

// RGBA bytes, each sprite pixel drawn as a scale×scale square.
export function rgba(scale = 1) {
  const size = SPRITE.length * scale;
  const out = Buffer.alloc(size * size * 4);
  SPRITE.forEach((line, y) =>
    [...line].forEach((ch, x) => {
      if (ch === '.') return;
      const color = FIXED[ch] ?? bodyAt(y);
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * size + x * scale + dx) * 4;
          out.set([...color, 0xff], i);
        }
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

export function png(scale = 1) {
  const size = SPRITE.length * scale;
  const pixels = rgba(scale);
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
