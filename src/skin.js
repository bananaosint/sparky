// Claude Code draws its crab as the first columns of three header rows, each
// row opened with this color and a newline. Spark runs Claude Code in a
// pseudo-terminal and redraws those cells as Sparky; everything else passes through.
import { THEMES } from './palettes.js';

const CRAB_FG = '\x1b[38;2;215;119;87m';
const ROW = /\x1b\[38;2;215;119;87m(\r?\n)((?:\x1b\[[0-9;]*m|[ ▀-▟])+)/g;
const REGION = /^(\r?\n)?(?:\x1b\[[0-9;]*m|[ ▀-▟])*/;
const PARTIAL_ESCAPE = /^\x1b(\[[0-9;?<>]*)?$/;
const SGR = /\x1b\[[0-9;]*m/g;

const EYE = [0xf8, 0xfa, 0xfc];

// Sparky in 3×9 cells, [glyph, foreground, background, bold], in the theme's gradient.
function sparky(theme) {
  const [bolt, blue, indigo, violet] = THEMES[theme].gradient;
  return [
    [[' '], ['ϟ', bolt, null, true], ['▗', blue], ['▄', blue], ['▄', blue], ['▄', blue], ['▖', blue], ['ϟ', bolt, null, true], [' ']],
    [['◂', bolt], ['▐', blue], ['◕', EYE, blue], [' ', null, blue], ['▾', EYE, blue], [' ', null, blue], ['◕', EYE, blue], ['▌', blue], ['▸', bolt]],
    [[' '], [' '], ['▝', indigo], ['▀', indigo], ['▀', violet], ['▀', violet], ['▘', violet], [' '], [' ']],
  ];
}

const rgb = (code, [r, g, b]) => `\x1b[${code};2;${r};${g};${b}m`;
const paint = ([ch, fg, bg, bold]) =>
  (fg || bg || bold ? `${bold ? '\x1b[1m' : ''}${fg ? rgb(38, fg) : ''}${bg ? rgb(48, bg) : ''}${ch}\x1b[m` : ch);

// Which crab row this is: the feet have no full blocks; the top row starts with an arm.
function rowOf(visible) {
  if (!visible.includes('█')) return 2;
  return /^( ▐|▗▟)/.test(visible) ? 0 : 1;
}

function redraw(rows, newline, region) {
  const visible = region.replace(SGR, '');
  const cells = rows[rowOf(visible)].map(paint);
  const pad = ' '.repeat(Math.max(0, [...visible].length - cells.length));
  // Colors set after the crab's last cell belong to the text that follows.
  const trailing = region.slice(region.search(/(?:\x1b\[[0-9;]*m)*$/));
  return `${newline}${cells.join('')}${pad}\x1b[m${trailing}`;
}

// Where to stop emitting: before a crab row or escape sequence that hasn't fully arrived.
function holdFrom(text) {
  let cut = text.length;
  const esc = text.lastIndexOf('\x1b');
  if (esc >= 0 && PARTIAL_ESCAPE.test(text.slice(esc))) cut = esc;
  const crab = text.lastIndexOf(CRAB_FG);
  if (crab >= 0) {
    const after = text.slice(crab + CRAB_FG.length);
    const stop = REGION.exec(after)[0].length;
    if (stop === after.length || PARTIAL_ESCAPE.test(after.slice(stop))) cut = Math.min(cut, crab);
  }
  return cut;
}

export function createSkin(write, { theme = 'ultraviolet', setTimer = setTimeout, clearTimer = clearTimeout, holdMs = 20 } = {}) {
  const rows = sparky(theme);
  let pending = '';
  let timer;
  const emit = (text) => {
    if (text) write(text.replace(ROW, (_match, newline, region) => redraw(rows, newline, region)));
  };
  const flush = () => {
    timer = undefined;
    const text = pending;
    pending = '';
    emit(text);
  };
  return (data) => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const text = pending + data;
    const cut = holdFrom(text);
    pending = text.slice(cut);
    emit(text.slice(0, cut));
    // A held tail goes out after a moment even if nothing completes it.
    if (pending) timer = setTimer(flush, holdMs);
  };
}
