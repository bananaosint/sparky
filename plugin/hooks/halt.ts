// F10: two build or test failures in a row halt edits until a post-mortem is written.
import { splitCommand } from './gate'

export const HALT_AFTER = 2

export const HALT_REASON = '✦ halted: 2 consecutive build/test failures. /spark:postmortem, then /spark-unhalt'

export const HALT_CONTEXT =
  "<spark-halt>Spark halted after two consecutive build or test failures. Edits are blocked except under docs/postmortems/. Don't try fixes. When the user runs /spark:postmortem, write the post-mortem.</spark-halt>"

const BUILDS = ['npm run build', 'pnpm build', 'pnpm run build', 'yarn build', 'yarn run build', 'tsc', 'vite build', 'dotnet build', 'msbuild', 'cargo build', 'go build'].map((p) => p.split(' '))
// Words that run the next one as the command.
const RUNNERS = new Set(['npx', 'sudo', 'call', '&'])

// Whether a line's last command is a build: its failure is then the build's, where an earlier
// build's failure would have stopped the line, and the test gate counts failing tests itself.
export function isBuild(command: string) {
  const last = splitCommand(command).at(-1)?.words.map((w) => w.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/, '')) ?? []
  while (last.length > 1 && RUNNERS.has(last[0]!)) last.shift()
  // `build:prod` and other build:* scripts count; `build-docs` doesn't.
  return BUILDS.some((p) => p.every((w, i) => last[i] === w || (i === p.length - 1 && w === 'build' && last[i]?.startsWith('build:'))))
}

// `..` and `.` folded away, so a path can't climb out of docs/postmortems/.
function resolved(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && (part !== '' || parts.length === 0)) parts.push(part)
  }
  return parts.join('/').toLowerCase()
}

export function editAllowedWhileHalted(file: string, top: string) {
  const absolute = /^([a-z]:)?[\\/]/i.test(file) ? file : `${top}/${file}`
  return resolved(absolute).startsWith(`${resolved(top)}/docs/postmortems/`)
}
