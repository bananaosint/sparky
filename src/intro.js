import { SPRITE, grid } from './sparky-pixels.js';
import { THEMES, mix, gradientAt } from './palettes.js';

// Sparky's entrance: pixels fly in, his eyes ignite like a neon tube and glow
// into the body around them, he glances left and back, the bolts flash, and
// the wordmark sweeps in. 26 frames at 30 fps, under 0.9 s.
export const FPS = 30;
const ASSEMBLE = 12;
const IGNITE = 10;
const WORD_START = 14;
const WORD_FRAMES = 10;
export const FRAME_COUNT = ASSEMBLE + IGNITE + 4;
// A neon tube catching: on, off, mostly on, flicker, then steady.
const FLICKER = [0.15, 0.6, 0.1, 0.85, 0.35, 1, 1, 1, 1, 1];
const GAP = '   ';

const WORD = [
  '▄▀▀▀ █▀▀▄ ▄▀▀▄ █▀▀▄ █ ▄▀',
  ' ▀▀▄ █▀▀  █▀▀█ █▀█  █▀▄ ',
  '▀▀▀  ▀    ▀  ▀ ▀  ▀ ▀  ▀',
];
const WHITE = [0xff, 0xff, 0xff];
const UNLIT = [0x1e, 0x1b, 0x3a];
const EYES = [
  [4.5, 7.5],
  [10.5, 7.5],
];

const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
const RESET = '\x1b[0m';
const easeOut = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

// Two pixel rows per text row: the upper half block takes the top pixel's color, the cell background the bottom one's.
export function halfBlocks(pixels) {
  const rows = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let line = '';
    pixels[y].forEach((top, x) => {
      const bottom = pixels[y + 1]?.[x] ?? null;
      if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${RESET}`;
      else if (top) line += `${fg(top)}▀${RESET}`;
      else if (bottom) line += `${fg(bottom)}▄${RESET}`;
      else line += ' ';
    });
    rows.push(line);
  }
  return rows;
}

// A fixed pseudo-random start for each pixel, so every launch plays the same way.
function scatter(i) {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  const m = Math.sin(i * 78.233) * 12345.6789;
  return [Math.floor((n - Math.floor(n)) * 16), Math.floor((m - Math.floor(m)) * 16)];
}

function assembled(base, t) {
  const canvas = base.map((row) => row.map(() => null));
  let i = 0;
  base.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      const [sx, sy] = scatter(i);
      const p = easeOut((t - (i % 7) / 20) / (1 - 6 / 20));
      i++;
      canvas[Math.round(sy + (y - sy) * p)][Math.round(sx + (x - sx) * p)] = color;
    }),
  );
  return canvas;
}

// Eyes at brightness g: the whites go from unlit through the glow color to a white-hot core,
// the pupils sit left or right, and the body within 2.5 pixels takes on the glow.
function lit(base, theme, g, lookLeft, halo) {
  const glow = THEMES[theme].glow;
  const white = g > 0.8 ? mix(glow, WHITE, (g - 0.8) * 5) : mix(UNLIT, glow, g / 0.8);
  return base.map((row, y) =>
    row.map((color, x) => {
      if (!color) return null;
      const isEye = (y === 7 || y === 8) && (x === 4 || x === 5 || x === 10 || x === 11);
      if (isEye) {
        const pupil = y === 8 && (lookLeft ? x === 4 || x === 10 : x === 5 || x === 11);
        return pupil ? color : white;
      }
      const d = Math.min(...EYES.map(([ex, ey]) => Math.hypot(x - ex, y - ey)));
      return d < 2.5 ? mix(color, glow, g * halo * (1 - d / 2.5) ** 2) : color;
    }),
  );
}

function wordRows(theme, shown) {
  const stops = THEMES[theme].gradient;
  return WORD.map((row) =>
    [...row]
      .map((ch, i) => (i < shown && ch !== ' ' ? `${fg(gradientAt(stops, i / (row.length - 1)))}${ch}${RESET}` : ' '))
      .join(''),
  );
}

function frame(n, theme, subline) {
  const base = grid(theme);
  let pixels;
  if (n < ASSEMBLE) pixels = lit(assembled(base, n / (ASSEMBLE - 1)), theme, 0, false, 0);
  else {
    const k = n - ASSEMBLE;
    const g = FLICKER[Math.min(k, FLICKER.length - 1)];
    // The glow blooms while igniting, then settles to a steady halo.
    pixels = lit(base, theme, g, k >= 4 && k < 7, k < IGNITE ? 0.6 : 0.35);
    // The bolts flash white as the eyes catch.
    if (k === 5 || k === 6) pixels = pixels.map((row, y) => row.map((c, x) => (SPRITE[y][x] === 'B' ? WHITE : c)));
  }
  const shown = Math.round(WORD[0].length * Math.min(1, Math.max(0, (n - WORD_START + 1) / WORD_FRAMES)));
  const words = wordRows(theme, shown);
  const blank = ' '.repeat(WORD[0].length);
  const rows = halfBlocks(pixels).map((row, i) => row + GAP + (i >= 3 && i <= 5 ? words[i - 3] : blank));
  const last = n === FRAME_COUNT - 1;
  rows.push(last && subline ? `${fg(THEMES[theme].dim)}${subline}${RESET}` : '');
  return rows.join('\n');
}

export function frames({ theme = 'ultraviolet', subline = '' } = {}) {
  return Array.from({ length: FRAME_COUNT }, (_, n) => frame(n, theme, subline));
}

// Draws each frame over the last, cursor hidden, then leaves the final frame in place.
export async function playIntro(all, { out = process.stdout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const height = all[0].split('\n').length;
  out.write('\x1b[?25l');
  for (let i = 0; i < all.length; i++) {
    if (i) out.write(`\x1b[${height - 1}A\r`);
    out.write(all[i].split('\n').map((row) => `${row}\x1b[K`).join('\n'));
    await sleep(1000 / FPS);
  }
  out.write('\n\x1b[?25h');
}
