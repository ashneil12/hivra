import CryptoKit
import Foundation
import Testing

@testable import HivraMacCore

@Suite("Isolated Moonlight identity", .serialized)
struct HivraMoonlightProfileTests {
    @Test("offers HQ first and keeps the product labels explicit")
    func streamingModeContract() {
        #expect(HivraStreamingMode.allCases == [.hq, .qhd, .uhd, .performance])
        #expect(HivraStreamingMode.hq.displayName == "HQ")
        #expect(HivraStreamingMode.hq.summary.contains("1080p"))
        #expect(HivraStreamingMode.qhd.summary.contains("1440p"))
        #expect(HivraStreamingMode.uhd.displayName == "4K")
        #expect(HivraStreamingMode.uhd.summary.contains("4K"))
        #expect(HivraStreamingMode.performance.displayName == "Performance")
        #expect(HivraStreamingMode.performance.summary.contains("720p"))
        #expect(HivraStreamingMode(rawValue: "unknown") == nil)
    }

    @Test("builds fixed daily-driver launch arguments for every quality mode")
    func launchArgumentsAreFixedAndModeBound() throws {
        try withParent { parent in
            for mode in HivraStreamingMode.allCases {
                let profile = try HivraMoonlightProfile.prepare(
                    in: parent, sessionId: UUID(), clientId: UUID(), streamingMode: mode
                )
                let plan = HivraMoonlightLauncher.launchPlan(profile: profile, host: "10.240.20.99")
                #expect(plan.executable.path == "/Applications/Moonlight.app/Contents/MacOS/Moonlight")
                #expect(plan.currentDirectory == profile.directory)
                #expect(Array(plan.arguments.prefix(3)) == ["stream", "10.240.20.99", "Desktop"])
                #expect(plan.arguments.contains("--fps"))
                #expect(plan.arguments.contains("60"))
                #expect(plan.arguments.contains("--absolute-mouse"))
                #expect(plan.arguments.contains("--video-decoder"))
                #expect(plan.arguments.contains("hardware"))
                #expect(plan.arguments.contains("--capture-system-keys"))
                #expect(plan.arguments.contains("windowed"))
                #expect(!plan.arguments.contains("fullscreen"))
                #expect(plan.environment["HOME"] == profile.directory.path)
                #expect(plan.environment["TMPDIR"] == profile.directory.path + "/")
                let expected = switch mode {
                case .hq: ("--1080", "25000", "--frame-pacing")
                case .qhd: ("--1440", "40000", "--frame-pacing")
                case .uhd: ("--4K", "65000", "--frame-pacing")
                case .performance: ("--720", "12000", "--no-frame-pacing")
                }
                #expect(plan.arguments.contains(expected.0))
                #expect(plan.arguments.contains(expected.1))
                #expect(plan.arguments.contains(expected.2))
                #expect(!plan.arguments.contains("--no-quit-after"))
                #expect(!plan.arguments.contains("/tmp/Moonlight"))
            }
        }
    }

    private func withParent(_ body: (URL) throws -> Void) throws {
        let parent = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appending(path: "hivra-moonlight-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try body(parent)
    }

    @Test("prepares a private portable profile with a non-CA identity")
    func preparesPrivateIdentity() throws {
        try withParent { parent in
            let client = UUID()
            let profile = try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: client)
            #expect(profile.clientId == client)
            #expect(profile.certificatePEM.hasPrefix("-----BEGIN CERTIFICATE-----\n"))
            #expect(profile.certificateSHA256.count == 64)
            #expect(profile.settingsURL.deletingLastPathComponent().lastPathComponent == "moonlight-stream.com")
            #expect(FileManager.default.fileExists(atPath: profile.directory.appending(path: "portable.dat").path))
            let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
            #expect(ini.contains("uniqueid=\(client.uuidString.lowercased())"))
            #expect(ini.contains("certificate=@ByteArray("))
            #expect(ini.contains("key=@ByteArray("))
            #expect(ini.contains("\\n"))
            #expect(profile.streamingMode == .hq)
            #expect(ini.contains("width=1920\nheight=1080\nfps=60\nbitrate=25000"))
            for path in [profile.directory, profile.settingsURL.deletingLastPathComponent()] {
                let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
                #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: profile.settingsURL.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
            #expect(!FileManager.default.fileExists(atPath: profile.directory.appending(path: "key.pem").path))

            let certificate = parent.appending(path: "public.pem")
            try Data(profile.certificatePEM.utf8).write(to: certificate)
            let details = try HivraMoonlightProfile.openssl(["x509", "-in", certificate.path, "-noout", "-text"], in: parent)
            #expect(String(decoding: details, as: UTF8.self).contains("CA:FALSE"))
            let der = try HivraMoonlightProfile.openssl(["x509", "-in", certificate.path, "-outform", "DER"], in: parent)
            #expect(SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined() == profile.certificateSHA256)
        }
    }

    @Test("prepares the lower-bandwidth performance profile without weakening frame cadence")
    func preparesPerformanceProfile() throws {
        try withParent { parent in
            let profile = try HivraMoonlightProfile.prepare(
                in: parent,
                sessionId: UUID(),
                clientId: UUID(),
                streamingMode: .performance
            )
            let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
            #expect(profile.streamingMode == .performance)
            #expect(ini.contains("width=1280\nheight=720\nfps=60\nbitrate=12000"))
            #expect(ini.contains("framepacing=false\nvsync=true"))
        }
    }

    @Test("removes only the profile instance it created")
    func removesOnlyOriginalProfile() throws {
        try withParent { parent in
            let profile = try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            try profile.remove()
            #expect(!FileManager.default.fileExists(atPath: profile.directory.path))

            let replaced = try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            let original = replaced.directory.appendingPathExtension("original")
            try FileManager.default.moveItem(at: replaced.directory, to: original)
            try FileManager.default.createDirectory(at: replaced.directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            try Data("preserve".utf8).write(to: replaced.directory.appending(path: "foreign"))
            #expect(throws: HivraMoonlightProfile.ProfileError.self) { try replaced.remove() }
            #expect(FileManager.default.fileExists(atPath: replaced.directory.appending(path: "foreign").path))
        }
    }

    @Test("new sessions have independent identities and no common settings")
    func isolatesSessions() throws {
        try withParent { parent in
            let first = try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            let firstBytes = try Data(contentsOf: first.settingsURL)
            let second = try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            #expect(first.directory != second.directory)
            #expect(first.certificateSHA256 != second.certificateSHA256)
            #expect(try Data(contentsOf: first.settingsURL) == firstBytes)
        }
    }

    @Test("preloads the pinned server identity on the exact private transport")
    func preloadsPairedHost() throws {
        try withParent { parent in
            let serverIdentity = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID()
            )
            let serverId = UUID()
            let profile = try HivraMoonlightProfile.prepare(
                in: parent,
                sessionId: UUID(),
                clientId: UUID(),
                pairedHost: HivraMoonlightPairedHost(
                    serverId: serverId,
                    serverCertificatePEM: serverIdentity.certificatePEM,
                    serverCertificateSHA256: serverIdentity.certificateSHA256,
                    directIPv4: "10.240.20.99"
                )
            )
            let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
            #expect(ini.contains("[hosts]\nsize=1"))
            #expect(ini.contains("1\\uuid=\(serverId.uuidString.lowercased())"))
            #expect(ini.contains("1\\manualaddress=10.240.20.99"))
            #expect(ini.contains("1\\localaddress=10.240.20.99"))
            #expect(ini.contains("1\\srvcert=@ByteArray("))
            #expect(!FileManager.default.fileExists(
                atPath: profile.directory.appending(path: "server-certificate.pem").path
            ))
        }
    }

    @Test("binds an existing identity once without regenerating its private key")
    func bindsPreparedProfileOnce() throws {
        try withParent { parent in
            let server = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID()
            )
            let profile = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID(), streamingMode: .hq
            )
            let originalPublicIdentity = profile.certificateSHA256
            try profile.bind(pairedHost: HivraMoonlightPairedHost(
                serverId: UUID(), serverCertificatePEM: server.certificatePEM,
                serverCertificateSHA256: server.certificateSHA256,
                directIPv4: "10.250.44.7"
            ))
            let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
            #expect(ini.contains("[hosts]\nsize=1"))
            #expect(ini.contains("1\\manualaddress=10.250.44.7"))
            #expect(profile.certificateSHA256 == originalPublicIdentity)
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try profile.bind(pairedHost: HivraMoonlightPairedHost(
                    serverId: UUID(), serverCertificatePEM: server.certificatePEM,
                    serverCertificateSHA256: server.certificateSHA256,
                    directIPv4: "10.250.44.8"
                ))
            }
        }
    }

    @Test("binds a certificate-pinned public host route")
    func bindsPublicHostRoute() throws {
        try withParent { parent in
            let server = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID()
            )
            let profile = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID()
            )
            try profile.bind(pairedHost: HivraMoonlightPairedHost(
                serverId: UUID(), serverCertificatePEM: server.certificatePEM,
                serverCertificateSHA256: server.certificateSHA256,
                directIPv4: "10.252.12.213"
            ))
            let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
            #expect(ini.contains("1\\manualaddress=10.252.12.213"))
            #expect(ini.contains("1\\localaddress=10.252.12.213"))
        }
    }

    @Test("rejects unroutable, malformed, or certificate-mismatched host bindings")
    func rejectsUnsafeHostBinding() throws {
        try withParent { parent in
            let server = try HivraMoonlightProfile.prepare(
                in: parent, sessionId: UUID(), clientId: UUID()
            )
            for host in [
                HivraMoonlightPairedHost(serverId: UUID(), serverCertificatePEM: server.certificatePEM,
                    serverCertificateSHA256: server.certificateSHA256, directIPv4: "127.0.0.1"),
                HivraMoonlightPairedHost(serverId: UUID(), serverCertificatePEM: server.certificatePEM,
                    serverCertificateSHA256: String(repeating: "0", count: 64), directIPv4: "10.242.1.3"),
                HivraMoonlightPairedHost(serverId: UUID(), serverCertificatePEM: "not a certificate",
                    serverCertificateSHA256: server.certificateSHA256, directIPv4: "10.242.1.3"),
            ] {
                let profile = try HivraMoonlightProfile.prepare(
                    in: parent, sessionId: UUID(), clientId: UUID()
                )
                #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                    try profile.bind(pairedHost: host)
                }
                let ini = try String(contentsOf: profile.settingsURL, encoding: .utf8)
                #expect(!ini.contains("[hosts]"))
            }
        }
    }

    @Test("does not regenerate or adopt an existing session profile")
    func refusesReplay() throws {
        try withParent { parent in
            let session = UUID()
            let first = try HivraMoonlightProfile.prepare(in: parent, sessionId: session, clientId: UUID())
            let original = try Data(contentsOf: first.settingsURL)
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try HivraMoonlightProfile.prepare(in: parent, sessionId: session, clientId: UUID())
            }
            #expect(try Data(contentsOf: first.settingsURL) == original)
        }
    }

    @Test("refuses a shared parent without changing its permissions")
    func refusesSharedParent() throws {
        try withParent { parent in
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path)
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            }
            #expect(try FileManager.default.contentsOfDirectory(atPath: parent.path).isEmpty)
            let attributes = try FileManager.default.attributesOfItem(atPath: parent.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o755)
        }
    }

    @Test("refuses a symlinked profile parent")
    func refusesLinkedParent() throws {
        try withParent { parent in
            let link = parent.appending(path: "link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: parent)
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try HivraMoonlightProfile.prepare(in: link, sessionId: UUID(), clientId: UUID())
            }
        }
    }

    @Test("does not remove a replacement profile when certificate generation fails")
    func preservesReplacementOnFailure() throws {
        try withParent { parent in
            let session = UUID()
            let directory = parent.appending(path: session.uuidString.lowercased())
            let displaced = parent.appending(path: "original")
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try HivraMoonlightProfile.prepare(in: parent, sessionId: session, clientId: UUID(), generate: { _, _ in
                    try FileManager.default.moveItem(at: directory, to: displaced)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                           attributes: [.posixPermissions: 0o700])
                    try Data("preserve".utf8).write(to: directory.appending(path: "foreign"))
                    throw HivraMoonlightProfile.ProfileError.certificateGenerationFailed
                })
            }
            let preserved = try String(contentsOf: directory.appending(path: "foreign"), encoding: .utf8)
            #expect(preserved == "preserve")
            #expect(FileManager.default.fileExists(atPath: displaced.path))
        }
    }

    @Test("refuses inherited ACL access despite private POSIX mode bits")
    func refusesInheritedACL() throws {
        try withParent { parent in
            let chmod = Process()
            chmod.executableURL = URL(filePath: "/bin/chmod")
            chmod.arguments = ["+a", "everyone allow read,execute,file_inherit,directory_inherit", parent.path]
            try chmod.run()
            chmod.waitUntilExit()
            #expect(chmod.terminationStatus == 0)
            #expect(throws: HivraMoonlightProfile.ProfileError.self) {
                try HivraMoonlightProfile.prepare(in: parent, sessionId: UUID(), clientId: UUID())
            }
            #expect(try FileManager.default.contentsOfDirectory(atPath: parent.path).isEmpty)
        }
    }
}
