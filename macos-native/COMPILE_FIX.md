# macOS ARM64 build correction (2026-11-02)

This version fixes two issues reported when building the **LiveCollaboration** version on an Apple Silicon Mac:

1. `ContentView.swift`: `.quota` was missing from the `routeTitle` switch.
2. `DesktopAppBridge.swift`: a `MainActor.run` closure captured a mutable weak `self` from a detached task, which triggers Swift 6 sendability diagnostics. Status updates now hop directly to an actor-isolated method.

No changes to AI agent login, encryption, project approvals, or persisted data models were made.

## Updating an existing checkout

Apply `AIROOMNative_LiveCollaboration_compile_fix.patch` in your existing project root (the directory containing `macos`):

```sh
git apply /path/to/AIROOMNative_LiveCollaboration_compile_fix.patch
cd macos
swift test
./Scripts/package-app.sh
open dist/AIROOMNative.app
```

If your project directory is not under Git, replace the two corresponding files from the corrected ZIP instead.

**Verification:** 65 Swift Foundation tests passed on Linux; the SwiftUI files passed syntax parsing, and the concurrency correction compiled under strict Swift 6 checks in an isolated actor test. This environment cannot perform a full macOS SwiftUI build or codesign verification. Check the final result on macOS before replacing your installed App.
