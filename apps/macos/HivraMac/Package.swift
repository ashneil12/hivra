// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HivraMac",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "HivraMacCore", targets: ["HivraMacCore"]),
        .executable(name: "HivraMac", targets: ["HivraMac"]),
    ],
    targets: [
        .target(
            name: "HivraMacCore",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "HivraMac",
            dependencies: ["HivraMacCore"]
        ),
        .testTarget(
            name: "HivraMacTests",
            dependencies: ["HivraMacCore", "HivraMac"]
        ),
    ]
)
