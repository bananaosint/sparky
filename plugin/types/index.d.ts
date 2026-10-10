export type CookPhase =
  | { kind: 'idle' }
  | { kind: 'cooking'; raw: string; id: number; startedAt: number }
  | { kind: 'cooked'; raw: string; text: string; skills: string[]; install?: string[]; ms: number; model?: string; note?: string }

export type ModeName = 'thinking-red-team' | 'grillme' | 'anti-slop'

export type TurnRef = { n: number; base: string }

export type FailureRecord = { command: string; cwd: string; exitCode: number; output: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    spark: {
      phase: CookPhase
      modes: ModeName[]
      geminiKey: string
      sandbox: boolean
      turn: TurnRef | null
      review: TurnRef | null
      failure: FailureRecord | null
      diffstat: { files: number; added: number; removed: number } | null
      touched: string[]
    }
  }
}
