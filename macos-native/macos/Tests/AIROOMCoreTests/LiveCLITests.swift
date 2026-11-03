import XCTest
@testable import AIROOMCore

/// Talks to the real, signed-in CLIs (no prompts, no tokens spent).
/// Skipped unless AIROOM_LIVE_CLI=1.
final class LiveCLITests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["AIROOM_LIVE_CLI"] == "1")
    }

    func testCodexModelCatalog() async throws {
        let models = try await CLIProcessRunner().codexModels(settings: NativeSettings())
        print("CODEX MODELS:", models.map { "\($0.title)\($0.isDefault ? "*" : "")" })
        XCTAssertFalse(models.isEmpty)
    }

    func testClaudeModelCatalog() async throws {
        let models = try await CLIProcessRunner().claudeModels(settings: NativeSettings())
        print("CLAUDE MODELS:", models.map { "\($0.title)\($0.isDefault ? "*" : "")" })
        XCTAssertFalse(models.isEmpty)
    }
}
