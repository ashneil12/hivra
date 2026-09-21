import Combine
import Foundation
import HivraMacCore

@MainActor
final class HivraWorkspaceTab: ObservableObject, Identifiable {
    let id = UUID()
    let browser: HivraBrowserModel
    @Published var resource: HivraWorkspaceResource
    @Published var pendingResourceUID: String?
    var resourceUID: String { pendingResourceUID ?? resource.uid }
    var displayName: String { pendingResourceUID == nil ? resource.name : "Resource" }

    init(resource: HivraWorkspaceResource, browser: HivraBrowserModel) {
        self.resource = resource
        self.browser = browser
    }
}

/// Retains each opened WebKit session independently of the visible native destination.
@MainActor
final class HivraWorkspaceSession: ObservableObject, Identifiable {
    let id: UUID
    let profile: HivraConnectionProfile
    @Published private(set) var connectionBrowser: HivraBrowserModel
    @Published private(set) var snapshot: HivraWorkspaceSnapshot?
    @Published private(set) var tabs: [HivraWorkspaceTab] = []
    @Published var selectedTabID: UUID?
    @Published var destination: HivraWorkspaceDestination = .overview
    @Published var query = ""
    @Published var statusFilter = "All"
    @Published private var showingWebDestination = false
    private var subscriptions = Set<AnyCancellable>()
    private var tabSubscriptions: [UUID: AnyCancellable] = [:]
    private var lastConnectionURL: URL?
    private var hasExplicitSelection = false

    init(profile: HivraConnectionProfile) {
        self.profile = profile
        id = profile.id
        connectionBrowser = HivraBrowserModel(initialURL: profile.url, nativeWorkspace: true)
        observeConnection()
    }

    var resources: [HivraWorkspaceResource] { snapshot?.resources ?? [] }
    var activeTab: HivraWorkspaceTab? { tabs.first { $0.id == selectedTabID } }
    var activeBrowser: HivraBrowserModel { activeTab?.browser ?? connectionBrowser }
    var isNativeDestination: Bool {
        selectedTabID == nil && snapshot?.ownerKey != nil && !showingWebDestination
            && [.overview, .agents, .computers].contains(destination)
    }

    func select(_ destination: HivraWorkspaceDestination) {
        hasExplicitSelection = true
        self.destination = destination
        selectedTabID = nil
        query = ""
        statusFilter = "All"
        showingWebDestination = ![.overview, .agents, .computers].contains(destination)
        if ![.overview, .agents, .computers].contains(destination) {
            connectionBrowser.navigateWorkspace(to: destination.path)
        }
    }

    func launch(kind: HivraWorkspaceResourceKind? = nil) {
        hasExplicitSelection = true
        destination = .launch
        selectedTabID = nil
        showingWebDestination = true
        let path = kind.map { "/dashboard/launch?kind=\($0.rawValue)&start=1" } ?? "/dashboard/launch"
        connectionBrowser.navigateWorkspace(to: path)
    }

    func open(_ resource: HivraWorkspaceResource) {
        guard snapshot?.ownerKey != nil,
              let resource = resources.first(where: { $0.uid == resource.uid }) else { return }
        hasExplicitSelection = true
        if let existing = tabs.first(where: { $0.resourceUID == resource.uid }) {
            if HivraWorkspacePolicy.shouldReloadResourceOnReselection(
                currentURL: existing.browser.currentURL,
                trustedURL: profile.url,
                requestedPath: resource.href
            ), let url = HivraWorkspaceRoute.url(for: resource.href, profile: profile) {
                existing.browser.load(url)
            }
            selectedTabID = existing.id
            return
        }
        guard let url = HivraWorkspaceRoute.url(for: resource.href, profile: profile) else { return }
        append(resource, browser: HivraBrowserModel(initialURL: url, nativeWorkspace: true))
    }

    func close(_ tab: HivraWorkspaceTab) {
        guard let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        let nextSelection = HivraWorkspacePolicy.selectionAfterClosing(tabID: tab.id, tabs: tabs.map(\.id), selected: selectedTabID)
        tab.browser.handleWorkspaceNavigation = nil
        tabs.remove(at: index)
        tabSubscriptions.removeValue(forKey: tab.id)
        selectedTabID = nextSelection
    }

    func closeCurrentTab() { if let activeTab { close(activeTab) } }

    func refresh() { connectionBrowser.refreshWorkspace() }

    func clearOwnedViews() {
        for tab in tabs { tab.browser.handleWorkspaceNavigation = nil }
        tabs.removeAll()
        tabSubscriptions.removeAll()
        selectedTabID = nil
        snapshot = nil
        destination = .overview
        showingWebDestination = false
        hasExplicitSelection = false
    }

    private func append(_ resource: HivraWorkspaceResource, browser: HivraBrowserModel, select: Bool = true) {
        let tab = HivraWorkspaceTab(resource: resource, browser: browser)
        tabs.append(tab)
        if select { selectedTabID = tab.id }
        browser.handleWorkspaceNavigation = { [weak self, weak tab] url in
            guard let self, let tab, tabs.contains(where: { $0.id == tab.id }),
                  let path = HivraWorkspacePolicy.relativePath(url: url, trustedURL: profile.url) else { return false }
            if let uid = HivraWorkspaceRoute.resourceUID(for: path) {
                guard uid != tab.resourceUID, let target = resources.first(where: { $0.uid == uid }) else { return false }
                open(target)
            } else {
                showDashboard(path)
            }
            return true
        }
        // Deliver after @Published assigns its new value, and never mutate subscriptions during initial sink delivery.
        tabSubscriptions[tab.id] = browser.$workspaceSnapshot.combineLatest(browser.$currentURL)
            .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
            .receive(on: RunLoop.main)
            .sink { [weak self, weak tab] update, url in
                guard let self, let tab, tabs.contains(where: { $0.id == tab.id }),
                      update == tab.browser.workspaceSnapshot, url == tab.browser.currentURL else { return }
                if let update, HivraWorkspacePolicy.invalidatesOwner(previous: snapshot?.ownerKey, next: update.ownerKey) {
                    clearOwnedViews()
                    connectionBrowser.clearWorkspaceMetadata()
                    connectionBrowser.load(profile.dashboardURL())
                    return
                }
                if let url { adoptTabRoute(tab, url: url) }
            }
    }

    private func observeConnection() {
        subscriptions.removeAll()
        let browser = connectionBrowser
        browser.$workspaceSnapshot.combineLatest(browser.$currentURL)
            .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
            .receive(on: RunLoop.main)
            .sink { [weak self, weak browser] update, url in
                guard let self, let browser, browser === connectionBrowser,
                      update == browser.workspaceSnapshot, url == browser.currentURL else { return }
                if let update {
                    if HivraWorkspacePolicy.invalidatesOwner(previous: snapshot?.ownerKey, next: update.ownerKey) { clearOwnedViews() }
                    snapshot = update
                    for tab in tabs {
                        if tab.pendingResourceUID == nil,
                           let resource = update.resources.first(where: { $0.uid == tab.resource.uid }) {
                            tab.resource = resource
                            tab.pendingResourceUID = nil
                        }
                        if let tabURL = tab.browser.currentURL { adoptTabRoute(tab, url: tabURL) }
                    }
                }
                if let url { adoptConnectionRoute(url) }
            }.store(in: &subscriptions)
    }

    private func adoptConnectionRoute(_ url: URL) {
        guard snapshot?.ownerKey != nil,
              let path = HivraWorkspacePolicy.relativePath(url: url, trustedURL: profile.url) else { return }
        let changed = url != lastConnectionURL
        let isInitialOwnedRoute = lastConnectionURL == nil
        let shouldSelect = HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: selectedTabID != nil,
            showingWebDestination: showingWebDestination, hasObservedOwnedRoute: lastConnectionURL != nil,
            hasExplicitSelection: hasExplicitSelection)
        lastConnectionURL = url
        switch HivraWorkspacePolicy.adoption(path: path, currentUID: nil, resources: resources, openUIDs: Set(tabs.map(\.resourceUID))) {
        case .adopt(let resource):
            let browser = connectionBrowser
            resetInventoryReturnDestination()
            connectionBrowser = HivraBrowserModel(initialURL: profile.dashboardURL(), nativeWorkspace: true)
            lastConnectionURL = nil
            append(resource, browser: browser, select: shouldSelect)
            observeConnection()
        case .selectExisting(let uid):
            if shouldSelect { selectedTabID = tabs.first(where: { $0.resourceUID == uid })?.id }
            // The inventory browser must not retain a duplicate running resource surface.
            resetInventoryReturnDestination()
            lastConnectionURL = nil
            connectionBrowser.navigateWorkspace(to: "/dashboard")
        case .waitingForInventory:
            if shouldSelect { showingWebDestination = true }
        case .unchanged, .leaveResource:
            if HivraWorkspacePolicy.shouldAdoptConnectionDestination(routeChanged: changed,
                hasSelectedTab: selectedTabID != nil, isInitialOwnedRoute: isInitialOwnedRoute,
                hasExplicitSelection: hasExplicitSelection, showingWebDestination: showingWebDestination),
               let route = HivraWorkspacePolicy.destination(for: path) {
                destination = route
                showingWebDestination = !["/dashboard", "/dashboard/agents", "/dashboard/computers"].contains(path)
            }
        }
    }

    private func resetInventoryReturnDestination() {
        destination = HivraWorkspacePolicy.destinationAfterResourceTransfer(destination, showingWebDestination: showingWebDestination)
        showingWebDestination = false
    }

    private func adoptTabRoute(_ tab: HivraWorkspaceTab, url: URL) {
        guard tabs.contains(where: { $0.id == tab.id }), snapshot?.ownerKey != nil,
              let path = HivraWorkspacePolicy.relativePath(url: url, trustedURL: profile.url) else { return }
        let openUIDs = Set(tabs.filter { $0.id != tab.id }.map(\.resourceUID))
        switch HivraWorkspacePolicy.adoption(path: path, currentUID: tab.resource.uid, resources: resources, openUIDs: openUIDs) {
        case .adopt(let resource):
            objectWillChange.send()
            tab.resource = resource
            tab.pendingResourceUID = nil
        case .selectExisting(let uid):
            let wasSelected = selectedTabID == tab.id
            close(tab)
            if wasSelected { selectedTabID = tabs.first(where: { $0.resourceUID == uid })?.id }
        case .waitingForInventory(let uid):
            if tab.pendingResourceUID != uid {
                objectWillChange.send()
                tab.pendingResourceUID = uid
                connectionBrowser.refreshWorkspace()
            }
        case .leaveResource(let path):
            let wasSelected = selectedTabID == tab.id
            close(tab)
            if wasSelected { showDashboard(path) }
        case .unchanged:
            if tab.pendingResourceUID != nil { objectWillChange.send(); tab.pendingResourceUID = nil }
        }
    }

    private func showDashboard(_ path: String) {
        let route = HivraWorkspacePolicy.destination(for: path) ?? .overview
        if ["/dashboard", "/dashboard/agents", "/dashboard/computers"].contains(path) {
            select(route)
        } else {
            destination = route
            selectedTabID = nil
            showingWebDestination = true
            connectionBrowser.navigateWorkspace(to: path)
        }
    }
}

@MainActor
final class HivraWorkspaceStore: ObservableObject {
    @Published private(set) var sessions: [UUID: HivraWorkspaceSession] = [:]

    func session(for profile: HivraConnectionProfile) -> HivraWorkspaceSession {
        if let existing = sessions[profile.id] { return existing }
        let session = HivraWorkspaceSession(profile: profile)
        sessions[profile.id] = session
        return session
    }

    func reconcile(profiles: [HivraConnectionProfile]) {
        let remaining = Set(profiles.map(\.id))
        sessions = sessions.filter { remaining.contains($0.key) }
    }
}
