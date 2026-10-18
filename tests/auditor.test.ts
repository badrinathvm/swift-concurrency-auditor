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
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 17, 22, 50) }))

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

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  } as never,
} as const

// A slash command as the person types it; the engine fills in origin and presentation.
const slash = (command: string, args = '') => ({ command, args }) as never

// What the engine draws in the band when no plugin does.
const ENGINE_BAND = { type: 'Box', props: {}, children: [] } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/concurrency-report shows findings above the prompt and still writes the HTML (${surface})`, async ($, on) => {
    const written: string[] = []
    on('ui.render', () => ENGINE_BAND)
    on('fs.read', () => ({ value: LEAKY }))
    on('fs.write', ($, e) => {
      written.push(e.path)
      return { value: undefined } as never
    })
    on('session.cwd', () => ({ value: '/app' }))
    on('clock.now', () => ({ value: Date.UTC(2026, 9, 17, 22, 50) }))

    const ui = await $.ui.mount({ plugin: 'swift-concurrency-auditor', surface, ...BAND })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()

    await $.command.run(slash('concurrency-audit', 'Sources/FeedViewModel.swift'))
    const report = await $.command.run(slash('concurrency-report'))

    expect(written.some(p => p.endsWith('.concurrency-audit/report.html'))).toBe(true)
    const text = JSON.stringify(report)
    expect(text).toContain('readiness')
    expect(text).toContain('file:///app/.concurrency-audit/report.html')
    expect(await ui.find({ text: /CA014/ })).toBeDefined()
    expect(await ui.find({ text: /Swift 6 readiness/ })).toBeDefined()
    for (const label of ['Critical', 'High', 'Medium', 'Low']) expect(await ui.find({ text: label })).toBeDefined()
    expect(await ui.find({ text: /Open full report/ })).toBeDefined()
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()

    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a Swift Write with findings writes the HTML report and shows the visual band', async ($, on) => {
  const written: string[] = []
  on('ui.render', () => ENGINE_BAND)
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', () => ({ value: LEAKY }))
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined } as never
  })
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 17, 22, 50) }))

  const ui = await $.ui.mount({ plugin: 'swift-concurrency-auditor', surface: 'terminal', ...BAND })
  await $.tool.call({ tool: 'Write', file_path: '/app/FeedViewModel.swift', content: LEAKY })

  expect(written.some(p => p.endsWith('.concurrency-audit/report.html'))).toBe(true)
  expect(await ui.find({ text: /Swift 6 readiness/ })).toBeDefined()
  expect(await ui.find({ text: /Open full report/ })).toBeDefined()
  await ui.unmount()
})

test('/concurrency-report draws the summary cards inline in its output row', async ($, on) => {
  on('ui.render', () => ENGINE_BAND)
  on('fs.read', () => ({ value: LEAKY }))
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 17, 22, 50) }))
  await $.command.run(slash('concurrency-audit', '/app/FeedViewModel.swift'))
  const report = await $.command.run(slash('concurrency-report'))

  const ui = await $.ui.mount({
    plugin: 'swift-concurrency-auditor',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'concurrency-report', args: '', text: report.text ?? '', isErrored: false } as never,
  })
  expect(await ui.find({ text: /Swift 6 readiness/ })).toBeDefined()
  for (const label of ['Critical', 'High', 'Medium', 'Low']) expect(await ui.find({ text: label })).toBeDefined()
  expect(await ui.find({ text: /Open full report/ })).toBeDefined()
  await ui.unmount()
})

test('the band stays out of the way while a survey holds it', async ($, on) => {
  on('ui.render', () => ENGINE_BAND)
  on('fs.read', () => ({ value: LEAKY }))
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/app' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 17, 22, 50) }))
  await $.command.run(slash('concurrency-audit', '/app/FeedViewModel.swift'))

  const ui = await $.ui.mount({
    plugin: 'swift-concurrency-auditor',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...(BAND.props as object), hasSurvey: true } as never,
  })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
})
