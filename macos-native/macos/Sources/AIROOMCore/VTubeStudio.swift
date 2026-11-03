import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: VTube Studio public API (local WebSocket, default ws://127.0.0.1:8001)
// Only a fixed set of message types is ever sent. The connection is loopback-only;
// a model's output can select an emotion, never a raw request or hotkey ID.

public indirect enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try box.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .object(let value): try box.encode(value)
        case .array(let value): try box.encode(value)
        case .null: try box.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let value) = self { return value[key] } else { return nil }
    }
    public var string: String? { if case .string(let value) = self { return value } else { return nil } }
    public var bool: Bool? { if case .bool(let value) = self { return value } else { return nil } }
    public var number: Double? { if case .number(let value) = self { return value } else { return nil } }
    public var array: [JSONValue]? { if case .array(let value) = self { return value } else { return nil } }
}

public struct VTSEnvelope: Codable, Equatable, Sendable {
    public var apiName: String
    public var apiVersion: String
    public var requestID: String
    public var messageType: String
    public var data: JSONValue?
    public init(requestID: String, messageType: String, data: JSONValue? = nil) {
        self.apiName = VTSProtocol.apiName; self.apiVersion = VTSProtocol.apiVersion
        self.requestID = requestID; self.messageType = messageType; self.data = data
    }
}

public struct VTSHotkey: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var type: String
    /// VTS expression hotkeys toggle; triggering one again turns it off.
    public var toggles: Bool { type == "ToggleExpression" }
}

public struct VTSModel: Equatable, Sendable {
    public var loaded: Bool
    public var name: String
    public var id: String
}

public enum VTSError: Error, LocalizedError, Equatable {
    case api(code: Int, message: String)
    case notAuthenticated(String)
    case timedOut(String)
    case disconnected
    case unexpectedResponse(String)
    case unknownHotkey(String)

    public var errorDescription: String? {
        switch self {
        case .api(let code, let message): return "VTube Studio 錯誤 \(code)：\(message)"
        case .notAuthenticated(let reason): return "VTube Studio 未授權外掛：\(reason)"
        case .timedOut(let type): return "VTube Studio 沒有回應（\(type)）。請確認 VTS 已開啟並啟用 API（設定 → Start API）。"
        case .disconnected: return "未連線到 VTube Studio。"
        case .unexpectedResponse(let type): return "VTube Studio 回應格式不符：\(type)"
        case .unknownHotkey(let id): return "目前模型沒有這個熱鍵：\(id)"
        }
    }
}

public enum VTSProtocol {
    public static let apiName = "VTubeStudioPublicAPI"
    public static let apiVersion = "1.0"
    public static let pluginName = "AIROOM Native"
    public static let pluginDeveloper = "AIROOM"

    static var plugin: [String: JSONValue] {
        ["pluginName": .string(pluginName), "pluginDeveloper": .string(pluginDeveloper)]
    }

    public static func tokenRequest(id: String) -> VTSEnvelope {
        VTSEnvelope(requestID: id, messageType: "AuthenticationTokenRequest", data: .object(plugin))
    }
    public static func authenticate(id: String, token: String) -> VTSEnvelope {
        var data = plugin; data["authenticationToken"] = .string(token)
        return VTSEnvelope(requestID: id, messageType: "AuthenticationRequest", data: .object(data))
    }
    public static func currentModel(id: String) -> VTSEnvelope {
        VTSEnvelope(requestID: id, messageType: "CurrentModelRequest")
    }
    public static func hotkeys(id: String) -> VTSEnvelope {
        VTSEnvelope(requestID: id, messageType: "HotkeysInCurrentModelRequest")
    }
    public static func trigger(id: String, hotkeyID: String) -> VTSEnvelope {
        VTSEnvelope(requestID: id, messageType: "HotkeyTriggerRequest",
                    data: .object(["hotkeyID": .string(hotkeyID)]))
    }
    /// `faceFound: false` lets the injected mouth value win while the user's own
    /// face tracking (if any) is idle; values are clamped to 0...1.
    public static func inject(id: String, parameters: [(String, Double)]) -> VTSEnvelope {
        let values: [JSONValue] = parameters.map { name, value in
            .object(["id": .string(name), "value": .number(min(1, max(0, value)))])
        }
        return VTSEnvelope(requestID: id, messageType: "InjectParameterDataRequest",
                           data: .object(["faceFound": .bool(false), "mode": .string("set"),
                                          "parameterValues": .array(values)]))
    }

    public static func encode(_ envelope: VTSEnvelope) throws -> String {
        String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)
    }
    public static func decode(_ text: String) throws -> VTSEnvelope {
        try JSONDecoder().decode(VTSEnvelope.self, from: Data(text.utf8))
    }

    /// Converts an APIError response into a thrown error; otherwise returns data.
    public static func payload(_ envelope: VTSEnvelope, expecting type: String) throws -> JSONValue {
        if envelope.messageType == "APIError" {
            throw VTSError.api(code: Int(envelope.data?["errorID"]?.number ?? -1),
                               message: envelope.data?["message"]?.string ?? "unknown")
        }
        guard envelope.messageType == type else { throw VTSError.unexpectedResponse(envelope.messageType) }
        return envelope.data ?? .object([:])
    }

    public static func parseHotkeys(_ data: JSONValue) -> [VTSHotkey] {
        (data["availableHotkeys"]?.array ?? []).compactMap { item in
            guard let id = item["hotkeyID"]?.string, !id.isEmpty else { return nil }
            return VTSHotkey(id: id, name: item["name"]?.string ?? id, type: item["type"]?.string ?? "")
        }
    }
}

// MARK: Transport

public protocol VTSTransport: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

#if canImport(Darwin)
public final class WebSocketVTSTransport: VTSTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    /// Loopback only; the port is the one shown in VTS → Settings → "Start API".
    public init(port: Int) {
        let url = URL(string: "ws://127.0.0.1:\(min(65_535, max(1_024, port)))")!
        task = URLSession(configuration: .ephemeral).webSocketTask(with: url)
        task.maximumMessageSize = 4 * 1024 * 1024
        task.resume()
    }
    public func send(_ text: String) async throws { try await task.send(.string(text)) }
    public func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }
    public func close() { task.cancel(with: .normalClosure, reason: nil) }
}
#endif

// MARK: Client

public actor VTubeStudioClient {
    public typealias TransportFactory = @Sendable (Int) -> any VTSTransport

    private let makeTransport: TransportFactory
    private var transport: (any VTSTransport)?
    private var receiver: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<VTSEnvelope, Error>] = [:]
    private var knownHotkeys: [String: VTSHotkey] = [:]
    public private(set) var authenticated = false

    public init(makeTransport: @escaping TransportFactory) {
        self.makeTransport = makeTransport
    }

    #if canImport(Darwin)
    public init() {
        self.init(makeTransport: { WebSocketVTSTransport(port: $0) })
    }
    #endif

    /// Connects and authenticates. With no (or a revoked) token, VTS shows an
    /// "Allow plugin" dialog; this waits up to `approvalTimeout` for the user.
    /// Returns the token to persist and the currently loaded model.
    public func connect(port: Int, token: String,
                        approvalTimeout: TimeInterval = 90) async throws -> (token: String, model: VTSModel) {
        disconnect()
        let link = makeTransport(port)
        transport = link
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let text = try await link.receive()
                    guard let envelope = try? VTSProtocol.decode(text) else { continue }
                    await self?.deliver(envelope)
                } catch {
                    await self?.connectionLost(link)
                    return
                }
            }
        }
        var granted = token
        let reused = granted.isEmpty ? false : try await authenticate(with: granted)
        if !reused {
            let reply = try await request(VTSProtocol.tokenRequest(id: Self.newID()), timeout: approvalTimeout)
            let data = try VTSProtocol.payload(reply, expecting: "AuthenticationTokenResponse")
            guard let issued = data["authenticationToken"]?.string, !issued.isEmpty else {
                throw VTSError.unexpectedResponse("AuthenticationTokenResponse")
            }
            granted = issued
            guard try await authenticate(with: granted) else {
                throw VTSError.notAuthenticated("使用者拒絕或 Token 無效")
            }
        }
        return (granted, try await currentModel())
    }

    public func disconnect() {
        receiver?.cancel(); receiver = nil
        transport?.close(); transport = nil
        authenticated = false
        knownHotkeys = [:]
        failPending(VTSError.disconnected)
    }

    public func currentModel() async throws -> VTSModel {
        let data = try VTSProtocol.payload(try await request(VTSProtocol.currentModel(id: Self.newID())),
                                           expecting: "CurrentModelResponse")
        return VTSModel(loaded: data["modelLoaded"]?.bool ?? false,
                        name: data["modelName"]?.string ?? "", id: data["modelID"]?.string ?? "")
    }

    /// Refreshes the whitelist of hotkeys that `trigger` may fire.
    public func hotkeys() async throws -> [VTSHotkey] {
        let data = try VTSProtocol.payload(try await request(VTSProtocol.hotkeys(id: Self.newID())),
                                           expecting: "HotkeysInCurrentModelResponse")
        let list = VTSProtocol.parseHotkeys(data)
        knownHotkeys = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return list
    }

    public func hotkey(_ id: String) -> VTSHotkey? { knownHotkeys[id] }

    public func trigger(hotkeyID: String) async throws {
        guard authenticated else { throw VTSError.disconnected }
        guard knownHotkeys[hotkeyID] != nil else { throw VTSError.unknownHotkey(hotkeyID) }
        _ = try VTSProtocol.payload(try await request(VTSProtocol.trigger(id: Self.newID(), hotkeyID: hotkeyID)),
                                    expecting: "HotkeyTriggerResponse")
    }

    /// Fire-and-forget at animation rate; responses are ignored.
    public func inject(_ parameters: [(String, Double)]) async {
        guard authenticated, let transport,
              let text = try? VTSProtocol.encode(VTSProtocol.inject(id: Self.newID(), parameters: parameters)) else { return }
        try? await transport.send(text)
    }

    // MARK: internals

    private func authenticate(with token: String) async throws -> Bool {
        let reply = try await request(VTSProtocol.authenticate(id: Self.newID(), token: token))
        let data = try VTSProtocol.payload(reply, expecting: "AuthenticationResponse")
        authenticated = data["authenticated"]?.bool ?? false
        return authenticated
    }

    private func request(_ envelope: VTSEnvelope, timeout: TimeInterval = 5) async throws -> VTSEnvelope {
        guard let transport else { throw VTSError.disconnected }
        let text = try VTSProtocol.encode(envelope)
        let id = envelope.requestID
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            await self?.expire(id, type: envelope.messageType)
        }
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do { try await transport.send(text) }
                catch { self.resolve(id, with: .failure(error)) }
            }
        }
    }

    private func deliver(_ envelope: VTSEnvelope) {
        resolve(envelope.requestID, with: .success(envelope))
    }

    private func expire(_ id: String, type: String) {
        resolve(id, with: .failure(VTSError.timedOut(type)))
    }

    private func resolve(_ id: String, with result: Result<VTSEnvelope, Error>) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(with: result)
    }

    private func connectionLost(_ link: any VTSTransport) {
        guard link === transport else { return }
        transport = nil; authenticated = false
        failPending(VTSError.disconnected)
    }

    private func failPending(_ error: Error) {
        let waiting = pending; pending = [:]
        waiting.values.forEach { $0.resume(throwing: error) }
    }

    private static func newID() -> String { String(UUID().uuidString.prefix(16)) }
}
