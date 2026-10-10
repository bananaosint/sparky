// Sparky's moves, as frame math over his 16×16 sprite. A frame says which pixels to paint,
// how to move the canvas (hop, squash, shake; in sprite pixels) and whether a one-shot
// move is done. emits() says which particles fly off between two moments of a move.

const WHITE = [255, 255, 255];
const UNLIT = [30, 27, 58];
const DARK = [11, 10, 31];
const HURT = [255, 84, 112];
const X_EYE = [255, 92, 120];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (v) => Math.min(1, Math.max(0, v));
const out = (t) => 1 - (1 - clamp(t)) ** 3;
const wave = (t, period) => Math.sin((2 * Math.PI * t) / period);
// Repeatable noise, so a move looks the same every time it plays.
const noise = (i) => {
  const n = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return n - Math.floor(n);
};

// Top-left pixel of each 2×2 eye.
const EYES = [[4, 7], [10, 7]];
const BOLTS = [[2, 0], [2, 1], [3, 1], [3, 2], [13, 0], [12, 1], [13, 1], [12, 2]];
const WINGS = [[1, 8], [0, 9], [1, 9], [1, 10], [14, 8], [14, 9], [15, 9], [14, 10]];
const TIPS = [[2, 0], [13, 0]];
// Pupil spots around the eye, clockwise: a dizzy swirl.
const SWIRL = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const FLICKER = [0.15, 0.6, 0.1, 0.85, 0.35, 1];

// Hats sit on his head between the antennas: columns 5–10, rows 0–3.
const art = (rows, colors) => rows.flatMap((row, y) => [...row].flatMap((ch, i) => (ch === '.' ? [] : [[5 + i, y, colors[ch]]])));
const GOLD = [255, 206, 84];
const GEM = [255, 92, 138];
const INDIGO = [118, 120, 255];
const NUB = [70, 60, 190];
const PINK = [255, 140, 196];
const POLLEN = [255, 226, 110];
const LEAF = [110, 220, 130];
const STAR = [138, 180, 255];
export const HATS = {
  opus: art(['......', 'Y.YY.Y', 'YYYYYY', 'YRYYRY'], { Y: GOLD, R: GEM }),
  sonnet: art(['......', '....n.', '.BBBBB', 'BBBBBB'], { B: INDIGO, n: NUB }),
  haiku: art(['......', '...P..', '..PYP.', '.L.P..'], { P: PINK, Y: POLLEN, L: LEAF }),
  gemini: art(['...W..', '...S..', '.SSWSS', '...S..'], { S: STAR, W: WHITE }),
};
const TWINKLE = art(['......', '...S..', '..SWS.', '...S..'], { S: STAR, W: WHITE });

// Eye color at brightness g: unlit, through the theme's glow, to a white-hot core.
const eyeLight = (g, glow) => (g > 0.8 ? mix(glow, WHITE, clamp((g - 0.8) * 5)) : mix(UNLIT, glow, clamp(g / 0.8)));

function pose(sprite, glow, f) {
  const px = sprite.map((row) => row.slice());
  const set = (x, y, c) => y >= 0 && y < 16 && x >= 0 && x < 16 && (px[y][x] = c);
  const skin = (x) => sprite[6][x];

  if (f.tint) px.forEach((row, y) => row.forEach((c, x) => c && (px[y][x] = mix(c, f.tint[0], f.tint[1]))));
  if (f.band !== null) px.forEach((row, y) => row.forEach((c, x) => c && (px[y][x] = mix(c, WHITE, 0.75 * clamp(1 - Math.abs(y - f.band) / 2)))));
  for (const [x, y] of BOLTS) px[y][x] = mix(px[y][x], WHITE, f.bolts);
  if (f.wings) {
    const wing = WINGS.map(([x, y]) => [x, y, px[y][x]]);
    for (const [x, y] of WINGS) px[y][x] = null;
    for (const [x, y, c] of wing) set(x, y + f.wings, c);
  }
  if (f.tap) px[15][f.tap === 'left' ? 3 : 12] = null;

  const light = eyeLight(f.g, glow);
  EYES.forEach(([ex, ey], side) => {
    const at = (dx, dy, c) => set(ex + dx, ey + dy, c);
    const shut = () => [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([dx, dy]) => at(dx, dy, skin(ex + dx)));
    const open = () => [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([dx, dy]) => at(dx, dy, light));
    if (f.eyes === 'open') {
      open();
      at(f.pupil.x, f.pupil.y, DARK);
    } else if (f.eyes === 'wide') open();
    else if (f.eyes === 'lid') {
      shut();
      at(0, 1, light);
      at(1, 1, light);
      at(f.pupil.x, 1, DARK);
    } else if (f.eyes === 'happy') {
      shut();
      for (const [dx, dy] of [[-1, 1], [0, 0], [1, 0], [2, 1]]) at(dx, dy, light);
    } else if (f.eyes === 'x') {
      shut();
      const cx = side; // the X centres on each eye's outer column
      for (const [dx, dy] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) at(cx + dx, dy, X_EYE);
    } else {
      shut();
      if (f.eyes === 'sleep') [0, 1].forEach((dx) => at(dx, 1, DARK));
    }
  });

  const lip = sprite[12][6];
  if (f.mouth === 'smile') {
    set(7, 12, lip);
    set(8, 12, lip);
    for (const [x, y] of [[6, 12], [9, 12], [7, 13], [8, 13]]) set(x, y, DARK);
  }
  if (f.mouth === 'o') [[7, 13], [8, 13]].forEach(([x, y]) => set(x, y, DARK));

  for (const [x, y, c] of f.hat ?? []) set(x, y + f.hatY, c);
  return px;
}

// Pixels fly in from fixed scattered spots, each a little after the last.
function scatter(px, t) {
  const home = [];
  px.forEach((row, y) => row.forEach((c, x) => c && home.push([x, y, c])));
  const flown = Array.from({ length: 16 }, () => Array(16).fill(null));
  home.forEach(([x, y, c], i) => {
    const p = out((t - (i % 7) / 20) / 0.7);
    const sx = Math.floor(noise(i) * 16);
    const sy = Math.floor(noise(i + 500) * 16);
    flown[Math.round(sy + (y - sy) * p)][Math.round(sx + (x - sx) * p)] = c;
  });
  return flown;
}

const spark = ([x, y], n) => ({ kind: 'spark', x, y, dx: (n - 0.5) * 6, dy: -3 - n * 3, life: 520 });
const radial = (count, life = 700, reach = 7) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * 2 * Math.PI + noise(i) * 0.4;
    const r = reach * (0.7 + noise(i + 99) * 0.5);
    return { kind: 'spark', x: 7.5, y: 8, dx: Math.cos(a) * r, dy: Math.sin(a) * r, life };
  });
const ring = () => ({ kind: 'ring', x: 8, y: 9, dx: 0, dy: 0, life: 700 });

export const MOVES = {
  idle: {
    loop: 4800,
    frame: (t) => ({
      y: -0.6 * (1 - Math.cos((2 * Math.PI * t) / 2400)) / 2,
      eyes: (t >= 3600 && t < 3720) || (t >= 4400 && t < 4510) ? 'shut' : 'open',
      wings: (t >= 1200 && t < 1320) || (t >= 1440 && t < 1560) ? -1 : 0,
    }),
  },
  work: {
    loop: 1600,
    frame: (t) => ({
      y: -0.5 * Math.abs(Math.sin((Math.PI * t) / 400)),
      pupil: { x: t < 800 ? 0 : 1, y: 0 },
      bolts: Math.floor(t / 100) % 3 === 0 ? 1 : 0.25,
      tap: Math.floor(t / 200) % 2 ? 'left' : null,
      g: 1 + 0.15 * wave(t, 800),
    }),
    particles: () => [{ at: 0, every: 260, make: (k) => spark(TIPS[k % 2], noise(k)) }],
  },
  cook: {
    loop: 960,
    frame: (t) => ({
      y: -0.3 * Math.abs(Math.sin((Math.PI * t) / 240)),
      pupil: SWIRL[Math.floor(t / 120) % 4],
      wings: Math.floor(t / 160) % 2 ? -1 : 0,
      mouth: 'smile',
      g: 1.1,
    }),
    particles: () => [{ at: 0, every: 320, make: (k) => ({ kind: 'star', x: 2 + noise(k) * 12, y: 1 + noise(k + 7) * 4, dx: (noise(k + 3) - 0.5) * 3, dy: -3, life: 700 }) }],
  },
  cheer: {
    length: 1200,
    frame: (t) => {
      const face = { eyes: 'happy', mouth: 'smile', g: 1.2, wings: Math.floor(t / 70) % 2 ? -1 : 1 };
      if (t < 140) return { ...face, sx: 1.12, sy: 0.86, wings: 0 };
      if (t < 560) {
        const p = (t - 140) / 420;
        return { ...face, y: -5 * Math.sin(Math.PI * p), sx: p < 0.5 ? 0.92 : 1, sy: p < 0.5 ? 1.1 : 1 };
      }
      if (t < 700) return { ...face, sx: 1.1, sy: 0.88, wings: 0 };
      const p = (t - 700) / 500;
      const wobble = 0.06 * (1 - clamp(p)) * Math.cos(p * 18);
      return { ...face, sx: 1 - wobble, sy: 1 + wobble, wings: 0 };
    },
    particles: () => [
      {
        at: 140,
        make: () => [...radial(14), ...[0, 1, 2].map((k) => ({ kind: 'star', x: 3 + k * 4.5, y: 2, dx: (k - 1) * 3, dy: -6, life: 900 }))],
      },
    ],
  },
  oops: {
    length: 1400,
    frame: (t) => ({
      x: t < 600 ? 0.9 * Math.sin(t / 22) * (1 - t / 600) : 0,
      y: t > 600 && t < 1300 ? 0.4 : 0,
      eyes: t < 1100 ? 'x' : 'lid',
      mouth: t < 1100 ? 'o' : 'line',
      tint: t < 520 ? [HURT, Math.floor(t / 80) % 2 ? 0.55 : 0.2] : null,
      g: 0,
      wings: t > 600 ? 1 : 0,
    }),
    particles: () =>
      [120, 300, 480].map((at, k) => ({ at, make: () => ({ kind: 'smoke', x: TIPS[k % 2][0], y: TIPS[k % 2][1], dx: (k - 1) * 1.5, dy: -5, life: 900 }) })),
  },
  alert: {
    length: 900,
    frame: (t) => ({
      y: t < 300 ? -2 * Math.sin((Math.PI * t) / 300) : 0,
      eyes: 'wide',
      mouth: 'o',
      g: 1.3,
      bolts: t < 500 ? 1 : 0,
    }),
    particles: () => [{ at: 0, make: () => ({ kind: 'bang', x: 7.5, y: -1, dx: 0, dy: -2, life: 900 }) }],
  },
  charge: {
    length: 1500,
    frame: (t, o) => {
      const level = o.level || 3;
      const crouch = clamp(t / 300);
      return {
        sx: t < 300 ? 1 + 0.1 * crouch : 1,
        sy: t < 300 ? 1 - 0.14 * crouch : 1,
        y: t >= 300 && t < 1300 ? -(1 + level * 0.3) * Math.sin((Math.PI * (t - 300)) / 1000) : 0,
        band: t >= 200 && t < 900 ? 17 - ((t - 200) / 700) * 20 : null,
        g: t < 300 ? 0.2 : t < 900 ? 0.2 + 1.1 * out((t - 300) / 600) : 1.3 - 0.3 * clamp((t - 900) / 600),
        bolts: t >= 300 && t < 1100 && Math.floor(t / 60) % 2 ? 1 : 0,
        wings: t >= 300 && t < 1100 && Math.floor(t / 90) % 2 ? -1 : 0,
        hatY: t < 300 ? -6 : Math.min(0, Math.round(-6 * (1 - out((t - 300) / 350)))),
      };
    },
    particles: (o) => {
      const level = o.level || 3;
      const rings = level >= 4 ? [300, 480, 660] : [300, 480];
      return [...rings.map((at) => ({ at, make: ring })), { at: 500, make: () => radial(6 + level * 3, 800, 6 + level) }];
    },
  },
  sleep: {
    loop: 3600,
    frame: (t) => ({ y: 0.3 * wave(t, 3600), sy: 1 + 0.03 * wave(t, 3600), eyes: 'sleep', g: 0, wings: 1 }),
    particles: () => [{ at: 500, every: 1800, make: (k) => ({ kind: 'z', x: 12, y: 2, dx: 3 + noise(k), dy: -7, life: 2200 }) }],
  },
  poke: {
    length: 700,
    frame: (t) => {
      const s = 0.18 * Math.exp(-t / 160) * Math.cos(t / 38);
      return { sx: 1 + s, sy: 1 - s, eyes: t < 500 ? 'happy' : 'open', mouth: 'smile', bolts: t < 200 ? 1 : 0 };
    },
    particles: () => [{ at: 40, make: () => ({ kind: 'heart', x: 7.5, y: 2, dx: 1.5, dy: -6, life: 1000 }) }],
  },
  assemble: {
    length: 1100,
    frame: (t) => ({ fly: t / 650, g: t < 650 ? 0 : FLICKER[Math.min(5, Math.floor((t - 650) / 70))] }),
  },
  // How charged up he is at an effort level, 1 (low) to 5 (max); 0 means auto.
  power: {
    loop: 2400,
    frame: (t, o) => {
      const level = o.level || 3;
      return {
        eyes: level === 1 ? 'lid' : 'open',
        g: 0.55 + level * 0.15,
        y: level === 5 ? -1 + 0.4 * wave(t, 1200) : (-0.5 * (1 - Math.cos((2 * Math.PI * t) / 2400))) / 2,
        bolts: level >= 3 && Math.floor(t / 90) % (7 - level) === 0 ? 1 : level >= 4 ? 0.4 : 0,
        band: level === 5 ? 17 - ((t % 1200) / 1200) * 20 : null,
        wings: level >= 4 && Math.floor(t / (level === 5 ? 80 : 160)) % 2 ? -1 : 0,
      };
    },
    particles: (o) => {
      const level = o.level || 3;
      const every = [0, 0, 0, 700, 320, 140][level];
      return [
        ...(every ? [{ at: 0, every, make: (k) => spark(TIPS[k % 2], noise(k + level)) }] : []),
        ...(level === 5 ? [{ at: 0, every: 600, make: (k) => ({ kind: 'star', x: 1 + noise(k) * 14, y: 6 + noise(k + 5) * 6, dx: 0, dy: -6, life: 800 }) }] : []),
        ...(level === 1 ? [{ at: 400, every: 2400, make: (k) => ({ kind: 'z', x: 12, y: 2, dx: 3 + noise(k), dy: -7, life: 2200 }) }] : []),
      ];
    },
  },
};

// The frame of a move at t ms since it started. o: { sprite, glow, look, hat, level }.
export function frameAt(name, t, o) {
  const move = MOVES[name];
  const time = move.loop ? t % move.loop : Math.min(t, move.length);
  const hat = o.hat === 'gemini' && Math.floor(time / 500) % 2 ? TWINKLE : HATS[o.hat];
  const f = {
    eyes: 'open',
    pupil: o.look ?? { x: 1, y: 1 },
    g: 1,
    mouth: 'line',
    wings: 0,
    bolts: 0,
    tap: null,
    tint: null,
    band: null,
    hatY: 0,
    x: 0,
    y: 0,
    sx: 1,
    sy: 1,
    ...move.frame(time, o),
    hat,
  };
  const posed = pose(o.sprite, o.glow, f);
  return {
    pixels: f.fly !== undefined && f.fly < 1 ? scatter(posed, f.fly) : posed,
    move: { x: f.x, y: f.y, sx: f.sx, sy: f.sy },
    done: !move.loop && t >= move.length,
  };
}

// Particles a move gives off in [from, to) ms since it started: { kind, x, y, dx, dy, life }.
export function emits(name, from, to, o) {
  const found = [];
  for (const s of MOVES[name].particles?.(o) ?? []) {
    if (!s.every) {
      if (from <= s.at && s.at < to) found.push(s.make(0));
      continue;
    }
    for (let k = Math.max(0, Math.ceil((from - s.at) / s.every)); s.at + k * s.every < to; k++) found.push(s.make(k));
  }
  return found.flat();
}
