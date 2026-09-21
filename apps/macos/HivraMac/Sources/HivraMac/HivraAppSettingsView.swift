import HivraMacCore
import SwiftUI

struct HivraAppSettingsView: View {
    @EnvironmentObject private var profileStore: HivraProfileStore
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var runtime: HivraLocalRuntimeManager
    @AppStorage("hivra.mac.appearance") private var appearance = HivraAppearance.system.rawValue

    @State private var showingAddConnection = false
    @State private var showingLocalSetup = false
    @State private var showingRemoval = false
    @State private var removalCandidate: HivraConnectionProfile?
    @State private var showingForgetSignIn = false

    var body: some View {
        TabView {
            appearanceSettings
                .tabItem { Label("Appearance", systemImage: "circle.lefthalf.filled") }
            connectionSettings
                .tabItem { Label("Connections", systemImage: "network") }
            localSettings
                .tabItem { Label("Local Hivra", systemImage: "desktopcomputer") }
        }
        .padding(16)
        .frame(minWidth: 600, idealWidth: 660, maxWidth: 800, minHeight: 490, idealHeight: 550, maxHeight: 760)
        .background(HivraDesign.background(for: colorScheme))
        .tint(HivraDesign.crimson)
        .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
        .sheet(isPresented: $showingAddConnection) {
            HivraAddConnectionView()
                .environmentObject(profileStore)
        }
        .sheet(isPresented: $showingLocalSetup) {
            HivraLocalSetupView(runtime: runtime)
        }
        .alert("Remove connection?", isPresented: $showingRemoval, presenting: removalCandidate) { profile in
            Button("Remove \(profile.name)", role: .destructive) {
                profileStore.remove(profile)
                removalCandidate = nil
            }
            Button("Cancel", role: .cancel) { removalCandidate = nil }
        } message: { profile in
            Text("This removes \(profile.name) from this Mac’s connection list.\(profileStore.profiles.count == 1 ? " The built-in connections will then be restored." : "")")
        }
    }

    private var appearanceSettings: some View {
        Form {
            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(HivraAppearance.allCases) { appearance in
                        Text(appearance.label).tag(appearance.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Mac app")
            } footer: {
                Text("System follows your Mac’s appearance. This preference controls the native app interface.")
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var connectionSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your workspaces")
                    .font(.system(size: 25, weight: .regular, design: .serif))
                    .accessibilityAddTraits(.isHeader)
                Text("Select a connection to make it the active workspace.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }

            List(selection: selectedConnection) {
                ForEach(profileStore.profiles) { profile in
                    HStack(spacing: 12) {
                        Image(systemName: iconName(for: profile.kind))
                            .font(.system(size: 17))
                            .foregroundStyle(HivraDesign.crimson)
                            .frame(width: 26)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(profile.name)
                                .font(.system(size: 13, weight: .medium))
                                .lineLimit(1)
                                .help(profile.name)
                            Text(displayAddress(for: profile))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        if profileStore.selectedProfile?.id == profile.id {
                            Text("Active")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        Button {
                            removalCandidate = profile
                            showingRemoval = true
                        } label: {
                            Image(systemName: "minus.circle")
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("Remove \(profile.name)")
                        .accessibilityLabel("Remove \(profile.name)")
                    }
                    .padding(.vertical, 8)
                    .tag(profile.id)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(profile.name)
                    .accessibilityValue("\(displayAddress(for: profile))\(profileStore.selectedProfile?.id == profile.id ? ", active workspace" : "")")
                    .accessibilityHint("Select to use this workspace")
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
            .background(HivraDesign.surface(for: colorScheme))
            .overlay { Rectangle().stroke(HivraDesign.border(for: colorScheme), lineWidth: 1) }
            .accessibilityLabel("Saved workspace connections")

            HStack {
                Button {
                    showingAddConnection = true
                } label: {
                    Label("Add connection", systemImage: "plus")
                }
                .buttonStyle(HivraButtonStyle())
                Spacer()
                Text("\(profileStore.profiles.count) saved")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
    }

    private var localSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HivraLocalControlPanel(runtime: runtime) {
                    showingLocalSetup = true
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("LOCAL DATA")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(1)
                        .foregroundStyle(.secondary)
                    Text(runtime.stateDirectoryURL.path)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if runtime.hasSavedCredentials {
                    Divider()
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Saved local sign-in")
                                .font(.system(size: 13, weight: .medium))
                            Text("The operator credentials are saved in macOS Keychain for automatic sign-in.")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Button("Forget sign-in") { showingForgetSignIn = true }
                            .buttonStyle(HivraButtonStyle())
                            .alert("Forget saved local sign-in?", isPresented: $showingForgetSignIn) {
                                Button("Forget sign-in", role: .destructive, action: runtime.forgetSavedCredentials)
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("You will need to enter your local operator credentials the next time you sign in.")
                            }
                    }
                }
            }
            .padding(20)
        }
    }

    private var selectedConnection: Binding<HivraConnectionProfile.ID?> {
        Binding(
            get: { profileStore.selectedProfile?.id },
            set: { id in
                if let profile = profileStore.profiles.first(where: { $0.id == id }) {
                    profileStore.select(profile)
                }
            }
        )
    }

    private func displayAddress(for profile: HivraConnectionProfile) -> String {
        let host = profile.url.host ?? "Unknown host"
        let port = profile.url.port.map { ":\($0)" } ?? ""
        return "\(host)\(port)\(profile.url.path)"
    }

    private func iconName(for kind: HivraConnectionKind) -> String {
        switch kind {
        case .local: "desktopcomputer"
        case .hivraCloud: "cloud"
        case .custom: "server.rack"
        }
    }
}
