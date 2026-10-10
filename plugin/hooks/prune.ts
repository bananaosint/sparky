// F5: keep long command output and generated files out of the context window.
import { ANSI } from './failure'

const MAX_LINES = 200
const HEAD = 40
const TAIL = 120

// undefined when the output is short enough to pass as is. A `\r` redraw keeps only
// what was last drawn on its line, as a terminal shows it.
export function pruneOutput(text: string, savedAs: string): string | undefined {
  const lines = text
    .replace(ANSI, '')
    .replace(/\r?\n$/, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
  if (lines.length <= MAX_LINES) return undefined
  return [...lines.slice(0, HEAD), `[spark: pruned ${lines.length - HEAD - TAIL} lines → ${savedAs}]`, ...lines.slice(-TAIL)].join('\n')
}

const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock'])
// Generated folders at any depth. Not bin/: in many repos (this one included) it holds source.
const GENERATED = new Set(['node_modules', 'dist', 'obj'])

// Why a Read of `path` is refused, or undefined when it may go ahead. Only folders below the
// repo's top count, so a repo that lives under D:\build\ stays readable; build/ only at the
// top, since a nested one (scripts/build/) is often source.
export function readDenied(path: string, top: string): string | undefined {
  const file = path.replace(/\\/g, '/')
  const root = top.replace(/\\/g, '/').replace(/\/$/, '')
  const absolute = /^([a-z]:)?\//i.test(file)
  const inside = !absolute ? file : file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : undefined
  const name = file.split('/').pop() ?? ''
  const dirs = inside?.split('/').slice(0, -1) ?? []
  const why = LOCKFILES.has(name)
    ? 'it is a lockfile'
    : /\.min\./.test(name)
      ? 'it is minified'
      : dirs.some((p) => GENERATED.has(p)) || dirs[0] === 'build'
        ? 'it is generated output or a dependency'
        : undefined
  return why && `✦ Spark doesn't read ${name}: ${why}, which fills the context without helping. Ask the user if you need it.`
}
