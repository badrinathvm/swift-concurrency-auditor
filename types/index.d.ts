export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type Finding = {
  id: string
  sev: Severity
  title: string
  why: string
  fix: string
  file: string
  line: number
  snippet: string
}

export type Band =
  | { status: 'hidden' }
  | { status: 'shown'; source: 'report' | 'audit'; reportPath?: string; reportUrl?: string }

/** One Fix-button run in the pane; a finding with no entry is idle. */
export type FixState = {
  status: 'running' | 'done' | 'failed'
  /** The fixer subagent's id, matched against `turn.complete`'s `agentId`. */
  agentId?: string
  /** The finding as it was when Fix was pressed, for the pane's run list. */
  id: string
  file: string
  line: number
  /** How many findings of this id the file had at press time; fewer afterwards means fixed. */
  count: number
  /** Why a run failed, shown beside Retry. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'swift-concurrency-auditor': {
      /** Latest findings per Swift file Claude touched this session, keyed by path. */
      byFile: Record<string, Finding[]>
      /** Whether the inline findings band above the prompt is showing. */
      band: Band
      /** Fix-button runs, keyed by `file#id#line` of the finding they target. */
      fixes: Record<string, FixState>
    }
  }
}
