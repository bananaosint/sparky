// Secrets are swapped for «secret-N» before a prompt goes to Gemini, and put
// back into the rewrite before it reaches the prompt box.
const SECRET = new RegExp(
  [
    '(?<pem>-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----)',
    '(?<name>\\b(?:password|passwd|secret|token|api[_-]?key)\\s*[:=]\\s*)(?<value>[^\\s\'"]+)',
    '(?<token>sk-[A-Za-z0-9_-]{20,}' +
      '|AKIA[0-9A-Z]{16}' +
      '|gh[pousr]_[A-Za-z0-9]{36}' +
      '|github_pat_[A-Za-z0-9_]{20,}' +
      '|AIza[0-9A-Za-z_-]{35}' +
      '|xox[baprs]-[A-Za-z0-9-]{10,}' +
      '|eyJ[\\w-]+\\.eyJ[\\w-]+\\.[\\w-]+)',
  ].join('|'),
  'gi',
)

const PLACEHOLDER = /«secret-(\d+)»/g

export function redact(text: string): { text: string; restore: (s: string) => string } {
  const found: string[] = []
  const hold = (secret: string) => {
    found.push(secret)
    return `«secret-${found.length}»`
  }
  const redacted = text.replace(SECRET, (match, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>
    return groups.name !== undefined ? groups.name + hold(groups.value!) : hold(match)
  })
  return {
    text: redacted,
    restore: (s) => s.replace(PLACEHOLDER, (m, n) => found[Number(n) - 1] ?? m),
  }
}
