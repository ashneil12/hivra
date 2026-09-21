import HivraMacCore
import SwiftUI

struct HivraRootView: View {
    @EnvironmentObject private var profileStore: HivraProfileStore
    @ObservedObject var localRuntime: HivraLocalRuntimeManager
    @StateObject private var workspaces = HivraWorkspaceStore()
    @State private var session: HivraWorkspaceSession?

    var body: some View {
        Group {
            if let session {
                HivraWorkspaceView(session: session, localRuntime: localRuntime)
                    .id(session.id)
            } else {
                ProgressView("Opening workspace…")
            }
        }
        .onAppear {
            activateConnection()
            localRuntime.reconcile()
        }
        .onDisappear {
            for session in workspaces.sessions.values { session.clearOwnedViews() }
        }
        .onChange(of: profileStore.selectedProfileID) { _, _ in activateConnection() }
        .onChange(of: profileStore.profiles) { _, profiles in
            workspaces.reconcile(profiles: profiles)
            activateConnection()
        }
        .onChange(of: localRuntime.readyGeneration) { _, _ in signInLocalConnection() }
        .onChange(of: localRuntime.credentialsGeneration) { _, _ in
            guard let local = workspaces.sessions.values.first(where: { $0.profile.isBuiltInLocal }) else { return }
            if localRuntime.savedCredentials == nil {
                local.clearOwnedViews()
                local.connectionBrowser.clearLocalSession(andLoad: local.profile.url)
            } else {
                signInLocalConnection()
            }
        }
    }

    private func activateConnection() {
        guard let profile = profileStore.selectedProfile else { session = nil; return }
        let alreadyOpen = workspaces.sessions[profile.id] != nil
        session = workspaces.session(for: profile)
        session?.onReturnToWorkspace = { [weak profileStore] in profileStore?.select(profile) }
        if !alreadyOpen && profile.isBuiltInLocal { signInLocalConnection() }
    }

    private func signInLocalConnection() {
        guard localRuntime.state == .running,
              let credentials = localRuntime.savedCredentials,
              let local = workspaces.sessions.values.first(where: { $0.profile.isBuiltInLocal }) else { return }
        local.connectionBrowser.load(local.profile.url, localCredentials: credentials)
    }
}

private struct HivraWorkspaceView: View {
    @ObservedObject var session: HivraWorkspaceSession
    @ObservedObject var localRuntime: HivraLocalRuntimeManager
    @EnvironmentObject private var profileStore: HivraProfileStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @State private var sidebarVisible = true
    @State private var showingSwitcher = false
    @State private var showingAddConnection = false
    @State private var showingLocalControls = false
    @State private var showingLocalSetup = false
    @State private var focused = false

    var body: some View {
        HSplitView {
            if sidebarVisible && !focused {
                sidebar
                    .frame(minWidth: 210, idealWidth: 238, maxWidth: 280)
                    .ignoresSafeArea(.container, edges: .top)
            }
            VStack(spacing: 0) {
                workspaceHeader
                if session.isNativeDestination {
                    if session.destination == .overview {
                        HivraNativeOverview(session: session)
                    } else {
                        HivraNativeInventory(session: session, kind: session.destination == .agents ? .agent : .computer)
                    }
                } else if let tab = session.activeTab, session.detachedWindows[tab.id] != nil {
                    ContentUnavailableView {
                        Label(tab.displayName, systemImage: "macwindow.on.rectangle")
                    } description: {
                        Text("This workspace is open in a separate window.")
                    } actions: {
                        Button("Show Window") { session.detach(tab) }
                        Button("Return to Hivra") { session.reattach(tab.id) }
                    }
                } else {
                    HivraFocusedWorkPane(
                        browser: session.activeBrowser,
                        profile: session.profile,
                        onDetach: detach,
                        onOpenLocalControls: session.profile.isBuiltInLocal ? { showingLocalControls = true } : nil,
                        onUseHivraCanary: canaryAction,
                        onAddConnection: { showingAddConnection = true }
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(HivraDesign.background(for: scheme))
            .ignoresSafeArea(.container, edges: .top)
        }
        .navigationTitle(windowTitle)
        .background(HivraDesign.surface(for: scheme))
        .ignoresSafeArea(.container, edges: .top)
        .tint(HivraDesign.crimson)
        .focusedSceneValue(\.hivraWorkspaceActions, HivraWorkspaceActions(
            switchResource: { showingSwitcher = true },
            home: { session.select(.overview) },
            agents: { session.select(.agents) },
            computers: { session.select(.computers) },
            launch: { session.launch() },
            closeTab: session.closeCurrentTab,
            openSeparateWindow: { if let tab = session.activeTab { detach(tab) } },
            focus: toggleFocus,
            toggleSidebar: toggleSidebar,
            refresh: { if session.isNativeDestination { session.refresh() } else { session.activeBrowser.reload() } },
            goBack: { session.activeBrowser.goBack() },
            goForward: { session.activeBrowser.goForward() },
            hasOpenTab: session.activeTab != nil
        ))
        .sheet(isPresented: $showingSwitcher) {
            HivraNativeSwitcher(session: session) { showingSwitcher = false }
        }
        .sheet(isPresented: $showingAddConnection) {
            HivraAddConnectionView().environmentObject(profileStore)
        }
        .sheet(isPresented: $showingLocalSetup) { HivraLocalSetupView(runtime: localRuntime) }
        .sheet(isPresented: $showingLocalControls) {
            VStack(alignment: .leading, spacing: 20) {
                HivraSheetHeader(eyebrow: "THIS MAC", title: "Local Hivra", detail: "Manage the workspace running on this computer.")
                HivraLocalControlPanel(runtime: localRuntime) {
                    showingLocalControls = false
                    showingLocalSetup = true
                }
                HStack { Spacer(); Button("Done") { showingLocalControls = false }.buttonStyle(HivraButtonStyle()).keyboardShortcut(.cancelAction) }
            }.padding(28).frame(width: 520)
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer(minLength: 80)
                sidebarToggle
            }
            .padding(.horizontal, 12)
            .frame(height: HivraWindowChrome.headerHeight)
            .background(HivraWindowDragRegion(title: windowTitle, onWindow: { session.workspaceWindow = $0 }))
            VStack(alignment: .leading, spacing: 19) {
                HivraWordmark().foregroundStyle(HivraDesign.foreground(for: scheme))
                connectionMenu
                Button { showingSwitcher = true } label: {
                    HStack {
                        Image(systemName: "magnifyingglass")
                        Text("Find a resource")
                        Spacer(minLength: 0)
                        Text("⌘K").font(.system(size: 10, design: .monospaced))
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).frame(height: 32)
                        .background(HivraDesign.background(for: scheme))
                        .overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
                }.buttonStyle(.plain)
            }.padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 18)

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(spacing: 3) {
                        destination(.overview, symbol: "square.grid.2x2")
                        destination(.agents, symbol: "sparkle")
                        destination(.computers, symbol: "desktopcomputer")
                        destination(.activity, symbol: "waveform.path")
                    }
                    resourceGroup(.agent, title: "AGENTS")
                    resourceGroup(.computer, title: "COMPUTERS")
                }.padding(.horizontal, 10).padding(.bottom, 16)
            }
            VStack(spacing: 3) {
                Divider().padding(.bottom, 8)
                destination(.infrastructure, symbol: "server.rack")
                Button { openSettings() } label: { sidebarLabel("App settings", symbol: "gearshape") }.buttonStyle(.plain)
                Button { session.select(.settings) } label: { sidebarLabel("Account", symbol: "person.crop.circle") }.buttonStyle(.plain)
                if session.profile.isBuiltInLocal {
                    Button { showingLocalControls = true } label: {
                        HStack {
                            sidebarLabel("Local runtime", symbol: "externaldrive")
                            Text(localRuntime.state.label).font(.system(size: 9)).foregroundStyle(.secondary).padding(.trailing, 8)
                        }
                    }.buttonStyle(.plain)
                }
                HStack(spacing: 6) {
                    Image(systemName: session.profile.isBuiltInLocal ? "laptopcomputer" : "network")
                    Text(session.profile.url.host ?? session.profile.name).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }.font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 12)
            }.padding(.horizontal, 10)
        }
        .background(HivraDesign.surface(for: scheme))
        .accessibilityIdentifier("native-workspace-sidebar")
    }

    private var connectionMenu: some View {
        Menu {
            ForEach(profileStore.profiles) { profile in
                Button { profileStore.select(profile) } label: {
                    Label(profile.name, systemImage: profile.id == session.profile.id ? "checkmark" : "network")
                }
            }
            Divider()
            Button("Add connection…") { showingAddConnection = true }
            Button("Manage connections…") { openSettings() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: session.profile.isBuiltInLocal ? "laptopcomputer" : "cloud")
                    .foregroundStyle(HivraDesign.crimson)
                Text(session.profile.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
            }
        }.menuStyle(.borderlessButton).help("Switch connection")
    }

    private func sidebarLabel(_ label: String, symbol: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 13)).frame(width: 18)
            Text(label).font(.system(size: 12))
            Spacer(minLength: 0)
        }.padding(.horizontal, 10).frame(height: 34).contentShape(Rectangle())
    }

    private func destination(_ destination: HivraWorkspaceDestination, symbol: String) -> some View {
        let selected = session.selectedTabID == nil && session.destination == destination
        return Button { session.select(destination) } label: {
            sidebarLabel(destination.label, symbol: symbol)
                .foregroundStyle(selected ? HivraDesign.foreground(for: scheme) : .secondary)
                .background(selected ? HivraDesign.foreground(for: scheme).opacity(0.07) : Color.clear)
                .overlay(alignment: .leading) { if selected { Rectangle().fill(HivraDesign.crimson).frame(width: 2) } }
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func resourceGroup(_ kind: HivraWorkspaceResourceKind, title: String) -> some View {
        let resources = session.resources.filter { $0.kind == kind }
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1)
                Text(resources.isEmpty && (session.snapshot?.ownerKey == nil || session.snapshot?.loading == true || session.snapshot?.errors.isEmpty == false) ? "—" : "\(resources.count)").font(.system(size: 9, design: .monospaced))
                Spacer()
                Button { session.launch(kind: kind) } label: { Image(systemName: "plus").font(.system(size: 10)) }
                    .buttonStyle(.plain).help(kind == .agent ? "New agent" : "New computer")
            }.foregroundStyle(.secondary).padding(.horizontal, 10)
            if resources.isEmpty {
                Text(session.snapshot?.ownerKey == nil ? "Open your workspace to load resources" : session.snapshot?.loading == true ? "Loading resources…" : session.snapshot?.errors.isEmpty == false ? "Resources unavailable" : "No \(kind == .agent ? "agents" : "computers") yet")
                    .font(.system(size: 11)).foregroundStyle(.tertiary).padding(.horizontal, 10).padding(.vertical, 6)
            } else {
                ForEach(resources, id: \.uid) { resource in
                    Button { session.open(resource) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: resource.symbol).font(.system(size: 12)).frame(width: 18).foregroundStyle(.secondary)
                            Text(resource.name).font(.system(size: 11)).lineLimit(1)
                            Spacer(minLength: 0)
                            HivraResourceStatus(resource: resource, showsLabel: false)
                        }.padding(.horizontal, 10).frame(height: 34).contentShape(Rectangle())
                            .background(session.activeTab?.resourceUID == resource.uid ? HivraDesign.foreground(for: scheme).opacity(0.07) : Color.clear)
                    }.buttonStyle(.plain).help("\(resource.name) · \(resource.statusLabel)")
                    .contextMenu {
                        Button("Open in Tab") { session.open(resource) }
                        Button("Open in Separate Window") {
                            if let tab = session.tabs.first(where: { $0.resourceUID == resource.uid }) {
                                detach(tab)
                            } else {
                                session.open(resource)
                                if let tab = session.activeTab { detach(tab) }
                            }
                        }
                    }
                }
            }
        }
    }

    private var workTabs: some View {
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(session.tabs) { tab in
                    HStack(spacing: 0) {
                        Button { session.selectedTabID = tab.id } label: {
                            HStack(spacing: 8) {
                                Image(systemName: tab.resource.symbol).font(.system(size: 11))
                                    .foregroundStyle(session.selectedTabID == tab.id ? HivraDesign.crimson : .secondary)
                                Text(tab.displayName)
                                    .font(.system(size: 11, weight: session.selectedTabID == tab.id ? .medium : .regular))
                                    .lineLimit(1).truncationMode(.middle)
                            }.padding(.leading, 11).padding(.trailing, 5).frame(height: 32).contentShape(Rectangle())
                        }.buttonStyle(.plain).help(tab.displayName)
                            .accessibilityAddTraits(session.selectedTabID == tab.id ? .isSelected : [])
                        Button { session.close(tab) } label: {
                            Image(systemName: "xmark").font(.system(size: 9)).frame(width: 24, height: 28).contentShape(Rectangle())
                        }.buttonStyle(.plain).help("Close \(tab.displayName)").accessibilityLabel("Close \(tab.displayName) tab")
                            .padding(.trailing, 6)
                    }.contextMenu {
                        Button("Open in Separate Window") { detach(tab) }
                        Divider()
                        Button("Close Tab") { session.close(tab) }
                    }.frame(maxWidth: 228).id(tab.id)
                        .background(session.selectedTabID == tab.id ? HivraDesign.foreground(for: scheme).opacity(0.07) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }.frame(height: 36)
            .accessibilityIdentifier("native-workspace-tabs")
            .onChange(of: session.selectedTabID) { _, selected in
                if let selected { proxy.scrollTo(selected, anchor: .center) }
            }
            .onAppear { if let selected = session.selectedTabID { proxy.scrollTo(selected, anchor: .center) } }
      }
    }

    private func toggleFocus() {
        focused.toggle()
    }

    private func toggleSidebar() {
        if focused {
            focused = false
            sidebarVisible = true
        } else {
            sidebarVisible.toggle()
        }
    }

    private var windowTitle: String {
        "\(session.activeTab?.displayName ?? session.destination.label) · \(session.profile.name)"
    }

    private var sidebarToggle: some View {
        Button(action: toggleSidebar) { Image(systemName: "sidebar.left") }
            .buttonStyle(HivraChromeButtonStyle())
            .help(sidebarVisible && !focused ? "Hide sidebar (⌥⌘S)" : "Show sidebar (⌥⌘S)")
            .accessibilityLabel(sidebarVisible && !focused ? "Hide sidebar" : "Show sidebar")
    }

    private var workspaceHeader: some View {
        HStack(spacing: 8) {
            if !sidebarVisible || focused {
                Color.clear.frame(width: 72)
                sidebarToggle
            }
            if !session.tabs.isEmpty && !focused {
                workTabs
            } else {
                Text(session.activeTab?.displayName ?? session.destination.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .padding(.leading, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .allowsHitTesting(false)
            }
            // A clear portion of the unified header always remains available to drag.
            Color.clear.frame(width: 24)
            Button { showingSwitcher = true } label: { Image(systemName: "magnifyingglass") }
                .buttonStyle(HivraChromeButtonStyle())
                .help("Switch resource (⌘K)").accessibilityLabel("Switch resource")
            Button(action: toggleFocus) {
                Image(systemName: focused ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(HivraChromeButtonStyle())
            .help(focused ? "Leave focus mode" : "Focus on this workspace (⇧⌘F)")
            .accessibilityLabel(focused ? "Leave focus mode" : "Focus workspace")
            Menu {
                Button("New agent", systemImage: "sparkle") { session.launch(kind: .agent) }
                Button("New computer", systemImage: "desktopcomputer") { session.launch(kind: .computer) }
                Divider()
                Button("Add connection", systemImage: "plus.rectangle.on.rectangle") { showingAddConnection = true }
            } label: {
                Image(systemName: "plus").font(.system(size: 14)).frame(width: 26, height: 30)
            }
            .menuStyle(.borderlessButton).fixedSize()
            .help("Create or connect").accessibilityLabel("Create or connect")
        }
        .padding(.horizontal, 10)
        .frame(height: HivraWindowChrome.headerHeight)
        .background(HivraWindowDragRegion(title: windowTitle, onWindow: { session.workspaceWindow = $0 }))
        .background(HivraDesign.surface(for: scheme))
        .accessibilityIdentifier("native-workspace-header")
    }

    private func detach(_ tab: HivraWorkspaceTab) {
        session.detach(tab)
    }

    private func detach(_ url: URL) {
        if let tab = session.activeTab, url == tab.browser.currentURL {
            session.detach(tab)
        } else {
            detach(url, title: session.destination.label)
        }
    }

    private func detach(_ url: URL, title: String) {
        openWindow(value: HivraDetachedSurface(url: url, title: "\(title) · \(session.profile.name)"))
    }

    private var canaryAction: (() -> Void)? {
        profileStore.profiles.first(where: \.isBuiltInCanary).map { profile in { profileStore.select(profile) } }
    }
}
