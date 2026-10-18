import { expect, test } from 'claude-code/testing'

import { buildReport } from '../hooks/report'
import { audit } from '../hooks/rules'

const LEAKY = `@Observable
final class FeedViewModel {
  var items: [Item] = []

  func startPolling() {
    Task {
      while true {
        await self.refresh()
        try await Task.sleep(for: .seconds(30))
      }
    }
  }
}`

const CLEAN = `@MainActor
@Observable
final class FeedViewModel {
  var items: [Item] = []
  private var pollTask: Task<Void, Never>?

  func startPolling() {
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.refresh()
      }
    }
  }
}`

test('rules flag a looping strong-self Task and a non-MainActor @Observable', () => {
  const ids = audit(LEAKY, '/app/FeedViewModel.swift').map(f => f.id)
  expect(ids).toContain('CA014')
  expect(ids).toContain('CA007')
})

test('rules stay quiet on the fixed version and on non-Swift files', () => {
  expect(audit(CLEAN, '/app/FeedViewModel.swift')).toEqual([])
  expect(audit(LEAKY, '/app/notes.md')).toEqual([])
})

test('audit:ignore silences one rule on one line', () => {
  const src = `final class Store: @unchecked Sendable { // audit:ignore CA021
  let x = 1
}`
  expect(audit(src, '/app/Store.swift')).toEqual([])
})

test('detached task mutating self is critical; plain detached is low', () => {
  const racy = `final class Cache {
  var store: [URL: Data] = [:]
  func load(_ url: URL) {
    Task.detached {
      self.store[url] = try await fetch(url)
    }
  }
}`
  expect(audit(racy, '/a/Cache.swift')[0]?.id).toBe('CA001')
  expect(audit('Task.detached {\n  await log()\n}', '/a/T.swift')[0]?.id).toBe('CA051')
})

test('an Edit to a Swift file runs, then Claude reads the findings as context', async ($, on) => {
  // Stand in for the engine: the edit succeeds and the file holds LEAKY.
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', () => ({ value: LEAKY }))

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: '/app/FeedViewModel.swift',
    old_string: 'a',
    new_string: 'b',
  })

  expect(ran.deny).toBeUndefined()
  const context = (ran.context ?? []).join('\n')
  expect(context).toContain('soft check')
  expect(context).toContain('CA014')
})

test('edits to non-Swift files pass through untouched', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', () => ({ value: LEAKY }))
  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/README.md', content: 'hi' })
  expect(ran.context).toBeUndefined()
})

test('the HTML report fills every placeholder with the session findings', () => {

  const findings = audit(LEAKY, '/app/Sources/FeedViewModel.swift')
  const html = buildReport({ '/app/Sources/FeedViewModel.swift': findings, '/app/Ok.swift': [] }, '/app', '2026-10-17 22:50 UTC')
  expect(html).not.toMatch(/__(FINDINGS|SUB|SCORE|OFFSET|META)__/)
  expect(html).toContain('Sources/FeedViewModel.swift')
  expect(html).toContain('CA014')
})
