export type CookPhase =
  | { kind: 'idle' }
  | { kind: 'cooking'; raw: string; id: number; startedAt: number }
  | { kind: 'cooked'; raw: string; text: string; skills: string[]; install?: string[]; ms: number; model?: string; note?: string }

export type ModeName = 'thinking-red-team' | 'grillme' | 'anti-slop'

export type TurnRef = { n: number; base: string }

export type Goal = {
  text: string
  limits: { timeMs: number; tokens: number }
  startedAt: number
  tokens: number
  step: number
  review: { met: boolean; next: string; why: string } | null
}

// The contract can't import: this repeats Status from hooks/mission.ts.
export type MissionStatus = 'draft' | 'review' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'finished' | 'blocked' | 'cancelled'

export type FailureRecord = { command: string; cwd: string; exitCode: number; output: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    spark: {
      phase: CookPhase
      modes: ModeName[]
      geminiKey: string
      openrouterKey: string
      sandbox: boolean
      turn: TurnRef | null
      review: TurnRef | null
      failure: FailureRecord | null
      diffstat: { files: number; added: number; removed: number } | null
      touched: string[]
      goal: Goal | null
      streak: number
      halt: { at: number } | null
      verdicts: Record<string, { head: string; pass: boolean }>
      mission: { id: string; root: string; status: MissionStatus } | null
    }
  }
}
