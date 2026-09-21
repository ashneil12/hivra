import CryptoKit
import Darwin
import Foundation
import Security

public struct HivraMoonlightPairedHost: Sendable {
    public let serverId: UUID
    public let serverCertificatePEM: String
    public let serverCertificateSHA256: String
    public let directIPv4: String

    public init(serverId: UUID, serverCertificatePEM: String,
                serverCertificateSHA256: String, directIPv4: String) {
        self.serverId = serverId
        self.serverCertificatePEM = serverCertificatePEM
        self.serverCertificateSHA256 = serverCertificateSHA256
        self.directIPv4 = directIPv4
    }
}

public enum HivraStreamingMode: String, CaseIterable, Identifiable, Sendable {
    public static let preferenceKey = "hivra.mac.streaming-mode.v1"
    case hq
    case qhd
    case uhd
    case performance

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .hq: "HQ"
        case .qhd: "QHD"
        case .uhd: "4K"
        case .performance: "Performance"
        }
    }

    public var summary: String {
        switch self {
        case .hq: "Sharper 1080p at 60 fps"
        case .qhd: "Sharper 1440p at 60 fps"
        case .uhd: "Ultra HD 4K at 60 fps"
        case .performance: "Faster 720p at 60 fps"
        }
    }

    var moonlightSettings: String {
        switch self {
        case .hq:
            return "width=1920\nheight=1080\nfps=60\nbitrate=25000\nframepacing=true\nvsync=true\n"
        case .qhd:
            return "width=2560\nheight=1440\nfps=60\nbitrate=40000\nframepacing=true\nvsync=true\n"
        case .uhd:
            return "width=3840\nheight=2160\nfps=60\nbitrate=65000\nframepacing=true\nvsync=true\n"
        case .performance:
            return "width=1280\nheight=720\nfps=60\nbitrate=12000\nframepacing=false\nvsync=true\n"
        }
    }
}

/// A private, unlaunched Moonlight identity for one controller session.
/// This does not pair, start a stream, exchange a lease, or release input.
public struct HivraMoonlightProfile: Sendable {
    public let sessionId: UUID
    public let clientId: UUID
    public let directory: URL
    public let settingsURL: URL
    public let streamingMode: HivraStreamingMode
    public let certificatePEM: String
    public let certificateSHA256: String
    private let directoryDevice: UInt64
    private let directoryInode: UInt64
    private let initialSettingsSHA256: String

    public enum ProfileError: Error {
        case privateParentRequired
        case sessionAlreadyExists
        case certificateGenerationFailed
        case certificateGenerationTimedOut
        case invalidCertificate
        case invalidHost
        case profileReplaced
    }

    /// Run off the UI thread. The caller must provide its private local profile
    /// parent; neither a path nor a command is accepted from web content.
    public static func prepare(
        in parent: URL,
        sessionId: UUID,
        clientId: UUID,
        pairedHost: HivraMoonlightPairedHost? = nil,
        streamingMode: HivraStreamingMode = .hq
    ) throws -> Self {
        try prepare(in: parent, sessionId: sessionId, clientId: clientId,
                    pairedHost: pairedHost, streamingMode: streamingMode,
                    generate: { try openssl($0, in: $1) })
    }

    static func prepare(in parent: URL, sessionId: UUID, clientId: UUID,
                        pairedHost: HivraMoonlightPairedHost? = nil,
                        streamingMode: HivraStreamingMode = .hq,
                        generate: ([String], URL) throws -> Data) throws -> Self {
        let files = FileManager.default
        let canonical = parent.standardizedFileURL
        var info = stat()
        guard parent.isFileURL,
              canonical.path == canonical.resolvingSymlinksInPath().path,
              lstat(canonical.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0, hasNoExtendedACL(canonical) else {
            throw ProfileError.privateParentRequired
        }
        let directory = canonical.appending(path: sessionId.uuidString.lowercased())
        guard mkdir(directory.path, 0o700) == 0 else {
            throw ProfileError.sessionAlreadyExists
        }
        var original = stat()
        guard lstat(directory.path, &original) == 0 else { throw ProfileError.profileReplaced }
        func unchanged() -> Bool {
            var currentParent = stat()
            var current = stat()
            return lstat(canonical.path, &currentParent) == 0 && lstat(directory.path, &current) == 0
                && currentParent.st_dev == info.st_dev && currentParent.st_ino == info.st_ino
                && currentParent.st_uid == info.st_uid && currentParent.st_mode == info.st_mode
                && current.st_dev == original.st_dev && current.st_ino == original.st_ino
                && current.st_uid == original.st_uid && current.st_mode == original.st_mode
                && hasNoExtendedACL(canonical) && hasNoExtendedACL(directory)
        }
        func requireOriginal() throws {
            guard unchanged() else { throw ProfileError.profileReplaced }
        }
        do {
            try requireOriginal()
            let config = directory.appending(path: "request.cnf")
            let certificate = directory.appending(path: "certificate.pem")
            let key = directory.appending(path: "key.pem")
            try privateFile(Data("""
                [req]
                distinguished_name=subject
                prompt=no
                x509_extensions=client
                [subject]
                CN=Hivra Session Client
                [client]
                basicConstraints=critical,CA:FALSE
                keyUsage=critical,digitalSignature,keyEncipherment

                """.utf8), at: config)
            _ = try generate(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
                             "-days", "1", "-config", config.path, "-extensions", "client",
                             "-keyout", key.path, "-out", certificate.path], directory)
            try requireOriginal()
            let pem = try String(contentsOf: certificate, encoding: .ascii)
            let keyPEM = try String(contentsOf: key, encoding: .ascii)
            let der = try generate(["x509", "-in", certificate.path, "-outform", "DER"], directory)
            try requireOriginal()
            guard pem.hasPrefix("-----BEGIN CERTIFICATE-----\n"),
                  keyPEM.contains("PRIVATE KEY-----\n"), !der.isEmpty, der.count < 16_384 else {
                throw ProfileError.invalidCertificate
            }

            // macOS QSettings uses the organization domain, including in
            // portable IniFormat. The display-name folder is not consumed.
            let organization = directory.appending(path: "moonlight-stream.com")
            try files.createDirectory(at: organization, withIntermediateDirectories: false,
                                      attributes: [.posixPermissions: 0o700])
            let settings = organization.appending(path: "Moonlight.ini")
            // Qt's portable IniFormat stores QByteArray PEM values in this
            // escaped representation. All key material remains local to this
            // private profile; only the public certificate is returned.
            var ini = "[General]\nuniqueid=\(clientId.uuidString.lowercased())\n"
                + "certificate=\(byteArray(pem))\nkey=\(byteArray(keyPEM))\n"
                + streamingMode.moonlightSettings
            if let pairedHost {
                ini += try pairedHostSettings(pairedHost, in: directory, generate: generate)
                try requireOriginal()
            }
            let settingsData = Data(ini.utf8)
            try privateFile(settingsData, at: settings)
            try privateFile(Data(), at: directory.appending(path: "portable.dat"))
            for temporary in [config, certificate, key] {
                try requireOriginal()
                try files.removeItem(at: temporary)
            }
            try requireOriginal()
            return Self(sessionId: sessionId, clientId: clientId, directory: directory,
                        settingsURL: settings, streamingMode: streamingMode, certificatePEM: pem,
                        certificateSHA256: SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined(),
                        directoryDevice: UInt64(original.st_dev), directoryInode: UInt64(original.st_ino),
                        initialSettingsSHA256: digest(settingsData))
        } catch {
            // Only the directory created exclusively above is ours. An older
            // profile is never adopted, regenerated or removed on failure.
            if unchanged() { try? files.removeItem(at: directory) }
            throw error
        }
    }

    /// Bind the already-created client identity to one exact ready Sunshine
    /// server. This is a one-time local transition; it never regenerates keys.
    public func bind(pairedHost: HivraMoonlightPairedHost) throws {
        try requireOriginalDirectory()
        let original = try Self.readPrivateFile(settingsURL)
        guard Self.digest(original) == initialSettingsSHA256,
              let ini = String(data: original, encoding: .utf8),
              !ini.contains("\n[hosts]\n") else {
            throw ProfileError.profileReplaced
        }
        let suffix = try Self.pairedHostSettings(
            pairedHost, in: directory, generate: { try Self.openssl($0, in: $1) }
        )
        try requireOriginalDirectory()
        let updated = Data((ini + suffix).utf8)
        let replacement = settingsURL.appendingPathExtension("bound")
        do {
            try Self.privateFile(updated, at: replacement)
            try requireOriginalDirectory()
            guard rename(replacement.path, settingsURL.path) == 0 else {
                throw ProfileError.profileReplaced
            }
            try Self.syncDirectory(settingsURL.deletingLastPathComponent())
            try requireOriginalDirectory()
            guard Self.digest(try Self.readPrivateFile(settingsURL)) == Self.digest(updated) else {
                throw ProfileError.profileReplaced
            }
        } catch {
            if Self.isOriginalDirectory(directory, device: directoryDevice, inode: directoryInode) {
                try? FileManager.default.removeItem(at: replacement)
            }
            throw error
        }
    }

    /// Remove only the exact session directory created by this profile.
    public func remove() throws {
        guard Self.isOriginalDirectory(
            directory, device: directoryDevice, inode: directoryInode
        ) else {
            throw ProfileError.profileReplaced
        }
        try FileManager.default.removeItem(at: directory)
    }

    private func requireOriginalDirectory() throws {
        guard Self.isOriginalDirectory(
            directory, device: directoryDevice, inode: directoryInode
        ) else { throw ProfileError.profileReplaced }
    }

    private static func isOriginalDirectory(_ directory: URL, device: UInt64, inode: UInt64) -> Bool {
        var current = stat()
        return lstat(directory.path, &current) == 0
            && current.st_mode & S_IFMT == S_IFDIR
            && current.st_uid == getuid() && current.st_mode & 0o077 == 0
            && UInt64(current.st_dev) == device && UInt64(current.st_ino) == inode
            && hasNoExtendedACL(directory)
    }

    private static func pairedHostSettings(
        _ host: HivraMoonlightPairedHost,
        in directory: URL,
        generate: ([String], URL) throws -> Data
    ) throws -> String {
        guard isRoutableIPv4(host.directIPv4),
              host.serverCertificateSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              host.serverCertificatePEM.hasPrefix("-----BEGIN CERTIFICATE-----\n"),
              host.serverCertificatePEM.hasSuffix("-----END CERTIFICATE-----\n"),
              host.serverCertificatePEM.utf8.count <= 16_384 else {
            throw ProfileError.invalidHost
        }
        let certificate = directory.appending(path: "server-certificate.pem")
        try privateFile(Data(host.serverCertificatePEM.utf8), at: certificate)
        defer { try? FileManager.default.removeItem(at: certificate) }
        let der = try generate(["x509", "-in", certificate.path, "-outform", "DER"], directory)
        guard !der.isEmpty, der.count < 16_384,
              digest(der) == host.serverCertificateSHA256 else {
            throw ProfileError.invalidCertificate
        }
        return "\n[hosts]\nsize=1\n"
            + "1\\hostname=Hivra Computer\n1\\customname=false\n"
            + "1\\uuid=\(host.serverId.uuidString.lowercased())\n1\\mac=\n"
            + "1\\localaddress=\(host.directIPv4)\n1\\localport=47989\n"
            + "1\\remoteaddress=\n1\\remoteport=47989\n"
            + "1\\ipv6address=\n1\\ipv6port=47989\n"
            + "1\\manualaddress=\(host.directIPv4)\n1\\manualport=47989\n"
            + "1\\srvcert=\(byteArray(host.serverCertificatePEM))\n"
            + "1\\nvidiasw=false\n"
    }

    private static func isRoutableIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var octets: [UInt8] = []
        for part in parts {
            guard !part.isEmpty, part == "0" || part.first != "0",
                  part.allSatisfy(\.isNumber), let octet = UInt8(part) else { return false }
            octets.append(octet)
        }
        return octets[0] != 0 && octets[0] != 127 && octets[0] < 224
            && octets != [255, 255, 255, 255]
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func readPrivateFile(_ path: URL) throws -> Data {
        var before = stat()
        guard lstat(path.path, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_uid == getuid(), before.st_nlink == 1,
              before.st_mode & 0o077 == 0, before.st_size <= 131_072 else {
            throw ProfileError.profileReplaced
        }
        let data = try Data(contentsOf: path, options: .uncached)
        var after = stat()
        guard lstat(path.path, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              Int64(data.count) == before.st_size else {
            throw ProfileError.profileReplaced
        }
        return data
    }

    private static func syncDirectory(_ directory: URL) throws {
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw ProfileError.profileReplaced }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw ProfileError.profileReplaced }
    }

    private static func byteArray(_ value: String) -> String {
        "@ByteArray(" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n") + ")"
    }

    private static func privateFile(_ data: Data, at path: URL) throws {
        let descriptor = open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw ProfileError.certificateGenerationFailed }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.synchronize()
        try handle.close()
        guard hasNoExtendedACL(path) else { throw ProfileError.privateParentRequired }
    }

    private static func hasNoExtendedACL(_ path: URL) -> Bool {
        let descriptor = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else {
            // Darwin reports ENOENT for absent extended ACL metadata. This is
            // a valid open descriptor, not a failed pathname existence probe.
            return errno == ENOENT
        }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        var entry: acl_entry_t?
        errno = 0
        let result = acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry)
        // Reject any extended entry (including inheritance); never strip an
        // ACL from an existing parent to make a profile appear private.
        return result == -1 && errno == EINVAL
    }

    // The OS-supplied executable and fixed environment avoid a Homebrew or
    // PATH dependency. Output is public DER (or empty for key generation);
    // command stderr is never exposed because it can include file contents.
    static func openssl(_ arguments: [String], in directory: URL) throws -> Data {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/openssl")
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C", "OPENSSL_CONF": "/dev/null"]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let deadline = ProcessInfo.processInfo.systemUptime + 10
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        if process.isRunning {
            process.terminate()
            let shutdown = ProcessInfo.processInfo.systemUptime + 1
            while process.isRunning && ProcessInfo.processInfo.systemUptime < shutdown {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw ProfileError.certificateGenerationTimedOut
        }
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw ProfileError.certificateGenerationFailed
        }
        let data = try output.fileHandleForReading.readToEnd() ?? Data()
        guard data.count < 16_384 else { throw ProfileError.invalidCertificate }
        return data
    }
}

struct HivraMoonlightLaunchPlan: Equatable {
    let executable: URL
    let arguments: [String]
    let currentDirectory: URL
    let environment: [String: String]
}

public enum HivraMoonlightLauncher {
    public enum LaunchError: Error {
        case officialClientUnavailable
        case officialClientInvalid
    }

    private static let bundle = URL(filePath: "/Applications/Moonlight.app", directoryHint: .isDirectory)
    private static let executable = bundle.appending(path: "Contents/MacOS/Moonlight")
    private static let requirement = "anchor apple generic and identifier \"com.moonlight-stream.Moonlight\" "
        + "and certificate leaf[subject.OU] = \"45U78722YL\""

    /// Launch the fixed, signed Moonlight client from the isolated portable
    /// profile. Neither web content nor the server chooses an executable,
    /// application name, CLI option, environment variable, or local path.
    public static func launch(
        profile: HivraMoonlightProfile,
        pairedHost: HivraMoonlightPairedHost
    ) throws -> Process {
        try verifyOfficialClient()
        try profile.bind(pairedHost: pairedHost)
        let plan = launchPlan(profile: profile, host: pairedHost.directIPv4)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.currentDirectory
        process.environment = plan.environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    static func launchPlan(profile: HivraMoonlightProfile, host: String) -> HivraMoonlightLaunchPlan {
        let quality: [String]
        switch profile.streamingMode {
        case .hq:
            quality = ["--1080", "--fps", "60", "--bitrate", "25000", "--frame-pacing"]
        case .qhd:
            quality = ["--1440", "--fps", "60", "--bitrate", "40000", "--frame-pacing"]
        case .uhd:
            quality = ["--4K", "--fps", "60", "--bitrate", "65000", "--frame-pacing"]
        case .performance:
            quality = ["--720", "--fps", "60", "--bitrate", "12000", "--no-frame-pacing"]
        }
        return HivraMoonlightLaunchPlan(
            executable: executable,
            arguments: ["stream", host, "Desktop"] + quality + [
                "--vsync", "--absolute-mouse", "--capture-system-keys", "always",
                "--video-decoder", "hardware", "--display-mode", "windowed",
                "--keep-awake", "--no-audio-on-host", "--no-performance-overlay",
                "--no-multi-controller",
            ],
            currentDirectory: profile.directory,
            environment: [
                "PATH": "/usr/bin:/bin",
                "LANG": "en_US.UTF-8",
                "HOME": profile.directory.path,
                "TMPDIR": profile.directory.path + "/",
                "QT_SSL_USE_TEMPORARY_KEYCHAIN": "1",
            ]
        )
    }

    private static func verifyOfficialClient() throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess,
              let code else { throw LaunchError.officialClientUnavailable }
        var policy: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &policy) == errSecSuccess,
              let policy else { throw LaunchError.officialClientInvalid }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
        guard SecStaticCodeCheckValidity(code, flags, policy) == errSecSuccess,
              FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LaunchError.officialClientInvalid
        }
    }
}
