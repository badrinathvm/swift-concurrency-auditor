import type { Finding, Severity } from '../types'

// Soft, fast, regex-and-brace-matching checks. No compiler, no model call:
// it runs after every Swift edit, so it has to stay cheap and quiet.

type Rule = {
  id: string
  sev: Severity
  title: string
  why: string
  fix: string
}

export const RULES: Record<string, Rule> = {
  CA001: {
    id: 'CA001', sev: 'critical',
    title: 'Mutating self from a detached task',
    why: 'A Task.detached closure writes to self. Unless self is an actor or Mutex-protected, concurrent writes race.',
    fix: 'Make the type an actor (or @MainActor), or protect the state with Mutex, then await the mutation.',
  },
  CA007: {
    id: 'CA007', sev: 'high',
    title: 'UI-observable type not isolated to @MainActor',
    why: 'An @Observable / ObservableObject type drives UI but is not @MainActor, so async methods can mutate it off the main thread.',
    fix: 'Annotate the type with @MainActor.',
  },
  CA014: {
    id: 'CA014', sev: 'high',
    title: 'Looping Task retains self strongly',
    why: 'A Task with a loop captures self strongly, so the owner never deallocates and the loop runs forever.',
    fix: 'Capture [weak self], guard let self inside the loop, check Task.isCancelled, and cancel the stored task in deinit (or use the .task modifier).',
  },
  CA021: {
    id: 'CA021', sev: 'medium',
    title: 'Unchecked Sendable / nonisolated(unsafe)',
    why: 'This opts out of the compiler’s data-race checks. It is only safe if every mutable member is protected by hand.',
    fix: 'Prefer an actor, Mutex<T> from Synchronization, or immutable lets; keep the escape hatch only with a comment proving safety.',
  },
  CA030: {
    id: 'CA030', sev: 'medium',
    title: 'TaskGroup children ignore cancellation',
    why: 'Child tasks never check cancellation, so they keep working after the parent is cancelled.',
    fix: 'Call try Task.checkCancellation() (or check Task.isCancelled) before expensive work in each child.',
  },
  CA042: {
    id: 'CA042', sev: 'low',
    title: 'Blocking call inside async code',
    why: 'Semaphores, Thread.sleep and DispatchQueue.sync block a cooperative-pool thread and can starve or deadlock the executor.',
    fix: 'Bridge callbacks with withCheckedContinuation; use try await Task.sleep(for:).',
  },
  CA051: {
    id: 'CA051', sev: 'low',
    title: 'Task.detached where Task likely suffices',
    why: 'Task.detached drops actor context, priority and task-local values.',
    fix: 'Use Task { } unless you specifically need to leave the current actor.',
  },
  CA052: {
    id: 'CA052', sev: 'low',
    title: 'DispatchQueue.main.async inside async code',
    why: 'Mixing GCD hops with async/await hides isolation from the compiler.',
    fix: 'Use await MainActor.run { } or mark the function @MainActor.',
  },
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

// Strip // comments and string literals so braces and keywords inside them do not count.
function code(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '')
}

// The lines of the block whose opening brace is on `start` (or the next lines).
function block(lines: string[], start: number, max = 80): { body: string; end: number } {
  let depth = 0
  let opened = false
  const out: string[] = []
  for (let i = start; i < lines.length && i < start + max; i++) {
    const c = code(lines[i] ?? "")
    out.push(c)
    for (const ch of c) {
      if (ch === '{') { depth++; opened = true }
      else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return { body: out.join('\n'), end: i }
  }
  return { body: out.join('\n'), end: Math.min(lines.length - 1, start + max) }
}

function ignored(lines: string[], i: number, id: string): boolean {
  const tag = new RegExp(`audit:ignore\\s+(?:[A-Z0-9, ]*\\b)?${id}\\b`)
  return tag.test(lines[i] ?? '') || tag.test(lines[i - 1] ?? '')
}

function snippet(lines: string[], i: number, end = i): string {
  const from = Math.max(0, i - 1)
  const to = Math.min(lines.length - 1, Math.max(end, i + 2), i + 10)
  return lines.slice(from, to + 1).join('\n')
}

export function audit(text: string, file: string): Finding[] {
  if (!/\.swift$/.test(file)) return []
  const lines = text.split('\n')
  const found: Finding[] = []
  const hasAsync = /\basync\b/.test(text)

  const add = (id: string, i: number, end = i) => {
    if (ignored(lines, i, id)) return
    const r = RULES[id]
    if (!r) return
    found.push({ id, sev: r.sev, title: r.title, why: r.why, fix: r.fix, file, line: i + 1, snippet: snippet(lines, i, end) })
  }

  for (let i = 0; i < lines.length; i++) {
    const c = code(lines[i] ?? "")

    // CA001 / CA051: Task.detached
    if (/\bTask\.detached\b/.test(c)) {
      const { body, end } = block(lines, i)
      if (/\bself\.\w+(\s*\[[^\]]*\])?\s*(=|\+=|-=|\.append\(|\.insert\(|\.remove)/.test(body) && !/\bawait\s+self\./.test(body)) add('CA001', i, end)
      else add('CA051', i, end)
    }

    // CA014: Task { ... while ... self ... } without [weak self]
    if (/(^|[^.\w])Task\s*(\([^)]*\))?\s*\{/.test(c) && !/\[weak self\]|\[unowned self\]/.test(c)) {
      const { body, end } = block(lines, i)
      if (/\b(while|for\s+await|repeat)\b/.test(body) && /\bself\b/.test(body) && !/\[weak self\]/.test(body)) add('CA014', i, end)
    }

    // CA007: @Observable / ObservableObject without @MainActor
    const isObservableClass =
      (/\bclass\s+\w+[^{]*:\s*[^{]*\bObservableObject\b/.test(c)) ||
      (/\bclass\s+\w+/.test(c) && /@Observable\b/.test([lines[i - 3], lines[i - 2], lines[i - 1], c].map(l => code(l ?? '')).join(' ')))
    if (isObservableClass) {
      const head = [lines[i - 3], lines[i - 2], lines[i - 1], c].map(l => code(l ?? '')).join(' ')
      if (!/@MainActor\b/.test(head)) add('CA007', i)
    }

    // CA021
    if (/@unchecked\s+Sendable\b|\bnonisolated\(unsafe\)/.test(c)) add('CA021', i)

    // CA030: addTask { } without cancellation check
    if (/\.addTask(UnlessCancelled)?\b[^{]*\{/.test(c) && !/addTaskUnlessCancelled/.test(c)) {
      const { body, end } = block(lines, i)
      if (!/checkCancellation|isCancelled/.test(body) && body.split('\n').length > 1) add('CA030', i, end)
    }

    // CA042 / CA052: only meaningful in files that use async
    if (hasAsync) {
      if (/\.wait\(\s*(timeout:[^)]*)?\)|\bThread\.sleep\b|\bDispatchQueue\.main\.sync\b|\busleep\(/.test(c)) add('CA042', i)
      if (/\bDispatchQueue\.main\.async\b/.test(c)) add('CA052', i)
    }
  }

  return found.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.line - b.line)
}

// One stable string per finding set, to tell whether an edit changed anything.
export function fingerprint(list: readonly Finding[]): string {
  return list.map(f => `${f.id}@${f.snippet.trim()}`).join('|')
}

// What Claude reads after its edit: short, actionable, explicitly non-blocking.
export function reminder(file: string, list: readonly Finding[]): string {
  const name = file.split('/').pop()
  const rows = list.slice(0, 8).map(f => `- [${f.sev}] ${f.id} line ${f.line}: ${f.title}. Fix: ${f.fix}`)
  const more = list.length > 8 ? [`- …and ${list.length - 8} more (/concurrency to see all)`] : []
  return [
    `Swift concurrency auditor (soft check, nothing was blocked) found ${list.length} issue(s) in ${name}:`,
    ...rows,
    ...more,
    'Fix the critical/high ones if they are part of your change. If a finding is intentional, add `// audit:ignore <ID>` on that line. Do not mention this check unless you act on it.',
  ].join('\n')
}

export function counts(all: readonly Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of all) c[f.sev]++
  return c
}
