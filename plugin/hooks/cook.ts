import type { CookPhase } from '../types'

export type SubmittedPrompt = {
  text: string
  origin: { kind: string }
  turnId?: string
  attachments?: readonly unknown[]
}

export type CookConfig = { enabled: boolean; minWords: number }

export type Decision = { action: 'cook' } | { action: 'offer' } | { action: 'send'; text: string; notice?: string }

export type Rewrite = { prompt: string; unclear: string[]; role?: string }

const send = (text: string, notice?: string): Decision => (notice ? { action: 'send', text, notice } : { action: 'send', text })

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []

// True when `text` is the cooked prompt as placed, or the person's light edit of it.
// The "Act as" line is Spark's, not the person's, so deleting it doesn't count.
export function isEditOf(cooked: string, text: string): boolean {
  if (text === cooked) return true
  const cookedWords = new Set(words(cooked.replace(/^Act as [^\n]*\n\n/, '')))
  if (cookedWords.size === 0) return false
  const typed = new Set(words(text))
  let kept = 0
  for (const w of cookedWords) if (typed.has(w)) kept++
  return kept / cookedWords.size >= 0.5
}

export function decide(e: SubmittedPrompt, phase: CookPhase, config: CookConfig): Decision {
  const { text } = e
  if (e.origin.kind !== 'composer') return send(text)
  if (text.startsWith('\\')) return send(text.slice(1).trimStart())
  if (phase.kind === 'cooking') return send(text)
  if (phase.kind === 'cooked' && isEditOf(phase.text, text)) return send(text)
  if (!config.enabled || e.turnId !== undefined) return send(text)
  if (text.trimStart().startsWith('/')) return send(text)
  // The box can't hold the image again, so a prompt with one is offered for promptifying where it stands.
  if (e.attachments?.length) return { action: 'offer' }
  if (text.includes('<pasted_content')) return send(text, 'Prompts with pasted text are sent as typed.')
  if (text.trim().split(/\s+/).length < config.minWords) return send(text)
  return { action: 'cook' }
}

const short = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n)

export function composeCooked(
  rewrite: Rewrite,
  skills: readonly string[],
  install: readonly { id: string; installs: number }[] = [],
): string {
  const parts = [rewrite.prompt.trim()]
  if (rewrite.role) parts.unshift(`Act as ${rewrite.role}.`)
  if (rewrite.unclear.length) parts.push(`Ask me before starting:\n${rewrite.unclear.map((q) => `- ${q}`).join('\n')}`)
  if (skills.length) parts.push(`Skills: ${skills.join(', ')}`)
  if (install.length)
    parts.push(
      `Install these skills first with \`npx skills add <id> -g -y\`:\n${install.map((s) => `- ${s.id} (${short(s.installs)} installs)`).join('\n')}`,
    )
  return parts.join('\n\n')
}
