// Sparky Bug, Spark's electric bug. A `b` in FACE marks a cell drawn on the body
// color, so the face reads as solid around the eyes and cheeks.
const MASCOT = [
  '  ϟ       ϟ',
  '   ╲▗▄▄▄▖╱',
  '  ▐█◕ ▾ ◕█▌',
  ' ◂▐█●▄▄▄●█▌▸',
  '   ▝▀╯ ╰▀▘',
].map((row) => row.padEnd(15));
const FACE = ['', '', '    bbbbb', '    b   b', ''];
const WORD = [
  '▄▀▀▀ █▀▀▄ ▄▀▀▄ █▀▀▄ █ ▄▀',
  ' ▀▀▄ █▀▀  █▀▀█ █▀█  █▀▄ ',
  '▀▀▀  ▀    ▀  ▀ ▀  ▀ ▀  ▀',
];
const BLANK = ' '.repeat(WORD[0].length);

const BOLT = [0x7d, 0xf9, 0xff];
const ANTENNA = [0xa5, 0xb4, 0xfc];
const EYE = [0xf8, 0xfa, 0xfc];
const DIM = [0x94, 0xa3, 0xb8];
const GRADIENT = [
  [0, [0x38, 0xbd, 0xf8]],
  [0.5, [0x63, 0x66, 0xf1]],
  [1, [0xa8, 0x55, 0xf7]],
];

const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function gradientAt(t) {
  const i = t <= GRADIENT[1][0] ? 0 : 1;
  const [t0, from] = GRADIENT[i];
  const [t1, to] = GRADIENT[i + 1];
  const u = (t - t0) / (t1 - t0);
  return from.map((v, k) => Math.round(v + (to[k] - v) * u));
}

function paintMascot(row, i) {
  const body = gradientAt(i / (MASCOT.length - 1));
  return [...row]
    .map((ch, k) => {
      if (FACE[i][k] === 'b') return bg(body) + fg(ch === '●' ? BOLT : EYE) + ch + RESET;
      if (ch === 'ϟ') return BOLD + fg(BOLT) + ch + RESET;
      if (ch === '◂' || ch === '▸') return fg(BOLT) + ch;
      if (ch === '╲' || ch === '╱') return fg(ANTENNA) + ch;
      return fg(body) + ch;
    })
    .join('');
}

function paintWord(row) {
  const cols = [...row];
  return cols.map((ch, i) => fg(gradientAt(i / (cols.length - 1))) + ch).join('');
}

export function renderBanner({ color = true, subline } = {}) {
  const rows = MASCOT.map((mascot, i) => {
    const word = WORD[i - 1] ?? BLANK;
    return color ? paintMascot(mascot, i) + paintWord(word) + RESET : mascot + word;
  });
  if (subline) rows.push(color ? `${fg(DIM)}   ${subline}${RESET}` : `   ${subline}`);
  return rows.join('\n');
}
