import Foundation

/// The dashboard route grammar shared with the web client.
///
/// Every case in apps/shared/native-contract/route-grammar.v1.json must produce
/// the same result here and in dashboard/src/lib/native-route-grammar.ts, so a
/// route one side canonicalizes is always accepted by the other. The rules:
///
/// - Input is printable ASCII (no whitespace, controls, backslash or non-ASCII),
///   at most 2,048 bytes, and rooted at `/dashboard`. A fragment is discarded.
/// - Each path segment is percent-decoded once and must then be non-empty RFC 3986
///   unreserved text other than `.` and `..`, so encoded separators, traversal and
///   double encoding are rejected.
/// - Each query parameter is decoded once to printable ASCII, named at most once,
///   and either kept (validated and canonicalized), discarded because the page
///   consumed it on arrival, or the whole route is rejected. Kept parameters are
///   written in a fixed per-route order, so a canonical route is a fixed point.
enum HivraWorkspaceRouteGrammar {
    static let version = 1
    static let maximumLength = 2_048

    static func normalize(_ value: String) -> String? {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count <= maximumLength,
              bytes.allSatisfy({ (0x21...0x7E).contains($0) && $0 != UInt8(ascii: "\\") }) else { return nil }
        let reference = bytes.split(separator: UInt8(ascii: "#"), maxSplits: 1, omittingEmptySubsequences: false).first ?? []
        let parts = reference.split(separator: UInt8(ascii: "?"), maxSplits: 1, omittingEmptySubsequences: false)
        let rawPath = parts.first ?? []
        guard rawPath.first == UInt8(ascii: "/"), rawPath.dropFirst().first != UInt8(ascii: "/") else { return nil }

        var rawSegments = rawPath.dropFirst().split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false)
        if rawSegments.count > 1, rawSegments.last?.isEmpty == true { rawSegments.removeLast() }
        var segments: [String] = []
        for rawSegment in rawSegments {
            guard let segment = percentDecoded(rawSegment), !segment.isEmpty, segment != ".", segment != "..",
                  segment.utf8.allSatisfy(isUnreserved) else { return nil }
            segments.append(segment)
        }
        guard segments.first == "dashboard" else { return nil }

        var parameters: [String: String] = [:]
        if parts.count == 2, !parts[1].isEmpty {
            for pair in parts[1].split(separator: UInt8(ascii: "&"), omittingEmptySubsequences: false) {
                let field = pair.split(separator: UInt8(ascii: "="), maxSplits: 1, omittingEmptySubsequences: false)
                guard let name = percentDecoded(field[0]), isParameterName(name), parameters[name] == nil,
                      let value = field.count == 2 ? percentDecoded(field[1]) : "" else { return nil }
                parameters[name] = value
            }
        }

        let rule = Rule.of(Array(segments.dropFirst()))
        var kept: [String: String] = [:]
        for (name, value) in parameters where !Rule.globallyDiscarded.contains(name) && !rule.discarded.contains(name) {
            guard let canonical = rule.kept.first(where: { $0.name == name })?.value.canonical(value) else { return nil }
            kept[name] = canonical
        }
        for parameter in rule.kept where kept[parameter.name] != nil {
            if let requirement = parameter.requires, kept[requirement.name] != requirement.value { return nil }
        }
        let query = rule.kept.compactMap { parameter in kept[parameter.name].map { "\(parameter.name)=\($0)" } }
        let route = "/" + segments.joined(separator: "/") + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        return route.utf8.count <= maximumLength ? route : nil
    }

    /// Decodes each escape once. Every decoded byte must be printable ASCII, so no
    /// platform's Unicode or `+` handling can make the two implementations differ.
    private static func percentDecoded<Bytes: Collection<UInt8>>(_ raw: Bytes) -> String? {
        let raw = Array(raw)
        var output: [UInt8] = []
        var index = 0
        while index < raw.count {
            var byte = raw[index]
            if byte == UInt8(ascii: "%") {
                guard index + 2 < raw.count, let high = hexValue(raw[index + 1]), let low = hexValue(raw[index + 2]) else { return nil }
                byte = high << 4 | low
                index += 3
            } else {
                index += 1
            }
            guard (0x21...0x7E).contains(byte) else { return nil }
            output.append(byte)
        }
        return String(decoding: output, as: UTF8.self)
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
        default: nil
        }
    }

    private static func isUnreserved(_ byte: UInt8) -> Bool {
        isAlphanumeric(byte) || [UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~")].contains(byte)
    }

    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
            || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
    }

    private static func isParameterName(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z][A-Za-z0-9_]{0,63}$", options: .regularExpression) != nil
    }
}

extension HivraWorkspaceRouteGrammar {
    enum Value: Sendable {
        case matching(String, lowercased: Bool = false)
        case oneOf(Set<String>)
        /// Accepted spellings and the value each one canonicalizes to.
        case mapped([String: String])

        func canonical(_ value: String) -> String? {
            switch self {
            case .matching(let pattern, let lowercased):
                guard value.range(of: pattern, options: .regularExpression) != nil else { return nil }
                return lowercased ? value.lowercased() : value
            case .oneOf(let values): return values.contains(value) ? value : nil
            case .mapped(let values): return values[value]
            }
        }

        static let surface = Value.matching("^[a-z][a-z0-9_-]{0,63}$")
        static let one = Value.oneOf(["1"])
        static let uuid = Value.matching("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", lowercased: true)
        /// A launch draft id (launch-plan.ts LAUNCH_DRAFT_ID).
        static let launchDraft = Value.matching("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$", lowercased: true)
        /// A template id, slug or share token (launch-template.ts TEMPLATE_REF).
        static let templateReference = Value.matching("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
        static let resourceID = Value.matching("^[A-Za-z0-9_-]{1,256}$")
        /// LaunchProfileId (launch/contracts.ts).
        static let launchProfile = Value.oneOf(["claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon",
                                                "ubuntu-desktop", "linux-terminal", "omarchy", "windows"])
        /// Launch history stages, including the names used before Choose merged its steps (LaunchJourney).
        static let launchStage = Value.mapped(["choose": "choose", "plan": "plan", "review": "review",
                                               "type": "choose", "profile": "choose", "capacity": "plan"])
        /// "1", or the paid plan an upgrade moved to (subscription PLAN_ORDER without free).
        static let launchUpgrade = Value.oneOf(["1", "operator", "fleet", "command"])
        /// PortableLaunchResourceId (hivra/launch-navigation.ts).
        static let portableLaunchResource = Value.oneOf(["claude-code", "codex", "aeon", "openclaw", "agent-zero",
                                                         "linux-desktop", "linux-terminal", "windows"])
    }

    struct Parameter: Sendable {
        let name: String
        let value: Value
        var requires: (name: String, value: String)?

        init(_ name: String, _ value: Value, requires: (name: String, value: String)? = nil) {
            self.name = name
            self.value = value
            self.requires = requires
        }
    }

    struct Rule: Sendable {
        let kept: [Parameter]
        var discarded: Set<String> = []

        /// A client flag hint the agent page appends when it leaves a resource.
        static let globallyDiscarded: Set<String> = ["hivra"]
        static let tab = Parameter("tab", .surface)

        /// `route` is the canonical path below /dashboard.
        static func of(_ route: [String]) -> Rule {
            switch route {
            case []:
                // The shell owns Home, so the web list request is not a route; needs-attention is a view.
                return Rule(kept: [tab, Parameter("attention", .one)], discarded: ["runtimes"])
            case ["computers"]:
                return Rule(kept: [tab, Parameter("launch", .one), Parameter("targetId", .uuid)])
            case ["computers", "recovery"]:
                return Rule(kept: [tab, Parameter("source", .resourceID)])
            case ["launch"]:
                return Rule(kept: [
                    Parameter("kind", .oneOf(["agent", "computer"])), Parameter("start", .one),
                    Parameter("profile", .launchProfile), Parameter("template", .templateReference),
                    Parameter("templateToken", .templateReference), Parameter("targetId", .uuid),
                    Parameter("draft", .launchDraft), Parameter("upgraded", .launchUpgrade),
                    Parameter("stage", .launchStage),
                ])
            case ["infrastructure"]:
                return Rule(kept: [tab, Parameter("launch", .portableLaunchResource),
                                   Parameter("returnTo", .oneOf(["unified-launch"])), Parameter("replaceToken", .uuid)])
            case let resource where resource.count == 2 && resource[0] == "agent" && HivraWorkspaceRoute.isResourceID(resource[1]):
                // A launch result arrives with welcome (and Codex's #model-settings); the page consumes these once.
                return Rule(kept: [tab, Parameter("open", .oneOf(["fast", "native"]), requires: ("tab", "desktop"))],
                            discarded: ["welcome", "prepare", "tools"])
            case let resource where resource.count == 2 && resource[0] == "instances" && HivraWorkspaceRoute.isResourceID(resource[1]):
                return Rule(kept: [tab, Parameter("surface", .oneOf(["chat"]))], discarded: ["welcome", "connect", "focus"])
            default:
                return Rule(kept: [tab])
            }
        }
    }
}
