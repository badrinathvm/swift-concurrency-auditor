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

declare module 'claude-code' {
  interface PluginState {
    'swift-concurrency-auditor': {
      /** Latest findings per Swift file Claude touched this session, keyed by path. */
      byFile: Record<string, Finding[]>
    }
  }
}
