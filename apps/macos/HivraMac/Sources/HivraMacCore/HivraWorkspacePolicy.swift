import Foundation

/// Pure decisions shared by browser callbacks and inventory updates.
public enum HivraWorkspacePolicy {
    public enum Adoption: Equatable, Sendable {
        case unchanged
        case waitingForInventory(String)
        case adopt(HivraWorkspaceResource)
        case selectExisting(String)
        case leaveResource(String)
    }

    public static func adoption(path: String, currentUID: String?, resources: [HivraWorkspaceResource], openUIDs: Set<String>) -> Adoption {
        guard let path = HivraWorkspaceRoute.normalizedPath(path) else { return .unchanged }
        guard let uid = HivraWorkspaceRoute.resourceUID(for: path) else {
            return currentUID == nil ? .unchanged : .leaveResource(path)
        }
        guard uid != currentUID else { return .unchanged }
        guard let resource = resources.first(where: { $0.uid == uid }) else { return .waitingForInventory(uid) }
        return openUIDs.contains(uid) ? .selectExisting(uid) : .adopt(resource)
    }

    public static func invalidatesOwner(previous: String?, next: String?) -> Bool {
        previous != nil && previous != next
    }

    public static func shouldSelectAdoptedResource(hasSelectedTab: Bool, showingWebDestination: Bool,
                                                   hasObservedOwnedRoute: Bool, hasExplicitSelection: Bool) -> Bool {
        !hasSelectedTab && (showingWebDestination || (!hasObservedOwnedRoute && !hasExplicitSelection))
    }

    public static func destinationAfterResourceTransfer(_ destination: HivraWorkspaceDestination,
                                                        showingWebDestination: Bool) -> HivraWorkspaceDestination {
        // The old web destination moved into the resource tab; native inventory selections remain in place.
        showingWebDestination ? .overview : destination
    }

    public static func shouldAdoptConnectionDestination(routeChanged: Bool, hasSelectedTab: Bool,
                                                        isInitialOwnedRoute: Bool, hasExplicitSelection: Bool,
                                                        showingWebDestination: Bool) -> Bool {
        routeChanged && !hasSelectedTab && (!isInitialOwnedRoute || !hasExplicitSelection || showingWebDestination)
    }

    /// The canonical route a page on the trusted origin shows. One-shot arrival
    /// parameters and fragments do not change which resource or destination it is.
    public static func relativePath(url: URL, trustedURL: URL) -> String? {
        guard HivraWorkspaceBridgeTrust.accepts(trustedURL: trustedURL, frameURL: url, isMainFrame: true),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return HivraWorkspaceRoute.normalizedPath(components.percentEncodedPath + (components.percentEncodedQuery.map { "?\($0)" } ?? ""))
    }

    /// One-time guest transports may replace a resource tab with another origin.
    /// Re-selecting that resource must return through its canonical dashboard route
    /// so an expired handoff is renewed instead of being retained indefinitely.
    /// A page still on the resource's own route is live work (a chat, terminal or
    /// desktop) whatever its query says, so it is selected rather than reloaded.
    public static func shouldReloadResourceOnReselection(currentURL: URL?, trustedURL: URL,
                                                         requestedPath: String? = nil) -> Bool {
        let requested = requestedPath.flatMap(HivraWorkspaceRoute.normalizedPath)
        if let requested, let components = URLComponents(string: requested),
           components.queryItems?.contains(where: { $0.name == "open" }) == true {
            return true
        }
        guard let currentURL,
              HivraWorkspaceBridgeTrust.accepts(trustedURL: trustedURL, frameURL: currentURL, isMainFrame: true) else { return true }
        // A tab that moved to another page of the dashboard returns to its resource.
        guard let requested, let resource = HivraWorkspaceRoute.resourceUID(for: requested) else { return false }
        let currentPath = URLComponents(url: currentURL, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        return HivraWorkspaceRoute.resourceUID(for: currentPath) != resource
    }

    /// Authentication entry and the public signed-out landing page revoke native ownership.
    /// Ordinary dashboard reloads and unrelated public/guest pages do not.
    public static func isCommittedAccountEntry(url: URL, trustedURL: URL) -> Bool {
        guard HivraWorkspaceBridgeTrust.accepts(trustedURL: trustedURL, frameURL: url, isMainFrame: true) else { return false }
        return url.path == "/" || ["/sign-in", "/sign-up", "/login"].contains { url.path == $0 || url.path.hasPrefix($0 + "/") }
    }

    public static func destination(for path: String) -> HivraWorkspaceDestination? {
        guard let normalized = HivraWorkspaceRoute.normalizedPath(path),
              let route = URLComponents(string: normalized) else { return nil }
        let part = route.path.split(separator: "/").dropFirst().first.map(String.init)
        switch part {
        case nil, "command", "ops", "insights": return .overview
        case "agents", "instances", "agent", "chat", "workspace", "runtimes": return .agents
        case "computers", "computer": return .computers
        case "activity", "usage": return .activity
        case "infrastructure": return .infrastructure
        case "launch", "welcome": return .launch
        case "settings", "billing", "wallet", "vault", "tools", "library", "templates": return .settings
        default: return nil
        }
    }

    public static func selectionAfterClosing(tabID: UUID, tabs: [UUID], selected: UUID?) -> UUID? {
        guard let index = tabs.firstIndex(of: tabID), selected == tabID else { return selected }
        let remaining = tabs.filter { $0 != tabID }
        return remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)]
    }
}
