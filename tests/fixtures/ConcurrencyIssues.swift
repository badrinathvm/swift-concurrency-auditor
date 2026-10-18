import Foundation
import Observation

// Sample for validating the Swift Concurrency Auditor by hand:
//   /concurrency-audit tests/fixtures/ConcurrencyIssues.swift
//   /concurrency-report
// Each block trips one rule on purpose; the rule it should raise is named above it.
// Expected: CA001, CA007, CA014, CA021, CA030, CA042, CA051, CA052 (one each), and nothing
// for the line marked audit:ignore.
// Dummy edit: no behavior change.

// CA007 (high): @Observable class not isolated to @MainActor
@Observable
final class FeedViewModel {
  var items: [String] = []
  var cache: [URL: Data] = [:]

  // CA014 (high): looping Task captures self strongly and never stops
  func startPolling() {
    Task {
      while true {
        await self.refresh()
        try? await Task.sleep(for: .seconds(30))
      }
    }
  }

  // CA001 (critical): detached task writes to self, a data race
  func load(_ url: URL) {
    Task.detached {
      self.cache[url] = try? Data(contentsOf: url)
    }
  }

  // CA051 (low): Task.detached where a plain Task would do
  func logOpen() {
    Task.detached {
      print("feed opened")
    }
  }

  // CA052 (low): GCD hop to the main queue inside async code
  func refresh() async {
    DispatchQueue.main.async {
      self.items.append("tick")
    }
  }

  // CA030 (medium): TaskGroup children never check cancellation
  func fetchAll(_ urls: [URL]) async -> [Data] {
    await withTaskGroup(of: Data?.self) { group in
      for url in urls {
        group.addTask {
          try? Data(contentsOf: url)
        }
      }
      var results: [Data] = []
      for await data in group {
        if let data { results.append(data) }
      }
      return results
    }
  }

  // CA042 (low): semaphore blocks a cooperative-pool thread
  func waitForLegacy() async {
    let semaphore = DispatchSemaphore(value: 0)
    legacyFetch { semaphore.signal() }
    semaphore.wait()
  }

  private func legacyFetch(_ done: @escaping () -> Void) {
    done()
  }
}

// CA021 (medium): opts out of the compiler's data-race checks
final class TokenStore: @unchecked Sendable {
  var token: String?
}

enum Config {
  // Silenced on purpose: should raise nothing.
  nonisolated(unsafe) static var baseURL = URL(string: "https://example.com")! // audit:ignore CA021
}
