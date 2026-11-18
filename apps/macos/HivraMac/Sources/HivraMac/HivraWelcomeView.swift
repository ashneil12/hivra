import HivraMacCore
import SwiftUI

/// Shown instead of the website's sign-in page when the connection supports
/// browser sign-in: Google and other providers won't run inside an app.
struct HivraWelcomeView: View {
    let profile: HivraConnectionProfile
    @ObservedObject var signIn: HivraBrowserSignInCoordinator
    let onUseEmbeddedSignIn: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            HivraWindowBackground(tintStrength: 0.86)
            VStack(spacing: 0) {
                switch signIn.phase {
                case .waitingForBrowser:
                    waiting
                case .finishing:
                    VStack(spacing: 16) {
                        HivraThinkingOrb(size: 64, label: "Signing you in")
                        Text("Signing you in…")
                            .font(.system(size: 13))
                            .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                    }
                    .padding(.vertical, 24)
                case .idle, .failed:
                    choices
                }
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 34)
            .frame(width: 420)
            .hivraGlass(cornerRadius: HivraDesign.Radius.dialog, strong: true)
            .padding(32)
            .animation(HivraDesign.Motion.medium, value: phaseKey)
        }
        .background(HivraWindowDragRegion(title: "Hivra", onWindow: { _ in }))
        .accessibilityIdentifier("native-welcome")
    }

    private var phaseKey: Int {
        switch signIn.phase {
        case .idle: 0
        case .waitingForBrowser: 1
        case .finishing: 2
        case .failed: 3
        }
    }

    private var choices: some View {
        VStack(spacing: 0) {
            HivraMark(size: 52)
                .padding(.bottom, 22)
            Text("Give your AI agent a computer of its own")
                .font(HivraDesign.display(24))
                .tracking(HivraDesign.displayTracking(24))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, 10)
            Text("Start free. Launch an agent in a minute, then pick it up from any device.")
                .font(.system(size: 13))
                .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 26)
            VStack(spacing: 10) {
                Button { signIn.start(.signUp, for: profile) } label: {
                    Text("Get started free").frame(maxWidth: .infinity)
                }
                .buttonStyle(HivraButtonStyle(.primary))
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                Button { signIn.start(.signIn, for: profile) } label: {
                    Text("I already have an account").frame(maxWidth: .infinity)
                }
                .buttonStyle(HivraButtonStyle())
            }
            if case .failed(let message) = signIn.phase {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(HivraDesign.bad(for: scheme))
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
            }
            Text("Your browser opens to sign in, then brings you straight back here.")
                .font(.system(size: 11.5))
                .foregroundStyle(HivraDesign.mutedText(for: scheme))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
            Button("Sign in with email in this window instead", action: onUseEmbeddedSignIn)
                .buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                .underline()
                .padding(.top, 6)
        }
    }

    private var waiting: some View {
        VStack(spacing: 0) {
            HivraThinkingOrb(size: 64, label: "Waiting for your browser")
                .padding(.bottom, 22)
            Text("Finish signing in in your browser")
                .font(HivraDesign.display(20))
                .tracking(HivraDesign.displayTracking(20))
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, 8)
            Text("We'll bring you back here as soon as you're done.")
                .font(.system(size: 13))
                .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                .multilineTextAlignment(.center)
                .padding(.bottom, 22)
            HStack(spacing: 10) {
                Button("Open browser again") { signIn.reopenBrowser() }
                    .buttonStyle(HivraButtonStyle())
                Button("Cancel") { signIn.cancel() }
                    .buttonStyle(HivraButtonStyle())
                    .keyboardShortcut(.cancelAction)
            }
        }
    }
}

/// Shows the welcome screen while the connection's page is the website's
/// sign-in, when that website supports browser sign-in; otherwise the workspace.
struct HivraWelcomeGate<Content: View>: View {
    @ObservedObject var browser: HivraBrowserModel
    @ObservedObject var signIn: HivraBrowserSignInCoordinator
    let profile: HivraConnectionProfile
    @ViewBuilder let content: () -> Content
    @State private var embedded = false

    var body: some View {
        Group {
            if showsWelcome {
                HivraWelcomeView(profile: profile, signIn: signIn) { embedded = true }
            } else {
                content()
            }
        }
        .onAppear { signIn.probe(profile) }
        .onChange(of: signIn.completion) { _, _ in embedded = false }
    }

    private var showsWelcome: Bool {
        guard !embedded, profile.kind == .hivraCloud, signIn.isSupported(profile),
              let url = browser.currentURL else { return false }
        return HivraBrowserSignIn.isSignInPage(url, connection: profile.url)
    }
}
