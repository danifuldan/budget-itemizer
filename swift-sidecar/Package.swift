// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "swift-sidecar",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "swift-sidecar",
            path: "Sources",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ],
            linkerSettings: [
                .linkedFramework("Vision"),
                .linkedFramework("PDFKit"),
                .linkedFramework("FoundationModels", .when(platforms: [.macOS])),
            ]
        ),
    ]
)
