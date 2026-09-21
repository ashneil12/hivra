import Foundation

public enum HivraWorkspaceDestination: String, CaseIterable, Codable, Sendable {
    case overview, agents, computers, activity, infrastructure, launch, settings

    public var path: String { self == .overview ? "/dashboard" : "/dashboard/\(rawValue)" }
    public var label: String { self == .overview ? "Home" : rawValue.capitalized }
}

/// Dashboard presentation routes only. Guest addresses and authentication parameters are not routes.
public enum HivraWorkspaceRoute {
    public static func normalizedPath(_ value: String) -> String? {
        guard !value.isEmpty, value.utf8.count <= 2_048,
              !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              !value.contains("\\"), !value.contains("#"),
              var components = URLComponents(string: value),
              components.scheme == nil, components.host == nil,
              components.user == nil, components.password == nil,
              components.port == nil else { return nil }
        let encodedPath = components.percentEncodedPath
        guard let path = encodedPath.removingPercentEncoding,
              !path.contains("%"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              encodedPath.range(of: "%2f|%5c", options: [.regularExpression, .caseInsensitive]) == nil,
              path == "/dashboard" || path.hasPrefix("/dashboard/") else { return nil }
        var segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if segments.last == "" { segments.removeLast() }
        guard segments.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        components.path = segments.joined(separator: "/")
        if let query = components.queryItems {
            if components.path == "/dashboard/launch" {
                guard query.count == 2, Set(query.map(\.name)) == ["kind", "start"],
                      let kind = query.first(where: { $0.name == "kind" })?.value,
                      ["agent", "computer"].contains(kind),
                      query.first(where: { $0.name == "start" })?.value == "1" else { return nil }
                components.queryItems = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "start", value: "1")]
            } else if components.path.hasPrefix("/dashboard/agent/"), query.count == 2,
                      Set(query.map(\.name)) == ["tab", "open"] {
                guard query.first(where: { $0.name == "tab" })?.value == "desktop",
                      let open = query.first(where: { $0.name == "open" })?.value,
                      ["fast", "native"].contains(open) else { return nil }
                components.queryItems = [URLQueryItem(name: "tab", value: "desktop"), URLQueryItem(name: "open", value: open)]
            } else {
                guard query.count == 1, let item = query.first, item.name == "tab",
                      let value = item.value, isSurfaceID(value) else { return nil }
                components.queryItems = [URLQueryItem(name: "tab", value: value)]
            }
        }
        guard let normalized = components.string, normalized.utf8.count <= 2_048 else { return nil }
        return normalized
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
