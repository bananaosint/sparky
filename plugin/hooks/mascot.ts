// Sparky in the band: one face per state, changed only when the state changes.
export const FACES = {
  idle: 'ϟ(◕▾◕)ϟ',
  cooking: 'ϟ(◕ω◕)ϟ',
  cooked: 'ϟ(^▾^)ϟ',
  working: 'ϟ(◔▾◔)ϟ',
  failed: 'ϟ(×_×)ϟ',
  review: 'ϟ(◉_◉)ϟ',
} as const

export type Mood = keyof typeof FACES

export type MoodInput = { working: boolean; cooking: boolean; cooked: boolean; failed: boolean; review: boolean }

// The most urgent state wins: a pending review, a failure, then what is happening now.
export function mood(s: MoodInput): Mood {
  if (s.review) return 'review'
  if (s.failed) return 'failed'
  if (s.cooking) return 'cooking'
  if (s.working) return 'working'
  if (s.cooked) return 'cooked'
  return 'idle'
}
