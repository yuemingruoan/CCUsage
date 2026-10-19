// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CCUsage",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CCUsage", targets: ["CCUsage"])
    ],
    targets: [
        .target(name: "CCUsageCore"),
        .executableTarget(name: "CCUsage", dependencies: ["CCUsageCore"]),
        .testTarget(name: "CCUsageCoreTests", dependencies: ["CCUsageCore"]),
    ]
)
