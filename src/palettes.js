// Spark's two looks: the colors of the banner, Sparky, the header skin and the
// Windows Terminal background. Gradients run light to dark, top-left to bottom-right.
export const THEMES = {
  ultraviolet: {
    gradient: [
      [0x38, 0xe8, 0xff],
      [0x43, 0x85, 0xff],
      [0x66, 0x5c, 0xff],
      [0xb4, 0x5c, 0xff],
    ],
    bolt: [0x7d, 0xf9, 0xff],
    antenna: [0xa5, 0xb4, 0xfc],
    wing: [0x7d, 0xd3, 0xfc],
    glow: [0x38, 0xe8, 0xff],
    dim: [0x92, 0x9d, 0xb3],
    background: {
      from: [0x0b, 0x0d, 0x14],
      to: [0x1d, 0x10, 0x3a],
      glows: [
        { color: [0x43, 0x85, 0xff], x: 0.85, y: 0.1, strength: 0.22 },
        { color: [0xb4, 0x5c, 0xff], x: 0.1, y: 0.95, strength: 0.2 },
      ],
    },
    scheme: 'Spark',
    ccTheme: 'spark',
  },
  teal: {
    gradient: [
      [0x5e, 0xea, 0xd4],
      [0x14, 0xb8, 0xa6],
      [0x22, 0xc5, 0x5e],
      [0x39, 0xff, 0x14],
    ],
    bolt: [0xb9, 0xff, 0x66],
    antenna: [0x5e, 0xea, 0xd4],
    wing: [0x99, 0xf6, 0xe4],
    glow: [0x39, 0xff, 0x14],
    dim: [0x8f, 0xb8, 0xae],
    background: {
      from: [0x03, 0x12, 0x0f],
      to: [0x06, 0x2e, 0x24],
      glows: [
        { color: [0x14, 0xb8, 0xa6], x: 0.85, y: 0.1, strength: 0.22 },
        { color: [0x39, 0xff, 0x14], x: 0.1, y: 0.95, strength: 0.12 },
      ],
    },
    scheme: 'Spark Teal',
    ccTheme: 'spark-teal',
  },
};

export const THEME_NAMES = Object.keys(THEMES);

export const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

export function gradientAt(stops, t) {
  const n = stops.length - 1;
  const i = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
  return mix(stops[i], stops[i + 1], Math.min(1, Math.max(0, t * n - i)));
}
