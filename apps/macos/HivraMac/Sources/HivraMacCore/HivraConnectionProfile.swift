import Foundation

public enum HivraConnectionKind: String, Codable, CaseIterable, Sendable {
    case local
    case hivraCloud
    case custom

    public var displayName: String {
        switch self {
        case .local:
            "Local"
        case .hivraCloud:
            "Hivra Cloud"
        case .custom:
            "Custom"
        }
    }
}

public struct HivraConnectionProfile: Identifiable, Codable, Hashable, Sendable {
    public static let builtInLocalID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    public static let builtInCanaryID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    public static let builtInHivraID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!

    /// Hivra itself. The only connection a public build shows.
    public static let hivra = HivraConnectionProfile(
        id: builtInHivraID,
        name: "Hivra",
        url: URL(string: "https://hivra.cloud/dashboard")!,
        kind: .hivraCloud
    )

    public enum ValidationError: LocalizedError {
        case emptyAddress
        case unsupportedScheme
        case missingHost

        public var errorDescription: String? {
            switch self {
            case .emptyAddress:
                "Enter a Hivra address."
            case .unsupportedScheme:
                "Hivra connections must use HTTP or HTTPS."
            case .missingHost:
                "That address does not contain a valid host."
            }
        }
    }

    public let id: UUID
    public var name: String
    public var url: URL
    public var kind: HivraConnectionKind

    public init(
        id: UUID = UUID(),
        name: String,
        url: URL,
        kind: HivraConnectionKind
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.kind = kind
    }

    /// Hivra first. Local and Canary only when developer connections are on
    /// (an internal build, or the setting in App settings).
    public static func defaults(includeDeveloper: Bool) -> [HivraConnectionProfile] {
        includeDeveloper ? [hivra] + developerDefaults : [hivra]
    }

    /// Kept for existing callers: every built-in connection.
    public static var defaults: [HivraConnectionProfile] { defaults(includeDeveloper: true) }

    /// Saved connections from an earlier version gain Hivra at the top, once.
    public static func addingHivra(to saved: [HivraConnectionProfile]) -> [HivraConnectionProfile] {
        saved.contains(where: { $0.id == builtInHivraID }) ? saved : [hivra] + saved
    }

    private static let builtInCanaryURL: URL? = {
        #if HIVRA_PUBLIC_BUILD
        nil
        #else
        URL(string: "https://canary.hermesos.cloud/dashboard")
        #endif
    }()

    public static let developerDefaults: [HivraConnectionProfile] = [
        HivraConnectionProfile(
            id: builtInLocalID,
            name: "Local Hivra",
            url: URL(string: "http://127.0.0.1:3000/dashboard")!,
            kind: .local
        ),
    ] + (builtInCanaryURL.map {
        [HivraConnectionProfile(
            id: builtInCanaryID,
            name: "Hivra Canary",
            url: $0,
            kind: .hivraCloud
        )]
    } ?? [])

    public var isBuiltInLocal: Bool {
        id == Self.builtInLocalID &&
            kind == .local &&
            HivraLocalAuthentication.supportsAutomaticSignIn(to: url)
    }

    public var isBuiltInHivra: Bool {
        id == Self.builtInHivraID &&
            kind == .hivraCloud &&
            url.scheme?.lowercased() == "https" &&
            url.host?.lowercased() == "hivra.cloud" &&
            url.port == nil &&
            url.user == nil &&
            url.password == nil
    }

    public var isBuiltInCanary: Bool {
        guard let host = Self.builtInCanaryURL?.host else { return false }
        return id == Self.builtInCanaryID &&
            kind == .hivraCloud &&
            url.scheme?.lowercased() == "https" &&
            url.host?.lowercased() == host &&
            url.port == nil &&
            url.user == nil &&
            url.password == nil
    }

    public static func normalizedURL(from rawAddress: String) throws -> URL {
        let address = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else {
            throw ValidationError.emptyAddress
        }

        let hasScheme = address.range(
            of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#,
            options: .regularExpression
        ) != nil
        let isLocalAddress = address == "localhost" ||
            address.hasPrefix("localhost:") ||
            address == "127.0.0.1" ||
            address.hasPrefix("127.0.0.1:")
        let candidate = hasScheme
            ? address
            : "\(isLocalAddress ? "http" : "https")://\(address)"

        guard var components = URLComponents(string: candidate) else {
            throw ValidationError.missingHost
        }
        guard components.scheme == "http" || components.scheme == "https" else {
            throw ValidationError.unsupportedScheme
        }
        guard components.host?.isEmpty == false else {
            throw ValidationError.missingHost
        }

        if components.path.isEmpty || components.path == "/" {
            components.path = "/dashboard"
        }

        guard let url = components.url else {
            throw ValidationError.missingHost
        }
        return url
    }

    public func dashboardURL(path: String = "/dashboard") -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.path = path.hasPrefix("/") ? path : "/\(path)"
        components.query = nil
        components.fragment = nil
        return components.url ?? url
    }
}
