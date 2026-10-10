// F3: spark map. The calls between functions in the JS/TS files changed since the last
// snapshot. Read from the text, not a parser: calls through aliases, objects or dynamic
// dispatch don't show, and two functions with one name can join the wrong edge.
import { fileDiffs, listSnapshots } from '../plugin/hooks/snapshot.ts';

const CODE = /\.(m?[jt]sx?|cjs|cts|mts)$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.js'];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'typeof', 'await', 'new', 'super', 'import', 'export', 'delete', 'void']);
const NAME = '[A-Za-z_$][\\w$]*';
const DECLARATIONS = [
  new RegExp(`\\bfunction\\s*\\*?\\s*(${NAME})\\s*(?=\\()`, 'g'),
  new RegExp(`\\b(?:const|let|var)\\s+(${NAME})\\s*(?::[^=\\n]+)?=\\s*(?:async\\s+)?(?=function\\b|\\(|${NAME}\\s*=>)`, 'g'),
  new RegExp(`^[ \\t]*(?:(?:async|static|public|private|protected|get|set)\\s+)*(${NAME})\\s*(?=\\([^()]*\\)\\s*(?::[^{=;\\n]+)?\\{)`, 'gm'),
];

// Strings and comments become spaces, so neither braces nor words inside them count.
function blank(text) {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

function closing(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

// Where a definition's body runs: a block in braces, or an arrow's expression to the end of
// its statement. undefined when what follows the name isn't a function after all.
function body(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && c === '{') return [i, closing(code, i)];
    else if (depth === 0 && code.startsWith('=>', i)) {
      let j = i + 2;
      while (/\s/.test(code[j] ?? '')) j++;
      if (code[j] === '{') return [j, closing(code, j)];
      let d = 0;
      for (let k = j; k < code.length; k++) {
        if ('([{'.includes(code[k])) d++;
        else if (')]}'.includes(code[k])) d--;
        if (d < 0 || (d === 0 && (code[k] === '\n' || code[k] === ';'))) return [j, k];
      }
      return [j, code.length];
    } else if (depth === 0 && (c === ';' || c === '\n') && !/function/.test(code.slice(from, i))) return undefined;
  }
  return undefined;
}

function definitions(code) {
  const found = [];
  for (const pattern of DECLARATIONS)
    for (const m of code.matchAll(pattern)) {
      if (KEYWORDS.has(m[1])) continue;
      const range = body(code, m.index + m[0].length);
      if (range && !found.some((d) => d.start === range[0])) found.push({ name: m[1], at: m.index, start: range[0], end: range[1] });
    }
  return found.sort((a, b) => a.at - b.at);
}

// Edges from the functions of the `callers` files to functions in the same file, or in a
// file of `files` that it imports.
export function callGraph(files, callers = Object.keys(files)) {
  const defs = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, definitions(blank(text))]));
  const edges = [];
  for (const path of callers) {
    const code = blank(files[path]);
    const reach = imports(path, files[path])
      .map((target) => EXTENSIONS.map((ext) => target + ext).find((p) => p in files))
      .filter(Boolean);
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${NAME})\\s*\\(`, 'g'))) {
      if (KEYWORDS.has(m[1])) continue;
      const caller = defs[path].filter((d) => d.start < m.index && m.index < d.end).sort((a, b) => b.start - a.start)[0];
      if (!caller) continue;
      const home = defs[path].some((d) => d.name === m[1]) ? path : reach.find((p) => defs[p].some((d) => d.name === m[1]));
      if (!home) continue;
      const edge = { from: `${path}:${caller.name}`, to: `${home}:${m[1]}` };
      if (!edges.some((e) => e.from === edge.from && e.to === edge.to)) edges.push(edge);
    }
  }
  const order = (e) => Object.keys(files).indexOf(e.from.slice(0, e.from.lastIndexOf(':')));
  return edges.sort((a, b) => order(a) - order(b));
}

// Relative imports a file names, as paths from the repo root.
function imports(path, text) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return [...text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => {
    const parts = [];
    for (const part of `${dir}/${m[1]}`.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  });
}

// `run` as the snapshot code takes it; `read(path)` reads a file by absolute path.
export async function codeMap({ run, read }) {
  const [snap] = await listSnapshots(run);
  // HEAD is no stand-in: its blobs went through line-ending conversion, a snapshot's didn't.
  if (!snap) return 'No snapshot yet: Spark takes one before each prompt in a session. Run spark map after a turn.';
  const since = `snapshot turn-${snap.n}`;
  const top = (await run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim();
  const changed = (await fileDiffs(run, snap.sha)).filter((d) => (d.kind === 'modified' || d.kind === 'new') && CODE.test(d.path)).map((d) => d.path);
  if (!changed.length) return `No JS/TS files changed since ${since}.`;
  const files = {};
  const load = (path) => {
    try {
      files[path] = read(`${top}/${path}`);
      return true;
    } catch {
      return false;
    }
  };
  changed.forEach(load);
  for (const path of changed)
    for (const target of imports(path, files[path] ?? ''))
      EXTENSIONS.some((ext) => files[target + ext] !== undefined || load(target + ext));
  const callers = changed.filter((p) => files[p] !== undefined);
  const edges = callGraph(files, callers);
  const lines = [`Calls in the ${callers.length} JS/TS file${callers.length === 1 ? '' : 's'} changed since ${since}:`];
  for (const path of callers) {
    lines.push(path);
    const mine = edges.filter((e) => e.from.startsWith(`${path}:`));
    if (!mine.length) lines.push('  (no calls between functions it can see)');
    for (const caller of [...new Set(mine.map((e) => e.from))].sort()) {
      const callees = mine.filter((e) => e.from === caller).map((e) => {
        const [file, fn] = [e.to.slice(0, e.to.lastIndexOf(':')), e.to.slice(e.to.lastIndexOf(':') + 1)];
        return file === path ? fn : `${fn} (${file})`;
      });
      lines.push(`  ${caller.slice(path.length + 1)} → ${callees.join(', ')}`);
    }
  }
  return lines.join('\n');
}
