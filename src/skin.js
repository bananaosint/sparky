// Claude Code draws its crab as the first columns of three header rows, each
// row opened with this color and a newline. Spark runs Claude Code in a
// pseudo-terminal and redraws those cells as Sparky; everything else passes through.
const CRAB_FG = '\x1b[38;2;215;119;87m';
const ROW = /\x1b\[38;2;215;119;87m(\r?\n)((?:\x1b\[[0-9;]*m|[ ▀-▟])+)/g;
const REGION = /^(\r?\n)?(?:\x1b\[[0-9;]*m|[ ▀-▟])*/;
const PARTIAL_ESCAPE = /^\x1b(\[[0-9;?<>]*)?$/;
const SGR = /\x1b\[[0-9;]*m/g;

const BOLT = [0x38, 0xe8, 0xff];
const BLUE = [0x43, 0x85, 0xff];
const INDIGO = [0x66, 0x5c, 0xff];
const VIOLET = [0xb4, 0x5c, 0xff];
const EYE = [0xf8, 0xfa, 0xfc];

// Sparky in 3×9 cells: [glyph, foreground, background, bold].
const SPARKY = [
  [[' '], ['ϟ', BOLT, null, true], ['▗', BLUE], ['▄', BLUE], ['▄', BLUE], ['▄', BLUE], ['▖', BLUE], ['ϟ', BOLT, null, true], [' ']],
  [['◂', BOLT], ['▐', BLUE], ['◕', EYE, BLUE], [' ', null, BLUE], ['▾', EYE, BLUE], [' ', null, BLUE], ['◕', EYE, BLUE], ['▌', BLUE], ['▸', BOLT]],
  [[' '], [' '], ['▝', INDIGO], ['▀', INDIGO], ['▀', VIOLET], ['▀', VIOLET], ['▘', VIOLET], [' '], [' ']],
];

const rgb = (code, [r, g, b]) => `\x1b[${code};2;${r};${g};${b}m`;
const paint = ([ch, fg, bg, bold]) =>
  (fg || bg || bold ? `${bold ? '\x1b[1m' : ''}${fg ? rgb(38, fg) : ''}${bg ? rgb(48, bg) : ''}${ch}\x1b[m` : ch);

// Which crab row this is: the feet have no full blocks; the top row starts with an arm.
function rowOf(visible) {
  if (!visible.includes('█')) return 2;
  return /^( ▐|▗▟)/.test(visible) ? 0 : 1;
}

function redraw(_match, newline, region) {
  const visible = region.replace(SGR, '');
  const cells = SPARKY[rowOf(visible)].map(paint);
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

export function createSkin(write, { setTimer = setTimeout, clearTimer = clearTimeout, holdMs = 20 } = {}) {
  let pending = '';
  let timer;
  const emit = (text) => {
    if (text) write(text.replace(ROW, redraw));
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
