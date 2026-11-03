import Foundation

public enum ArchitectureError: Error, LocalizedError {
    case intelOnly(String)
    case unverified(String)

    public var errorDescription: String? {
        switch self {
        case .intelOnly(let path):
            return "Intel-only executable is not supported; install an Apple Silicon arm64 build: \(path)"
        case .unverified(let path):
            return "Cannot verify executable architecture: \(path)"
        }
    }
}

/// This is a conservative preflight for the *direct* CLI executable, not a proof that
/// every binary the vendor CLI may subsequently load is arm64. That requires a
/// separate end-to-end audit on the target Mac.
public enum ArchitectureGuard {
    public static func verifyDirectExecutable(_ executable: URL) throws {
        #if os(macOS)
        let data = try Data(contentsOf: executable, options: .mappedIfSafe).prefix(4)
        guard data.count == 4 else { throw ArchitectureError.unverified(executable.path) }
        // MH_MAGIC, MH_CIGAM, FAT_MAGIC and FAT_CIGAM (32/64-bit variants).
        let magic: Set<[UInt8]> = [
            [0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf],
            [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca]
        ]
        guard magic.contains(Array(data)) else { return } // script; interpreter must be audited separately.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/lipo")
        task.arguments = ["-archs", executable.path]
        let pipe = Pipe(); task.standardOutput = pipe; task.standardError = Pipe()
        try task.run()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { throw ArchitectureError.unverified(executable.path) }
        guard output.split(whereSeparator: \.isWhitespace).contains("arm64") else {
            throw ArchitectureError.intelOnly(executable.path)
        }
        #endif
    }
}
