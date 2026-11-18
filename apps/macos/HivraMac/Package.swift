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
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.4"),
    ],
    targets: [
        .target(
            name: "HivraMacCore",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "HivraMac",
            dependencies: [
                "HivraMacCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ]
        ),
        .testTarget(
            name: "HivraMacTests",
            dependencies: ["HivraMacCore", "HivraMac"]
        ),
    ]
)
