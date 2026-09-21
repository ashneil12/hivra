import HivraMacCore
import SwiftUI

struct HivraBrowserPane: View {
    let profile: HivraConnectionProfile
    let refreshGeneration: Int
    let localCredentialsGeneration: Int
    let localCredentials: HivraLocalOperatorCredentials?
    let automaticLocalSignInEnabled: Bool
    let onDetach: (URL) -> Void
    let onOpenLocalControls: (() -> Void)?
    let onUseHivraCanary: (() -> Void)?
    let onAddConnection: (() -> Void)?
    let showsBrowserToolbar: Bool
    private let ownsBrowser: Bool

    @StateObject private var browser: HivraBrowserModel

    init(
        profile: HivraConnectionProfile,
        refreshGeneration: Int = 0,
        localCredentialsGeneration: Int = 0,
        localCredentials: HivraLocalOperatorCredentials? = nil,
        automaticLocalSignInEnabled: Bool = false,
        onDetach: @escaping (URL) -> Void,
        onOpenLocalControls: (() -> Void)? = nil,
        onUseHivraCanary: (() -> Void)? = nil,
        onAddConnection: (() -> Void)? = nil,
        browser existingBrowser: HivraBrowserModel? = nil,
        showsBrowserToolbar: Bool = true
    ) {
        self.showsBrowserToolbar = showsBrowserToolbar
        self.ownsBrowser = existingBrowser == nil
        self.profile = profile
        self.refreshGeneration = refreshGeneration
        self.localCredentialsGeneration = localCredentialsGeneration
        self.localCredentials = localCredentials
        self.automaticLocalSignInEnabled = automaticLocalSignInEnabled
        self.onDetach = onDetach
        self.onOpenLocalControls = onOpenLocalControls
        self.onUseHivraCanary = onUseHivraCanary
        self.onAddConnection = onAddConnection
        _browser = StateObject(wrappedValue: existingBrowser ?? HivraBrowserModel(
            initialURL: profile.url,
            localCredentials: automaticLocalSignInEnabled ? localCredentials : nil
        ))
    }

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.039, blue: 0.043)
                .ignoresSafeArea()

            HivraWebView(webView: browser.webView)

            if let errorMessage = browser.errorMessage {
                recoveryColor(HivraRecoveryAppearance.backdrop)
                    .ignoresSafeArea()
                connectionError(errorMessage)
            }
        }
        .onAppear {
            browser.openDetachedSurface = onDetach
        }
        .onDisappear {
            if ownsBrowser { browser.cancelAutomaticSignIn() }
        }
        .onChange(of: profile.url) { _, nextURL in
            browser.load(
                nextURL,
                localCredentials: automaticLocalSignInEnabled ? localCredentials : nil
            )
        }
        .onChange(of: refreshGeneration) { _, _ in
            browser.load(
                profile.url,
                localCredentials: automaticLocalSignInEnabled ? localCredentials : nil
            )
        }
        .onChange(of: automaticLocalSignInEnabled) { _, enabled in
            if enabled {
                browser.load(profile.url, localCredentials: localCredentials)
            } else {
                browser.cancelAutomaticSignIn()
            }
        }
        .onChange(of: localCredentialsGeneration) { _, _ in
            if let localCredentials, automaticLocalSignInEnabled {
                browser.load(profile.url, localCredentials: localCredentials)
            } else if localCredentials == nil {
                browser.clearLocalSession(andLoad: profile.url)
            }
        }
        .toolbar {
          if showsBrowserToolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button(action: browser.goBack) {
                    Image(systemName: "chevron.left")
                }
                .disabled(!browser.canGoBack)
                .help("Back")

                Button(action: browser.goForward) {
                    Image(systemName: "chevron.right")
                }
                .disabled(!browser.canGoForward)
                .help("Forward")

                Button(action: browser.toggleLoading) {
                    Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
                }
                .help(browser.isLoading ? "Stop" : "Reload")
            }

            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    onDetach(browser.currentURL ?? profile.url)
                } label: {
                    Label("Detach", systemImage: "macwindow.on.rectangle")
                }
                .help("Open this surface in another window")
            }
          }
        }
    }

    private func connectionError(_ message: String) -> some View {
        VStack(spacing: 18) {
            Image(systemName: profile.isBuiltInLocal ? "desktopcomputer.trianglebadge.exclamationmark" : "network.slash")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color(red: 1, green: 0.25, blue: 0.27))

            VStack(spacing: 6) {
                Text(profile.isBuiltInLocal ? "Local Hivra is not reachable" : "Hivra is not reachable")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                Text(profile.url.absoluteString)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            }

            if profile.isBuiltInLocal {
                localRecoveryActions
            } else {
                Button("Try again", action: browser.reload)
                    .buttonStyle(.borderedProminent)
                    .tint(recoveryColor(HivraRecoveryAppearance.primaryAction))
            }
        }
        .padding(38)
        .foregroundStyle(recoveryColor(HivraRecoveryAppearance.text))
        .background(recoveryColor(HivraRecoveryAppearance.card), in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        }
        .padding(32)
    }

    private var localRecoveryActions: some View {
        VStack(spacing: 12) {
            Text("Set up or start Hivra on this Mac, or use another connection.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                if let onOpenLocalControls {
                    Button("Set up or start Local Hivra", action: onOpenLocalControls)
                        .buttonStyle(.borderedProminent)
                        .tint(recoveryColor(HivraRecoveryAppearance.primaryAction))
                }

                if let onUseHivraCanary {
                    Button("Use Hivra Canary", action: onUseHivraCanary)
                        .buttonStyle(.bordered)
                }
            }

            HStack(spacing: 10) {
                Button("Try Local again", action: browser.reload)
                    .buttonStyle(.bordered)

                if let onAddConnection {
                    Button("Add custom connection", action: onAddConnection)
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private func recoveryColor(_ value: HivraRecoveryAppearance.RGB) -> Color {
        Color(red: value.red, green: value.green, blue: value.blue)
    }
}
