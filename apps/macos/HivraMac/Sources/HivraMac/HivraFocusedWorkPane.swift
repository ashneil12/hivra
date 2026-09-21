import HivraMacCore
import SwiftUI

struct HivraFocusedWorkPane: View {
    @ObservedObject var browser: HivraBrowserModel
    let profile: HivraConnectionProfile
    let onDetach: (URL) -> Void
    let onOpenLocalControls: (() -> Void)?
    let onUseHivraCanary: (() -> Void)?
    let onAddConnection: (() -> Void)?
    @Environment(\.colorScheme) private var colorScheme

    init(
        browser: HivraBrowserModel,
        profile: HivraConnectionProfile,
        onDetach: @escaping (URL) -> Void,
        onOpenLocalControls: (() -> Void)? = nil,
        onUseHivraCanary: (() -> Void)? = nil,
        onAddConnection: (() -> Void)? = nil
    ) {
        self.browser = browser
        self.profile = profile
        self.onDetach = onDetach
        self.onOpenLocalControls = onOpenLocalControls
        self.onUseHivraCanary = onUseHivraCanary
        self.onAddConnection = onAddConnection
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let snapshot = currentSurfaces, !snapshot.surfaces.isEmpty {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal) {
                            HStack(spacing: 2) {
                                ForEach(snapshot.surfaces) { surface in
                                    surfaceButton(surface, active: snapshot.active == surface.id)
                                        .id(surface.id)
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                        .onAppear { proxy.scrollTo(snapshot.active, anchor: .center) }
                        .onChange(of: snapshot.active) { _, active in
                            proxy.scrollTo(active, anchor: .center)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Resource surfaces")
                } else {
                    Text(browser.isLoading ? "Opening workspace…" : profile.name)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if browser.isLoading {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel("Loading work pane")
                }
                Button { onDetach(browser.currentURL ?? profile.url) } label: {
                    Image(systemName: "macwindow.on.rectangle")
                }
                .buttonStyle(HivraChromeButtonStyle())
                .help("Open in Separate Window (⌥⌘O)")
                .accessibilityLabel("Open in Separate Window")
                navigationMenu
            }
            .frame(height: 38)
            .padding(.horizontal, 12)
            .background(HivraDesign.surface(for: colorScheme))
            .overlay(alignment: .bottom) {
                Rectangle().fill(HivraDesign.border(for: colorScheme)).frame(height: 1)
            }

            HivraBrowserPane(
                profile: profile,
                onDetach: onDetach,
                onOpenLocalControls: onOpenLocalControls,
                onUseHivraCanary: onUseHivraCanary,
                onAddConnection: onAddConnection,
                browser: browser,
                showsBrowserToolbar: false
            )
            .id(ObjectIdentifier(browser))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var currentSurfaces: HivraSurfaceSnapshot? {
        guard let snapshot = browser.surfaceSnapshot,
              let currentURL = browser.currentURL,
              HivraWorkspaceBridgeTrust.accepts(trustedURL: profile.url, frameURL: currentURL, isMainFrame: true),
              HivraWorkspaceRoute.normalizedPath(currentURL.path) == snapshot.pathname,
              browser.workspaceSnapshot?.ownerKey != nil else { return nil }
        return snapshot
    }

    private func surfaceButton(_ surface: HivraWorkspaceSurface, active: Bool) -> some View {
        Button {
            browser.selectWorkspaceSurface(surface.id)
        } label: {
            Text(surface.label)
                .font(.system(size: 12, weight: active ? .semibold : .regular))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 11)
                .frame(minHeight: 28)
                .foregroundStyle(active ? HivraDesign.foreground(for: colorScheme) : .secondary)
                .background(active ? HivraDesign.foreground(for: colorScheme).opacity(0.06) : .clear,
                            in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var navigationMenu: some View {
        Menu {
            Button("Back", action: browser.goBack).disabled(!browser.canGoBack)
            Button("Forward", action: browser.goForward).disabled(!browser.canGoForward)
            Divider()
            Button(browser.isLoading ? "Stop loading" : "Reload", action: browser.toggleLoading)
            Button("Open in Separate Window") { onDetach(browser.currentURL ?? profile.url) }
            if let onOpenLocalControls {
                Divider()
                Button("Local Hivra…", action: onOpenLocalControls)
            }
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: 28, height: 32)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Work pane options")
        .help("Navigation and window options")
    }
}
