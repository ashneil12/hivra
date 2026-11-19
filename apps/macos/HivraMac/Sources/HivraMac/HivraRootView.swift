import HivraMacCore
import SwiftUI

struct HivraRootView: View {
    @EnvironmentObject private var profileStore: HivraProfileStore
    @EnvironmentObject private var signIn: HivraBrowserSignInCoordinator
    @ObservedObject var localRuntime: HivraLocalRuntimeManager
    @StateObject private var workspaces = HivraWorkspaceStore()
    @State private var session: HivraWorkspaceSession?

    var body: some View {
        Group {
            if let session {
                HivraWelcomeGate(browser: session.connectionBrowser, signIn: signIn, profile: session.profile) {
                    HivraWorkspaceView(session: session, localRuntime: localRuntime)
                }
                .id(session.id)
            } else {
                HivraThinkingOrb(size: 32, label: "Opening workspace")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background { HivraWindowBackground() }
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
        .onChange(of: signIn.completion) { _, completion in
            guard let completion,
                  let profile = profileStore.profiles.first(where: { $0.id == completion.profileID }) else { return }
            profileStore.select(profile)
            workspaces.session(for: profile).connectionBrowser.load(completion.finishURL)
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
                // The workspace sits in a rounded card on the window's glass,
                // as MonoCode Hub's inset layout does.
                workspaceContent
                    .background(HivraDesign.background(for: scheme))
                    .clipShape(RoundedRectangle(cornerRadius: HivraDesign.Radius.panel, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: HivraDesign.Radius.panel, style: .continuous)
                            .strokeBorder(HivraDesign.stroke(.regular, for: scheme), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                    .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.06), radius: 10, y: 2)
                    .padding(.leading, sidebarVisible && !focused ? 0 : 8)
                    .padding([.trailing, .bottom], 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(.container, edges: .top)
        }
        .navigationTitle(windowTitle)
        .background { HivraWindowBackground() }
        .ignoresSafeArea(.container, edges: .top)
        .focusedSceneValue(\.hivraWorkspaceActions, workspaceActions)
        .sheet(isPresented: $showingSwitcher) {
            HivraNativeSwitcher(session: session) { showingSwitcher = false }
        }
        .sheet(isPresented: $showingAddConnection) {
            HivraAddConnectionView().environmentObject(profileStore)
        }
        .sheet(isPresented: $showingLocalSetup) { HivraLocalSetupView(runtime: localRuntime) }
        .sheet(isPresented: $showingLocalControls) {
            VStack(alignment: .leading, spacing: 20) {
                HivraSheetHeader(eyebrow: "This Mac", title: "Local Hivra", detail: "Manage the workspace running on this computer.")
                HivraLocalControlPanel(runtime: localRuntime) {
                    showingLocalControls = false
                    showingLocalSetup = true
                }
                HStack { Spacer(); Button("Done") { showingLocalControls = false }.buttonStyle(HivraButtonStyle()).keyboardShortcut(.cancelAction) }
            }.padding(28).frame(width: 520)
        }
    }

    @ViewBuilder private var workspaceContent: some View {
        VStack(spacing: 0) {
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
    }

    private var workspaceActions: HivraWorkspaceActions {
        HivraWorkspaceActions(
            switchResource: { showingSwitcher = true },
            select: session.select,
            launch: { session.launch() },
            closeTab: session.closeCurrentTab,
            openSeparateWindow: { if let tab = session.activeTab { detach(tab) } },
            focus: toggleFocus,
            toggleSidebar: toggleSidebar,
            refresh: { if session.isNativeDestination { session.refresh() } else { session.activeBrowser.reload() } },
            goBack: { session.activeBrowser.goBack() },
            goForward: { session.activeBrowser.goForward() },
            hasOpenTab: session.activeTab != nil
        )
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
            VStack(alignment: .leading, spacing: 14) {
                HivraWordmark().foregroundStyle(HivraDesign.foreground(for: scheme))
                    .padding(.horizontal, 4)
                if profileStore.developerConnections { connectionMenu }
                Button { showingSwitcher = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                        Text("Find a resource")
                        Spacer(minLength: 0)
                        Text("⌘K").font(.system(size: 11))
                    }.font(.system(size: 12.5)).foregroundStyle(HivraDesign.mutedText(for: scheme))
                        .padding(.horizontal, 10).frame(height: 30)
                        .hivraField()
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Find a resource")
            }.padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 14)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(spacing: 2) {
                        ForEach(HivraWorkspaceDestination.primaryNavigation, id: \.self) { item in
                            destination(item, symbol: item.symbol)
                        }
                    }
                    resourceGroup(.agent, title: "AGENTS")
                    resourceGroup(.computer, title: "COMPUTERS")
                }.padding(.horizontal, 8).padding(.bottom, 16)
            }
            VStack(spacing: 2) {
                Rectangle().fill(HivraDesign.stroke(.subtle, for: scheme)).frame(height: 1).padding(.horizontal, 6).padding(.bottom, 6)
                Button { openSettings() } label: { sidebarLabel("App settings", symbol: "gearshape") }.buttonStyle(HivraRowStyle())
                // Servers sits with the account controls, as it does under Manage on the web.
                destination(.infrastructure, symbol: "server.rack")
                destination(.settings, symbol: "person.crop.circle", label: "Account")
                if session.profile.isBuiltInLocal {
                    Button { showingLocalControls = true } label: {
                        HStack {
                            sidebarLabel("Local runtime", symbol: "externaldrive")
                            Text(localRuntime.state.label).font(.system(size: 11)).foregroundStyle(HivraDesign.mutedText(for: scheme)).padding(.trailing, 8)
                        }
                    }.buttonStyle(HivraRowStyle())
                }
                HStack(spacing: 6) {
                    Image(systemName: session.profile.isBuiltInLocal ? "laptopcomputer" : "network")
                    Text(session.profile.url.host ?? session.profile.name).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }.font(.system(size: 11)).foregroundStyle(HivraDesign.mutedText(for: scheme))
                    .padding(.horizontal, 10).padding(.vertical, 10)
            }.padding(.horizontal, 8)
        }
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
                Text(session.profile.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(HivraDesign.foreground(for: scheme))
        }
        .menuStyle(.borderlessButton)
        .padding(.horizontal, 10).frame(height: 30)
        .hivraField()
        .help("Switch connection")
    }

    private func sidebarLabel(_ label: String, symbol: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).font(.system(size: 13)).frame(width: 18)
            Text(label).font(.system(size: 13))
            Spacer(minLength: 0)
        }.padding(.horizontal, 8).frame(height: 30).contentShape(Rectangle())
    }

    private func destination(_ destination: HivraWorkspaceDestination, symbol: String, label: String? = nil) -> some View {
        let selected = session.selectedTabID == nil && session.destination == destination
        return Button { session.select(destination) } label: {
            sidebarLabel(label ?? destination.label, symbol: symbol)
        }.buttonStyle(HivraRowStyle(selected: selected)).accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func resourceGroup(_ kind: HivraWorkspaceResourceKind, title: String) -> some View {
        let resources = session.resources.filter { $0.kind == kind }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                HivraLabel(title)
                Text(resources.isEmpty && (session.snapshot?.ownerKey == nil || session.snapshot?.loading == true || session.snapshot?.errors.isEmpty == false) ? "—" : "\(resources.count)")
                    .font(.system(size: 10.5).monospacedDigit()).foregroundStyle(HivraDesign.mutedText(for: scheme))
                Spacer()
                Button { session.launch(kind: kind) } label: { Image(systemName: "plus").font(.system(size: 11)) }
                    .buttonStyle(HivraChromeButtonStyle()).help(kind == .agent ? "New agent" : "New computer")
                    .accessibilityLabel(kind == .agent ? "New agent" : "New computer")
            }.padding(.leading, 8)
            if resources.isEmpty {
                Text(session.snapshot?.ownerKey == nil ? "Open your workspace to load resources" : session.snapshot?.loading == true ? "Loading resources…" : session.snapshot?.errors.isEmpty == false ? "Resources unavailable" : "No \(kind == .agent ? "agents" : "computers") yet")
                    .font(.system(size: 12)).foregroundStyle(HivraDesign.mutedText(for: scheme)).padding(.horizontal, 8).padding(.vertical, 4)
            } else {
                ForEach(resources, id: \.uid) { resource in
                    Button { session.open(resource) } label: {
                        HStack(spacing: 9) {
                            Image(systemName: resource.symbol).font(.system(size: 12)).frame(width: 18)
                            Text(resource.name).font(.system(size: 13)).lineLimit(1)
                            Spacer(minLength: 0)
                            HivraResourceStatus(resource: resource, showsLabel: false)
                        }.padding(.horizontal, 8).frame(height: 30).contentShape(Rectangle())
                    }.buttonStyle(HivraRowStyle(selected: session.activeTab?.resourceUID == resource.uid)).help("\(resource.name) · \(resource.statusLabel)")
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
                                Text(tab.displayName)
                                    .font(.system(size: 12.5, weight: .medium))
                                    .lineLimit(1).truncationMode(.middle)
                            }
                            .foregroundStyle(session.selectedTabID == tab.id ? HivraDesign.foreground(for: scheme) : HivraDesign.secondaryText(for: scheme))
                            .padding(.leading, 11).padding(.trailing, 5).frame(height: 28).contentShape(Rectangle())
                        }.buttonStyle(.plain).help(tab.displayName)
                            .accessibilityAddTraits(session.selectedTabID == tab.id ? .isSelected : [])
                        Button { session.close(tab) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .medium)).frame(width: 22, height: 22).contentShape(Rectangle())
                        }.buttonStyle(HivraChromeButtonStyle()).help("Close \(tab.displayName)").accessibilityLabel("Close \(tab.displayName) tab")
                            .padding(.trailing, 6)
                    }.contextMenu {
                        Button("Open in Separate Window") { detach(tab) }
                        Divider()
                        Button("Close Tab") { session.close(tab) }
                    }.frame(maxWidth: 228).id(tab.id)
                        .background(session.selectedTabID == tab.id ? HivraDesign.fill(.three, for: scheme) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: HivraDesign.Radius.control, style: .continuous))
                        .animation(HivraDesign.Motion.fast, value: session.selectedTabID)
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
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(HivraDesign.foreground(for: scheme))
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
                if profileStore.developerConnections {
                    Divider()
                    Button("Add connection", systemImage: "plus.rectangle.on.rectangle") { showingAddConnection = true }
                }
            } label: {
                Image(systemName: "plus").font(.system(size: 13, weight: .medium)).frame(width: 26, height: 28)
            }
            .menuStyle(.borderlessButton).fixedSize()
            .help("Create or connect").accessibilityLabel("Create or connect")
        }
        .padding(.horizontal, 10)
        .frame(height: HivraWindowChrome.headerHeight)
        .background(HivraWindowDragRegion(title: windowTitle, onWindow: { session.workspaceWindow = $0 }))
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
