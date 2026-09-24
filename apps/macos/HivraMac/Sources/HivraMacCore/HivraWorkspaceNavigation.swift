import Foundation

public enum HivraWorkspaceDestination: String, CaseIterable, Codable, Sendable {
    case overview, agents, computers, activity, infrastructure, launch, settings

    public var path: String { self == .overview ? "/dashboard" : "/dashboard/\(rawValue)" }
    public var label: String { self == .overview ? "Home" : rawValue.capitalized }
}

/// Dashboard presentation routes only. Guest addresses and authentication parameters are not routes.
public enum HivraWorkspaceRoute {
    public static let grammarVersion = HivraWorkspaceRouteGrammar.version

    /// The canonical dashboard route for `value`, or nil. Shared with the dashboard; see HivraWorkspaceRouteGrammar.
    public static func normalizedPath(_ value: String) -> String? {
        HivraWorkspaceRouteGrammar.normalize(value)
    }

    public static func url(for path: String, profile: HivraConnectionProfile) -> URL? {
        guard let normalized = normalizedPath(path),
              HivraTrustedWebOrigin(profile.url) != nil,
              var origin = URLComponents(url: profile.url, resolvingAgainstBaseURL: false),
              let route = URLComponents(string: normalized) else { return nil }
        origin.percentEncodedPath = route.percentEncodedPath
        origin.percentEncodedQuery = route.percentEncodedQuery
        origin.fragment = nil
        return origin.url
    }

    public static func resourceUID(for path: String) -> String? {
        guard let normalized = normalizedPath(path), let route = URLComponents(string: normalized) else { return nil }
        let segments = route.path.split(separator: "/")
        guard segments.count >= 3, isResourceID(String(segments[2])) else { return nil }
        switch segments[1] {
        case "instances": return "h-\(segments[2])"
        case "agent": return "x-\(segments[2])"
        default: return nil
        }
    }

    static func isResourceID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,256}$", options: .regularExpression) != nil
    }

    static func isSurfaceID(_ value: String) -> Bool {
        value.range(of: "^[a-z][a-z0-9_-]{0,63}$", options: .regularExpression) != nil
    }
}

/// A surface query or nested resource route keeps the same tab; profiles and signed-in owners never do.
public struct HivraWorkspaceTabIdentity: Hashable, Codable, Sendable {
    public let profileID: UUID
    public let ownerKey: String
    public let semanticKey: String

    public init?(profileID: UUID, ownerKey: String, path: String) {
        guard HivraWorkspaceValidation.text(ownerKey, limit: 256) != nil,
              let normalized = HivraWorkspaceRoute.normalizedPath(path) else { return nil }
        self.profileID = profileID
        self.ownerKey = ownerKey
        self.semanticKey = HivraWorkspaceRoute.resourceUID(for: normalized)
            .map { "resource:\($0)" } ?? "route:\(normalized)"
    }
}

public enum HivraWorkspaceBridgeTrust {
    public static func canonicalOrigin(_ url: URL) -> String? {
        guard let origin = HivraTrustedWebOrigin(url) else { return nil }
        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host.contains(":") && !origin.host.hasPrefix("[") ? "[\(origin.host)]" : origin.host
        if origin.port != (origin.scheme == "https" ? 443 : 80) { components.port = origin.port }
        return components.url?.absoluteString
    }

    public static func accepts(trustedURL: URL, frameURL: URL?, isMainFrame: Bool) -> Bool {
        guard isMainFrame, let frameURL,
              let trusted = HivraTrustedWebOrigin(trustedURL),
              let frame = HivraTrustedWebOrigin(frameURL) else { return false }
        return trusted == frame
    }
}
