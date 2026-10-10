// The last failed `spark try` command, as the launcher records it.
export type Failure = { command: string; cwd: string; exitCode: number; output: string; at: number }

export const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const PASSING = /^\s*(✓|✔|√|PASS\b|ok \d|\(pass\))/

export function parseFailure(text: string): Failure | undefined {
  try {
    const f = JSON.parse(text)
    const ok =
      typeof f?.command === 'string' &&
      typeof f.cwd === 'string' &&
      typeof f.exitCode === 'number' &&
      typeof f.output === 'string' &&
      typeof f.at === 'number'
    return ok ? { command: f.command, cwd: f.cwd, exitCode: f.exitCode, output: f.output, at: f.at } : undefined
  } catch {
    return undefined
  }
}

// The lines worth sending: no colors, no passing tests, the last `max`.
export function trimOutput(output: string, max = 80): string {
  const lines = output
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !PASSING.test(line))
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  return lines.slice(-max).join('\n')
}

export const failurePrompt = (f: Failure) =>
  `\`${f.command}\` failed with exit code ${f.exitCode} (in ${f.cwd}). Find the cause and fix it.\n\nOutput:\n\`\`\`\n${trimOutput(f.output)}\n\`\`\``
