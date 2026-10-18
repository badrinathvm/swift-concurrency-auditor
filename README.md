# Swift Concurrency Auditor

A Claude Code mod that soft-checks every Swift file Claude edits for concurrency bugs. Nothing is blocked: after each `Edit` or `Write` to a `.swift` file, Claude reads a short note with any findings and can fix them in the same turn, and you see a summary on the status line.

Requires Claude Code 2.1.287 or later.

## Install

At the prompt of a terminal session:

```
/plugin install swift-concurrency-auditor --marketplace badrinathvm/swift-concurrency-auditor
```

From a shell:

```
claude plugin install swift-concurrency-auditor --marketplace badrinathvm/swift-concurrency-auditor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `badrinathvm/swift-concurrency-auditor`, then Add plugin.

## What it checks

| ID | Severity | Rule |
|---|---|---|
| CA001 | critical | `Task.detached` that mutates `self` (likely data race) |
| CA007 | high | `@Observable` / `ObservableObject` class not isolated to `@MainActor` |
| CA014 | high | Looping `Task` that captures `self` strongly |
| CA021 | medium | `@unchecked Sendable` or `nonisolated(unsafe)` |
| CA030 | medium | `TaskGroup` children that never check cancellation |
| CA042 | low | Blocking calls (semaphores, `Thread.sleep`, `DispatchQueue.main.sync`) in async code |
| CA051 | low | `Task.detached` where `Task` likely suffices |
| CA052 | low | `DispatchQueue.main.async` inside async code |

The checks are fast pattern matches, not the compiler, so expect some false positives. Silence one on a line with `// audit:ignore CA014`.

To see every rule fire, run `/concurrency-audit tests/fixtures/ConcurrencyIssues.swift` and then `/concurrency-report`: the sample trips all eight rules once each, and its one `// audit:ignore` line stays silent.

## Commands

- `/concurrency` — live pane of findings for every Swift file touched this session
- `/concurrency-report` — shows the findings inline, in a band above the prompt (Swift 6 readiness score, per-file findings, Open pane / Dismiss buttons), and also writes `.concurrency-audit/report.html`, the HTML dashboard
- `/concurrency-audit path/File.swift` — audit any file on demand; the findings also appear in the band above the prompt

## Develop

```
claude --plugin-dir ./swift-concurrency-auditor   # load from source, hot-reloads on save
claude plugin validate ./swift-concurrency-auditor
claude plugin test ./swift-concurrency-auditor
```

Tested with Claude Code 2.1.302.
