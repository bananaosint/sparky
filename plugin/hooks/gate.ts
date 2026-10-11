// F1: the command gate. Shell commands that could do lasting damage are blocked, or held for
// the person with a dry run of what they'd do. It never allows: anything it lets through still
// meets Claude Code's own permissions. It reads text, so obfuscated commands can slip past.

export type Shell = 'bash' | 'powershell'
export type Preview = { kind: 'run'; argv: string[] } | { kind: 'count'; paths: string[] }
export type Verdict = { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string; previews: Preview[] }
// `branch`: the one checked out, for a push that names none.
export type GateContext = { repo: string; home: string; branch?: string }
// One command of a line; `pipe` when its output feeds the next.
export type Segment = { words: string[]; pipe: boolean }

const BLOCKED = '✦ spark gate: blocked: '

// Splits on && || ; | & and newlines outside quotes (not the & of 2>&1 or &>); quotes are
// removed from the words.
export function splitCommand(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: string | null = null
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (pipe: boolean) => {
    endWord()
    if (words.length) segments.push({ words, pipe })
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && (command[i + 1] === '"' || command[i + 1] === '\\')) word += command[++i]
      else word += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (two === '&&' || two === '||') {
      endSegment(false)
      i++
    } else if (c === ';' || c === '\n' || c === '\r' || (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) endSegment(false)
    else if (c === '|') endSegment(true)
    else if (/\s/.test(c)) endWord()
    else {
      word += c
      inWord = true
    }
  }
  endSegment(false)
  return segments
}

const name = (word: string) =>
  word
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|com)$/, '')

const DOWNLOAD = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'iex', 'invoke-expression', 'powershell', 'pwsh'])
const NETWORK = new Set([...DOWNLOAD, 'ssh', 'scp', 'sftp'])
const DELETE = new Set(['rm', 'del', 'erase', 'remove-item', 'ri', 'rd', 'rmdir', 'unlink'])
const MOVE = new Set(['mv', 'move', 'move-item', 'mi'])
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const DISK = new Set(['format', 'format-volume', 'diskpart', 'bcdedit', 'clear-disk'])
const REGISTRY_WRITE = new Set([
  ...['new-item', 'set-item', 'set-itemproperty', 'new-itemproperty', 'remove-item', 'remove-itemproperty', 'rename-item', 'rename-itemproperty', 'copy-item', 'move-item'],
  ...['ni', 'si', 'sp', 'rp', 'ri', 'rni', 'rnp', 'cpi', 'mi'],
])
const INSTALL: Record<string, string[]> = {
  npm: ['install', 'i', 'add', 'ci'],
  pnpm: ['add', 'install', 'i'],
  yarn: ['add'],
  bun: ['add', 'install', 'i'],
  pip: ['install'],
  pip3: ['install'],
  winget: ['install'],
  choco: ['install'],
  scoop: ['install'],
  cargo: ['add', 'install'],
  dotnet: ['add'],
}
// Wrappers and shell keywords that put the real command in the next word.
const PREFIX = new Set(['sudo', '&', 'call', 'command', 'exec', 'time', 'nohup', 'then', 'do', 'else', 'elif', '!', '{', '('])
// PowerShell parameters whose next word is a value, not a path.
const VALUED = new Set(['-filter', '-include', '-exclude', '-erroraction', '-ea', '-name', '-value', '-scope', '-outfile'])
const SECRETS = [/(%appdata%|\$env:appdata|\$\{?appdata\}?|appdata[\\/]roaming)[\\/]spark\b/i, /\.claude[\\/]+["']?\.cred/i, /\b(cmdkey|vaultcmd)\b/i]
// Spark's mission records: a forged line there would be reported as a real test result.
const RECORDS = /\.spark[\\/]+["']?(gate\.jsonl|missions)\b/i
// Code fetched and run in one go: a shell fed by a command or process substitution that
// downloads, and Invoke-Expression of a download.
const DOWNLOAD_RUN = [
  /\b(sh|bash|zsh|dash|source)\b[^|;&\n]*(\$\(|<\(|`)\s*(curl|wget)\b/i,
  /\b(iex|invoke-expression)\b[\s(]*(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object\s+net\.webclient)\b/i,
]

// The command a segment runs: past wrappers, keywords and VAR=value, outside ( and {.
function commandStart(words: string[]) {
  let start = 0
  while (start < words.length - 1 && (PREFIX.has(words[start]!.toLowerCase()) || /^[A-Za-z_]\w*=/.test(words[start]!))) start++
  return start
}

// `.` and `..` folded away, lowercased, forward slashes; `c:/` for a drive root.
function fold(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part !== '.' && part !== '') parts.push(part)
  }
  const folded = `${/^[\\/]/.test(path) ? '/' : ''}${parts.join('/').toLowerCase()}`
  return /^[a-z]:$/.test(folded) ? `${folded}/` : folded || '/'
}

// Where a path argument points, or undefined when the gate can't tell.
function resolveTarget(arg: string, ctx: GateContext, moved: boolean): string | undefined {
  let p = arg.replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i, ctx.home).replace(/\\/g, '/')
  if (/[$`%]/.test(p)) return undefined
  if (/^\/[a-z](\/|$)/i.test(p)) p = `${p[1]}:/${p.slice(3)}`
  if (/^[a-z]:/i.test(p) || p.startsWith('/')) return fold(p)
  return moved ? undefined : fold(`${ctx.repo}/${p}`)
}

function deleteTargets(cmd: string, args: string[], shell: Shell) {
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const lower = a.toLowerCase()
    if (lower === '-path' || lower === '-literalpath') targets.push(args[++i] ?? '')
    else if (VALUED.has(lower)) i++
    else if (a.startsWith('-') || (cmd !== 'rm' && /^\/[a-z]$/i.test(a))) continue
    else targets.push(a)
  }
  // PowerShell takes several paths as one comma-separated array.
  return shell === 'powershell' ? targets.flatMap((t) => t.split(',')).filter(Boolean) : targets
}

const recursive = (args: string[]) =>
  args.some((a) => /^-[a-z]{0,2}r[a-z]{0,2}$/i.test(a) && !/^-fo/i.test(a)) || args.some((a) => /^(--recursive|-rec\w*(:\$true)?|\/s)$/i.test(a))

function host(args: string[]) {
  for (const a of args) {
    if (/^[a-z]+:\/\//i.test(a)) {
      try {
        return new URL(a).host
      } catch {
        return a
      }
    }
  }
  const target = args.find((a) => !a.startsWith('-'))
  return target?.replace(/^.*@/, '').replace(/:.*$/, '') ?? 'unknown host'
}

function git(args: string[], ctx: GateContext): Verdict | { kind: 'none' } {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  const options = rest.filter((a) => a.startsWith('-'))
  const plain = rest.filter((a) => !a.startsWith('-'))
  const ask = (reason: string, ...previews: Preview[]): Verdict => ({ kind: 'ask', reason, previews })
  const diffStat: Preview = { kind: 'run', argv: ['git', 'diff', '--stat', 'HEAD'] }
  switch (sub) {
    case 'push': {
      const force = options.some((o) => /^(-f|--force.*)$/.test(o) || /^-[a-z]*f/.test(o)) || plain.some((p) => p.startsWith('+'))
      // With no refspec after the remote, git pushes the branch checked out.
      const target = plain.length > 1 ? plain.map((p) => /^\+?([^:]*:)?(refs\/heads\/)?(main|master)$/.exec(p)?.[3]).find(Boolean) : ctx.branch
      if (force && (target === 'main' || target === 'master')) return { kind: 'deny', reason: `${BLOCKED}force push to ${target}` }
      return ask(force ? 'git push --force rewrites the remote branch' : 'git push publishes commits', { kind: 'run', argv: ['git', 'log', '--oneline', '@{u}..HEAD'] })
    }
    case 'clean': {
      if (options.some((o) => o === '-n' || o === '--dry-run')) return { kind: 'none' }
      // Only the flags that change what the dry run lists: the rest come from the command being judged.
      const scope = [...new Set(options.filter((o) => /^-[a-zA-Z]+$/.test(o)).flatMap((o) => [...o.slice(1)]))].filter((c) => 'dxX'.includes(c))
      return ask('git clean deletes untracked files', { kind: 'run', argv: ['git', 'clean', '-n', ...scope.map((c) => `-${c}`)] })
    }
    case 'reset':
      return options.includes('--hard') ? ask('git reset --hard discards uncommitted changes', diffStat) : { kind: 'none' }
    case 'checkout':
      return rest.includes('--') || plain.includes('.') ? ask('git checkout discards uncommitted changes', diffStat) : { kind: 'none' }
    case 'restore':
      return !options.includes('--staged') || options.includes('--worktree') ? ask('git restore discards uncommitted changes', diffStat) : { kind: 'none' }
    case 'rebase':
      return options.some((o) => /^--(continue|abort|skip|quit)$/.test(o))
        ? { kind: 'none' }
        : ask('git rebase rewrites commits', { kind: 'run', argv: ['git', 'log', '--oneline', `${plain[0] ?? '@{u}'}..HEAD`] })
    case 'branch':
      return options.includes('-D') && plain[0] ? ask(`git branch -D deletes ${plain[0]}, merged or not`, { kind: 'run', argv: ['git', 'log', '--oneline', `HEAD..${plain[0]}`] }) : { kind: 'none' }
    default:
      return { kind: 'none' }
  }
}

function segment(raw: string[], next: Segment | undefined, pipe: boolean, shell: Shell, ctx: GateContext, moved: boolean): Verdict | { kind: 'none' } {
  // `(rm -rf x)` and `{ rm -rf x; }` run what's inside.
  const words = raw.map((w, i) => (i === 0 ? w.replace(/^[({]+(?=.)/, '') : w)).map((w, i, all) => (i === all.length - 1 ? w.replace(/(?<=.)[)}]+$/, '') : w)).filter((w) => w !== '}' && w !== ')')
  const start = commandStart(words)
  const cmd = name(words[start] ?? '')
  const args = words.slice(start + 1)
  const deny = (what: string): Verdict => ({ kind: 'deny', reason: BLOCKED + what })
  const ask = (reason: string, ...previews: Preview[]): Verdict => ({ kind: 'ask', reason, previews })

  if (DISK.has(cmd)) return deny(`${cmd} changes disks or boot settings`)
  if (cmd === 'reg' && /^(add|delete)$/i.test(args[0] ?? '')) return deny(`reg ${args[0]!.toLowerCase()} changes the registry`)
  if (cmd === 'set-executionpolicy') return deny('Set-ExecutionPolicy changes what scripts may run')
  if (REGISTRY_WRITE.has(cmd) && args.some((a) => /^(hklm:|registry::(hkey_local_machine|hklm)\b)/i.test(a))) return deny(`${cmd} writes to HKLM`)
  if ((cmd === 'powershell' || cmd === 'pwsh') && args.some((a) => /^[-/](e|ec|en[a-z]*)$/i.test(a))) return deny('encoded PowerShell commands can\'t be read')
  const into = next && name(next.words[commandStart(next.words)] ?? '')
  if (DOWNLOAD.has(cmd) && pipe && into && SHELLS.has(into)) return deny(`a download piped into ${into}`)
  if (cmd === 'iex' || cmd === 'invoke-expression') {
    const text = args.join(' ').toLowerCase()
    if ([...DOWNLOAD].some((d) => new RegExp(`\\b${d}\\b`).test(text)) || text.includes('downloadstring')) return deny('downloaded code run with Invoke-Expression')
    return ask("can't analyze: Invoke-Expression runs text as code")
  }
  // A shell given a command string (`bash -lc`, `powershell -Command` or a bare string,
  // `cmd /c`): judge the string itself.
  const posix = cmd === 'bash' || cmd === 'sh' || cmd === 'zsh' || cmd === 'dash'
  const ps = cmd === 'powershell' || cmd === 'pwsh'
  const flag = args.findIndex((a) => (posix ? /^-[a-z]*c$/i : ps ? /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i : /^\/[ck]$/i).test(a))
  const inner = flag >= 0 ? flag + 1 : ps ? args.findIndex((a) => !a.startsWith('-')) : -1
  if ((posix || ps || cmd === 'cmd') && inner >= 0 && args[inner]) {
    return classify(args.slice(inner).join(' '), posix ? 'bash' : 'powershell', ctx) ?? { kind: 'none' }
  }

  if (DELETE.has(cmd) || MOVE.has(cmd)) {
    if (args.some((a) => a.includes('$(') || (shell === 'bash' && a.includes('`')))) return ask(`can't analyze: ${cmd} with a command substitution`)
    const targets = deleteTargets(cmd, args, shell)
    if (DELETE.has(cmd) && recursive(args)) {
      for (const t of targets) {
        const where = resolveTarget(t, ctx, moved)
        if (!where) continue
        const repo = fold(ctx.repo)
        const outside = where !== repo && !where.startsWith(`${repo}/`)
        if (/^([a-z]:)?\/$/.test(where) || where === fold(ctx.home) || outside)
          return deny(`recursive delete of ${where}${/^([a-z]:)?\/$/.test(where) ? ', a drive root' : where === fold(ctx.home) ? ', your home folder' : ', outside the repo'}`)
      }
    }
    const counted = MOVE.has(cmd) ? targets.slice(0, -1) : targets
    const previews: Preview[] = moved || !counted.length ? [] : [{ kind: 'count', paths: counted }]
    return ask(`${MOVE.has(cmd) ? 'moves' : 'deletes'} ${targets.join(', ') || 'files'}`, ...previews)
  }
  if (cmd === 'git') return git(args, ctx)
  const install = INSTALL[cmd]
  if (install?.includes((args[0] ?? '').toLowerCase()) && (cmd !== 'dotnet' || args[1] === 'package')) {
    const names = args.slice(cmd === 'dotnet' ? 2 : 1).filter((a) => !a.startsWith('-'))
    return ask(`installs ${names.join(', ') || 'dependencies'}: network, lockfile change`)
  }
  if (NETWORK.has(cmd)) return ask(`network: ${host(args)}`)
  if (args.some((a) => /^-force$/i.test(a))) return ask(`${cmd} -Force`)
  return { kind: 'none' }
}

// F2: spark:compliance-reviewer ends its report with `VERDICT: PASS|FAIL <branch>` as the last line.
export function parseVerdict(report: string): { pass: boolean; branch: string } | undefined {
  const last = report.trim().split('\n').at(-1)?.trim() ?? ''
  const m = /^VERDICT:\s*(PASS|FAIL)\s+(\S+)$/.exec(last)
  return m ? { pass: m[1] === 'PASS', branch: m[2]! } : undefined
}

// The branches a line's git merge, cherry-pick, rebase or `pull .` would bring commits in from:
// ranges split, `refs/heads/` and `~2`-style suffixes dropped.
export function mergeTargets(command: string): string[] {
  return splitCommand(command).flatMap(({ words }) => {
    const start = commandStart(words)
    if (name(words[start] ?? '') !== 'git') return []
    let i = start + 1
    while (i < words.length && words[i]!.startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1
    const sub = words[i]
    const refs = words.slice(i + 1).filter((w) => !w.startsWith('-'))
    const taken = sub === 'merge' || sub === 'cherry-pick' || sub === 'rebase' ? refs : sub === 'pull' && refs[0] === '.' ? refs.slice(1) : []
    return taken
      .flatMap((r) => r.split(/\.{2,3}/))
      .map((r) => r.replace(/^refs\/heads\//, '').replace(/[~^@].*$/, ''))
      .filter(Boolean)
  })
}

// Counts the files a delete or move would touch, globs expanded, and names the first ten.
const COUNT =
  'const fs = require("fs"), p = require("path"); let n = 0; const first = [];' +
  'const walk = (f) => { let s; try { s = fs.lstatSync(f) } catch { return }' +
  ' if (s.isDirectory()) { for (const e of fs.readdirSync(f)) walk(p.join(f, e)) } else { n++; if (first.length < 10) first.push(f) } };' +
  'for (const a of process.argv.slice(1)) (/[*?[]/.test(a) ? fs.globSync(a) : [a]).forEach(walk);' +
  'console.log(n + " files" + (first.length ? "\\n" + first.join("\\n") : ""))'

// The paths come from the command being judged, which runs before anyone approved it: after
// `--` node reads them as arguments, never as its own options (`--require=evil.js`).
export const previewArgv = (p: Preview) => (p.kind === 'run' ? p.argv : ['node', '-e', COUNT, '--', ...p.paths])

// undefined: the gate has no opinion and Claude Code's own permissions decide.
export function classify(command: string, shell: Shell, ctx: GateContext): Verdict | undefined {
  if (SECRETS.some((s) => s.test(command))) return { kind: 'deny', reason: `${BLOCKED}it touches Spark's or Claude Code's credentials` }
  if (RECORDS.test(command)) return { kind: 'deny', reason: `${BLOCKED}it touches Spark's mission records` }
  if (DOWNLOAD_RUN.some((d) => d.test(command))) return { kind: 'deny', reason: `${BLOCKED}downloaded code run without being read first` }
  const segments = splitCommand(command)
  const asks: Verdict[] = []
  let moved = false
  for (let i = 0; i < segments.length; i++) {
    const { words, pipe } = segments[i]!
    const v = segment(words, segments[i + 1], pipe, shell, ctx, moved)
    if (v.kind === 'deny') return v
    if (v.kind === 'ask') asks.push(v)
    if (CD.has(name(words[commandStart(words)] ?? ''))) moved = true
  }
  if (!asks.length) return undefined
  return { kind: 'ask', reason: asks.map((a) => a.reason).join('; '), previews: asks.flatMap((a) => (a.kind === 'ask' ? a.previews : [])) }
}
