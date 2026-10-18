import Foundation
import Observation

// Dummy file for exercising /concurrency-report. Expected: CA007, CA001, CA014, CA052.
// Dummy commit marker for concurrency review.
// Dummy marker: testing the /concurrency pane and Fix button.

// CA007 (high): @Observable class not isolated to @MainActor
@Observable
final class ProfileViewModel {
  var name = ""
  var avatars: [URL: Data] = [:]

  // CA001 (critical): detached task writes to self
  func loadAvatar(_ url: URL) {
    Task.detached {
      self.avatars[url] = try? Data(contentsOf: url)
    }
  }

  // CA014 (high): looping Task captures self strongly and never stops
  func startSync() {
    Task {
      while true {
        await self.sync()
        try? await Task.sleep(for: .seconds(60))
      }
    }
  }

  // CA052 (low): GCD hop to the main queue inside async code
  func sync() async {
    DispatchQueue.main.async {
      self.name = "synced"
    }
  }
}
