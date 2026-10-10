export type CookPhase =
  | { kind: 'idle' }
  | { kind: 'cooking'; raw: string; id: number; startedAt: number }
  | { kind: 'cooked'; raw: string; text: string; skills: string[]; install?: string[]; ms: number; model?: string; note?: string }

export type ModeName = 'thinking-red-team' | 'grillme' | 'anti-slop'

declare module 'claude-code' {
  interface PluginState {
    spark: {
      phase: CookPhase
      modes: ModeName[]
      geminiKey: string
    }
  }
}
