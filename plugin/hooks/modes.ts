import type { ModeName } from '../types'

export const MODE_NAMES: readonly ModeName[] = ['thinking-red-team', 'grillme', 'anti-slop']

export const MODE_DESCRIPTIONS: Record<ModeName, string> = {
  'thinking-red-team': 'Spark mode: attack every proposed change for security holes before applying it',
  grillme: 'Spark mode: relentless questions about the idea, no code',
  'anti-slop': 'Spark mode: strip needless abstractions, single-caller helpers and filler',
}

export function toggleMode(active: readonly ModeName[], mode: ModeName): ModeName[] {
  return active.includes(mode) ? active.filter((m) => m !== mode) : [...active, mode]
}

export function modesContext(active: readonly ModeName[]): string | undefined {
  return active.length ? `<spark-modes>${active.join(', ')}</spark-modes>` : undefined
}
