// swift-tools-version: 5.10
import PackageDescription

// On Linux, build and test the Foundation-only core. SwiftUI is available only on macOS.
let baseTargets: [Target] = [
    .target(name: "AIROOMCore"),
    .testTarget(name: "AIROOMCoreTests", dependencies: ["AIROOMCore"])
]
#if os(macOS)
let products: [Product] = [
    .library(name: "AIROOMCore", targets: ["AIROOMCore"]),
    .executable(name: "AIROOMNative", targets: ["AIROOMNative"])
]
let targets = baseTargets + [
    .executableTarget(name: "AIROOMNative", dependencies: ["AIROOMCore"], resources: [.process("Resources")])
]
#else
let products: [Product] = [.library(name: "AIROOMCore", targets: ["AIROOMCore"])]
let targets = baseTargets
#endif

let package = Package(
    name: "AIROOMNative",
    platforms: [.macOS(.v14)],
    products: products,
    targets: targets
)
