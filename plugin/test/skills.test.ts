import { test, expect } from 'claude-code/testing'
import { MISP } from '../hooks/misp'

test('the rules send UI work to the spark:ui-taste skill', () => {
  expect(MISP).toContain('## UI work\nFor any user-facing UI, load the spark:ui-taste skill and follow it.')
})

test('the rules tell Claude about the restore points Spark already takes', () => {
  expect(MISP).toContain("- Restore points: Spark snapshots the working tree to a git ref before each prompt. Don't make backup copies of files. Never touch refs/spark/.")
})
