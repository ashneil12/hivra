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
            HivraDesign.background(for: scheme).ignoresSafeArea()
            VStack(spacing: 0) {
                HivraWordmark().foregroundStyle(HivraDesign.foreground(for: scheme))
                    .padding(.bottom, 36)
                switch signIn.phase {
                case .waitingForBrowser:
                    waiting
                case .finishing:
                    ProgressView("Signing you in…").controlSize(.regular)
                case .idle, .failed:
                    choices
                }
            }
            .frame(maxWidth: 420)
            .padding(32)
        }
        .background(HivraWindowDragRegion(title: "Hivra", onWindow: { _ in }))
        .accessibilityIdentifier("native-welcome")
    }

    private var choices: some View {
        VStack(spacing: 14) {
            Text("Give your AI agent a computer of its own.")
                .font(.system(size: 30, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Start free. Launch an agent in a minute, then pick it up from any device.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 18)
            Button { signIn.start(.signUp, for: profile) } label: {
                Text("Get started free").frame(maxWidth: .infinity)
            }
            .buttonStyle(HivraButtonStyle(.primary))
            .keyboardShortcut(.defaultAction)
            Button { signIn.start(.signIn, for: profile) } label: {
                Text("I already have an account").frame(maxWidth: .infinity)
            }
            .buttonStyle(HivraButtonStyle())
            if case .failed(let message) = signIn.phase {
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(HivraDesign.crimson)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
            Text("Your browser opens to sign in, then brings you straight back here.")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 10)
            Button("Sign in with email in this window instead", action: onUseEmbeddedSignIn)
                .buttonStyle(.link)
                .font(.system(size: 11))
        }
    }

    private var waiting: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.regular)
            Text("Finish signing in in your browser")
                .font(.system(size: 22, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
            Text("We'll bring you back here as soon as you're done.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 8)
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
