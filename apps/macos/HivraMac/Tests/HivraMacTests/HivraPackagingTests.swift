import Foundation
import Testing

@Suite("Mac installer packaging")
struct HivraPackagingTests {
    @Test("only a release missing a notarization profile stops before building", arguments: [
        (channel: "release", profile: "", expectedStatus: Int32(1), expectedMessage: "HIVRA_MAC_NOTARY_PROFILE"),
        (channel: "release", profile: "fixture", expectedStatus: Int32(42), expectedMessage: "Reached build stub"),
        (channel: "internal", profile: "", expectedStatus: Int32(42), expectedMessage: "Reached build stub"),
    ])
    func notarizationPreflight(channel: String, profile: String, expectedStatus: Int32, expectedMessage: String) throws {
        let bin = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: bin) }
        let swift = bin.appending(path: "swift")
        try "#!/bin/sh\nprintf 'Reached build stub: %s\\n' \"$*\" >&2\nexit 42\n".write(to: swift, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: swift.path)

        let appRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let process = Process()
        process.executableURL = appRoot.appending(path: "scripts/build-app.sh")
        process.environment = [
            "PATH": "\(bin.path):/usr/bin:/bin",
            "HIVRA_MAC_CHANNEL": channel,
            "HIVRA_MAC_CODESIGN_IDENTITY": channel == "release" ? "Developer ID Application: fixture" : "-",
            "HIVRA_MAC_NOTARY_PROFILE": profile,
            "HIVRA_SPARKLE_PUBLIC_KEY": channel == "release" ? "fixture" : "",
        ]
        let output = Pipe()
        process.standardError = output
        try process.run()
        let message = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()

        #expect(process.terminationStatus == expectedStatus)
        #expect(message.contains(expectedMessage))
        #expect(message.contains("-Xswiftc -D -Xswiftc HIVRA_PUBLIC_BUILD") == (channel == "release" && expectedStatus == 42))
    }
}
