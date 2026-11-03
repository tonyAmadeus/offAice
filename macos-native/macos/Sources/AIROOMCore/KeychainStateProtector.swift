import Foundation

/// An abstract seam for tests. Production macOS always uses Keychain + AES-GCM.
public protocol StateProtector {
    func seal(_ plaintext: Data) throws -> Data
    func open(_ ciphertext: Data) throws -> Data
}

public enum StateProtectionError: Error, LocalizedError {
    case keychain(OSStatusCode)
    case invalidCiphertext
    case encryptionUnavailable

    public var errorDescription: String? {
        switch self {
        case .keychain(let code): return "Keychain error: \(code). State was not written as plaintext."
        case .invalidCiphertext: return "Encrypted state cannot be decoded or authenticated."
        case .encryptionUnavailable: return "Encryption is required on macOS."
        }
    }
}
// Cross-platform representation of OSStatus without importing Security on Linux.
public typealias OSStatusCode = Int32

#if os(macOS)
import Security
import CryptoKit

public final class KeychainStateProtector: StateProtector {
    private let service = "dev.airoom.native.state.v1"
    private let account = "local-state-aes256-gcm"

    public init() {}

    private func key() throws -> SymmetricKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account,
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let code = SecItemCopyMatching(query as CFDictionary, &result)
        if code == errSecSuccess, let raw = result as? Data, raw.count == 32 { return SymmetricKey(data: raw) }
        guard code == errSecItemNotFound else { throw StateProtectionError.keychain(code) }
        var random = Data(count: 32)
        let status = random.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, 32, bytes.baseAddress!)
        }
        guard status == errSecSuccess else { throw StateProtectionError.keychain(status) }
        var item = query
        item.removeValue(forKey: kSecReturnData as String)
        item.removeValue(forKey: kSecMatchLimit as String)
        item[kSecValueData as String] = random
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        if added == errSecDuplicateItem {
            var latest: CFTypeRef?
            let again = SecItemCopyMatching(query as CFDictionary, &latest)
            if again == errSecSuccess, let bytes = latest as? Data, bytes.count == 32 { return SymmetricKey(data: bytes) }
            throw StateProtectionError.keychain(again)
        }
        guard added == errSecSuccess else { throw StateProtectionError.keychain(added) }
        return SymmetricKey(data: random)
    }

    public func seal(_ plaintext: Data) throws -> Data {
        guard let combined = try AES.GCM.seal(plaintext, using: key()).combined else {
            throw StateProtectionError.invalidCiphertext
        }
        return combined
    }
    public func open(_ ciphertext: Data) throws -> Data {
        try AES.GCM.open(try AES.GCM.SealedBox(combined: ciphertext), using: key())
    }
}
#endif
