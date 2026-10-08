import Foundation

public enum HivraWorkspaceResourceSource: String, Hashable, Sendable {
    case hermes, hivra
    public var prefix: String { self == .hermes ? "h-" : "x-" }
}

public enum HivraWorkspaceResourceKind: String, Hashable, Sendable {
    case agent, computer
}

public struct HivraWorkspaceResource: Equatable, Hashable, Sendable {
    public let uid: String
    public let id: String
    public let source: HivraWorkspaceResourceSource
    public let kind: HivraWorkspaceResourceKind
    public let name: String
    public let description: String
    public let status: String
    public let href: String

    public init(uid: String, id: String, source: HivraWorkspaceResourceSource, kind: HivraWorkspaceResourceKind,
                name: String, description: String, status: String, href: String) {
        self.uid = uid
        self.id = id
        self.source = source
        self.kind = kind
        self.name = name
        self.description = description
        self.status = status
        self.href = href
    }
}

public struct HivraWorkspaceSnapshot: Equatable, Sendable {
    public let ownerKey: String?
    public let resources: [HivraWorkspaceResource]
    public let loading: Bool
    public let errors: [HivraWorkspaceResourceSource: String]

    public init(ownerKey: String?, resources: [HivraWorkspaceResource], loading: Bool,
                errors: [HivraWorkspaceResourceSource: String]) {
        self.ownerKey = ownerKey
        self.resources = resources
        self.loading = loading
        self.errors = errors
    }
}

public struct HivraWorkspaceSurface: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct HivraSurfaceSnapshot: Equatable, Sendable {
    public let pathname: String
    public let active: String
    public let surfaces: [HivraWorkspaceSurface]

    public init(pathname: String, active: String, surfaces: [HivraWorkspaceSurface]) {
        self.pathname = pathname
        self.active = active
        self.surfaces = surfaces
    }
}

/// A bounded display projection. Unknown fields are rejected, including credential-bearing extensions.
public enum HivraWorkspaceBridgeMessage: Equatable, Sendable {
    case workspace(HivraWorkspaceSnapshot)
    case surfaces(HivraSurfaceSnapshot)

    public static func parse(_ body: Any) -> Self? {
        guard let value = body as? [String: Any], let version = value["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1 else { return nil }
        switch value["kind"] as? String {
        case "workspace": return parseWorkspace(value).map(Self.workspace)
        case "surfaces": return parseSurfaces(value).map(Self.surfaces)
        default: return nil
        }
    }

    private static func parseWorkspace(_ value: [String: Any]) -> HivraWorkspaceSnapshot? {
        guard Set(value.keys) == ["version", "kind", "ownerKey", "resources", "loading", "errors"],
              let rows = value["resources"] as? [[String: Any]], rows.count <= 2_000,
              let loading = value["loading"] as? NSNumber, CFGetTypeID(loading) == CFBooleanGetTypeID(),
              let errorValues = value["errors"] as? [String: Any], errorValues.count <= 2 else { return nil }
        let owner = HivraWorkspaceValidation.text(value["ownerKey"], limit: 256)
        guard owner != nil || value["ownerKey"] is NSNull else { return nil }
        var errors: [HivraWorkspaceResourceSource: String] = [:]
        for (key, candidate) in errorValues {
            guard let source = HivraWorkspaceResourceSource(rawValue: key) else { return nil }
            if candidate is NSNull { continue }
            guard let error = HivraWorkspaceValidation.text(candidate, limit: 512) else { return nil }
            errors[source] = error
        }
        var resources: [HivraWorkspaceResource] = []
        var seen = Set<String>()
        for row in rows {
            guard let resource = parseResource(row), seen.insert(resource.uid).inserted else { return nil }
            resources.append(resource)
        }
        guard owner != nil || (resources.isEmpty && errors.isEmpty && !loading.boolValue) else { return nil }
        return HivraWorkspaceSnapshot(ownerKey: owner, resources: resources, loading: loading.boolValue, errors: errors)
    }

    private static func parseResource(_ row: [String: Any]) -> HivraWorkspaceResource? {
        guard Set(row.keys) == ["uid", "id", "source", "kind", "name", "description", "status", "href"],
              let sourceValue = row["source"] as? String, let source = HivraWorkspaceResourceSource(rawValue: sourceValue),
              let kindValue = row["kind"] as? String, let kind = HivraWorkspaceResourceKind(rawValue: kindValue),
              source != .hermes || kind == .agent,
              let id = row["id"] as? String, HivraWorkspaceRoute.isResourceID(id),
              let uid = row["uid"] as? String, uid == source.prefix + id,
              let name = HivraWorkspaceValidation.text(row["name"], limit: 256),
              let description = HivraWorkspaceValidation.text(row["description"], limit: 512, allowEmpty: true),
              let status = HivraWorkspaceValidation.text(row["status"], limit: 80),
              let hrefValue = row["href"] as? String, let href = HivraWorkspaceRoute.normalizedPath(hrefValue),
              let route = URLComponents(string: href),
              route.path == (source == .hermes ? "/dashboard/instances/\(id)" : "/dashboard/agent/\(id)") else { return nil }
        return HivraWorkspaceResource(uid: uid, id: id, source: source, kind: kind, name: name,
                                      description: description, status: status, href: href)
    }

    private static func parseSurfaces(_ value: [String: Any]) -> HivraSurfaceSnapshot? {
        guard Set(value.keys) == ["version", "kind", "pathname", "active", "surfaces"],
              let pathValue = value["pathname"] as? String, !pathValue.contains("?"), !pathValue.contains("#"),
              let pathname = HivraWorkspaceRoute.normalizedPath(pathValue), !pathname.contains("?"),
              let active = value["active"] as? String,
              let rows = value["surfaces"] as? [[String: Any]], rows.count <= 32 else { return nil }
        var surfaces: [HivraWorkspaceSurface] = []
        var seen = Set<String>()
        for row in rows {
            guard Set(row.keys) == ["id", "label"], let id = row["id"] as? String,
                  HivraWorkspaceRoute.isSurfaceID(id), seen.insert(id).inserted,
                  let label = HivraWorkspaceValidation.text(row["label"], limit: 128) else { return nil }
            surfaces.append(HivraWorkspaceSurface(id: id, label: label))
        }
        guard surfaces.isEmpty ? active.isEmpty : seen.contains(active) else { return nil }
        return HivraSurfaceSnapshot(pathname: pathname, active: active, surfaces: surfaces)
    }
}

enum HivraWorkspaceValidation {
    static func text(_ value: Any?, limit: Int, allowEmpty: Bool = false) -> String? {
        guard let text = value as? String, text.utf8.count <= limit,
              allowEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return text
    }
}
