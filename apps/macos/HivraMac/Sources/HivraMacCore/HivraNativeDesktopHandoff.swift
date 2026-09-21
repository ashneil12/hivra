import Foundation

public struct HivraNativeDesktopProfileRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.prepare-profile.v1"

    public let sessionId: UUID
    public let streamingMode: HivraStreamingMode

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 3,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = UUID(uuidString: rawSession),
              sessionId.uuidString.lowercased() == rawSession.lowercased(),
              let rawMode = value["streamingMode"] as? String,
              let streamingMode = HivraStreamingMode(rawValue: rawMode) else {
            return nil
        }
        return Self(sessionId: sessionId, streamingMode: streamingMode)
    }
}

public struct HivraNativeDesktopDiscardRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.discard-profile.v1"

    public let sessionId: UUID

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 2,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = UUID(uuidString: rawSession),
              sessionId.uuidString.lowercased() == rawSession.lowercased() else {
            return nil
        }
        return Self(sessionId: sessionId)
    }
}

public struct HivraNativeDesktopStopRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.stop.v1"

    public let sessionId: UUID
    public let processIdentifier: Int32

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 3,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = UUID(uuidString: rawSession),
              sessionId.uuidString.lowercased() == rawSession.lowercased(),
              let number = value["processIdentifier"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.int64Value > 0, number.int64Value <= Int64(Int32.max),
              NSNumber(value: number.int64Value) == number else { return nil }
        return Self(sessionId: sessionId, processIdentifier: number.int32Value)
    }
}

public struct HivraNativeDesktopStatusRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.status.v1"

    public let sessionId: UUID
    public let processIdentifier: Int32

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 3,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = UUID(uuidString: rawSession),
              sessionId.uuidString.lowercased() == rawSession.lowercased(),
              let number = value["processIdentifier"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.int64Value > 0, number.int64Value <= Int64(Int32.max),
              NSNumber(value: number.int64Value) == number else { return nil }
        return Self(sessionId: sessionId, processIdentifier: number.int32Value)
    }
}

public struct HivraNativeDesktopFocusRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.focus.v1"

    public let sessionId: UUID
    public let processIdentifier: Int32

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 3,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = UUID(uuidString: rawSession),
              sessionId.uuidString.lowercased() == rawSession.lowercased(),
              let number = value["processIdentifier"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.int64Value > 0, number.int64Value <= Int64(Int32.max),
              NSNumber(value: number.int64Value) == number else { return nil }
        return Self(sessionId: sessionId, processIdentifier: number.int32Value)
    }
}

public struct HivraNativeDesktopLaunchRequest: Equatable, Sendable {
    public static let protocolName = "hivra.native-desktop.launch.v1"

    public let sessionId: UUID
    public let serverId: UUID
    public let serverCertificatePEM: String
    public let serverCertificateSHA256: String
    public let guestBootId: UUID
    public let connectionIPv4: String
    public let transport: String

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], value.count == 8,
              value["type"] as? String == protocolName,
              let rawSession = value["sessionId"] as? String,
              let sessionId = canonicalUUID(rawSession),
              let rawServer = value["serverId"] as? String,
              let serverId = canonicalUUID(rawServer),
              let rawBoot = value["guestBootId"] as? String,
              let guestBootId = canonicalUUID(rawBoot),
              let certificate = value["serverCertificatePem"] as? String,
              certificate.utf8.count >= 64, certificate.utf8.count <= 16_384,
              certificate.hasPrefix("-----BEGIN CERTIFICATE-----\n"),
              certificate.hasSuffix("-----END CERTIFICATE-----\n"),
              !certificate.contains("PRIVATE KEY"),
              let fingerprint = value["serverCertificateSha256"] as? String,
              fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let connectionIPv4 = value["connectionIpv4"] as? String,
              isRoutableIPv4(connectionIPv4),
              let transport = value["transport"] as? String,
              transport == "direct" || transport == "relay" else { return nil }
        return Self(sessionId: sessionId, serverId: serverId,
                    serverCertificatePEM: certificate,
                    serverCertificateSHA256: fingerprint, guestBootId: guestBootId,
                    connectionIPv4: connectionIPv4, transport: transport)
    }

    private static func canonicalUUID(_ value: String) -> UUID? {
        guard let parsed = UUID(uuidString: value),
              parsed.uuidString.lowercased() == value.lowercased() else { return nil }
        return parsed
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
}

public struct HivraTrustedWebOrigin: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        guard (1...65_535).contains(port) else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    public func matches(scheme: String, host: String, port: Int) -> Bool {
        self.scheme == scheme.lowercased() && self.host == host.lowercased()
            && self.port == (port == 0 ? (scheme.lowercased() == "https" ? 443 : 80) : port)
    }
}
