import SwiftUI

struct HivraLocalSetupView: View {
    @ObservedObject var runtime: HivraLocalRuntimeManager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var email = ""
    @State private var name = "Operator"
    @State private var password = ""
    @State private var confirmation = ""
    @State private var validationMessage: String?
    @State private var setupStarted = false
    @State private var showingOutput = false

    private var setupCompleted: Bool { setupStarted && runtime.state == .ready }
    private var isInitializing: Bool { runtime.state == .initializing }

    var body: some View {
        VStack(spacing: 0) {
            HivraSheetHeader(
                eyebrow: "On this Mac",
                title: setupCompleted ? "Local Hivra is ready" : "Set up Local Hivra",
                detail: setupCompleted
                    ? "Your local installation is configured. Start it when you’re ready to open your workspace."
                    : "Create the operator account for your local workspace. A Hivra Cloud account is not required."
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if setupCompleted {
                        Label(
                            runtime.hasSavedCredentials
                                ? "Your local sign-in is saved in macOS Keychain."
                                : "Automatic sign-in was not saved. Use your local operator credentials to sign in.",
                            systemImage: runtime.hasSavedCredentials ? "key.fill" : "exclamationmark.triangle"
                        )
                        .font(.system(size: 13))
                        .padding(16)
                    } else {
                        Form {
                            Section {
                                TextField("Email", text: $email)
                                    .textContentType(.emailAddress)
                                TextField("Name", text: $name)
                                SecureField("Password", text: $password)
                                    .textContentType(.newPassword)
                                SecureField("Confirm password", text: $confirmation)
                                    .textContentType(.newPassword)
                            } header: {
                                Text("Local operator")
                            } footer: {
                                Text("Use at least 12 characters. After setup, Hivra saves this local sign-in in macOS Keychain when available.")
                            }
                        }
                        .formStyle(.grouped)
                        .scrollContentBackground(.hidden)
                        .scrollDisabled(true)
                        .frame(height: 250)
                        .disabled(runtime.state.isBusy)
                    }

                    if let message = validationMessage ?? runtimeFailure {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.system(size: 12))
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 20)
                    }

                    if isInitializing {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("Setting up the local installation…")
                                .font(.system(size: 12))
                        }
                        .padding(.horizontal, 20)
                    }

                    if !runtime.output.isEmpty {
                        DisclosureGroup("Setup output", isExpanded: $showingOutput) {
                            Text(runtime.output)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(HivraDesign.surface(for: colorScheme))
                        }
                        .font(.system(size: 12))
                        .padding(.horizontal, 20)
                        .padding(.bottom, 16)
                    }
                }
            }
            .frame(maxWidth: .infinity)

            Divider()
            HStack {
                if isInitializing {
                    Button("Cancel setup", action: runtime.cancelOperation)
                        .buttonStyle(HivraButtonStyle())
                        .keyboardShortcut(.cancelAction)
                } else {
                    Button(setupCompleted ? "Done" : "Cancel") { dismiss() }
                        .buttonStyle(HivraButtonStyle())
                        .keyboardShortcut(.cancelAction)
                }
                Spacer()
                if !setupCompleted {
                    Button("Set up Local Hivra", action: beginSetup)
                        .buttonStyle(HivraButtonStyle(.primary))
                        .keyboardShortcut(.defaultAction)
                        .disabled(runtime.state.isBusy)
                }
            }
            .padding(20)
        }
        .frame(width: 540, height: 570)
        .background(HivraDesign.background(for: colorScheme))
        .interactiveDismissDisabled(isInitializing)
        .onChange(of: runtime.state) { _, state in
            if case .failed = state { showingOutput = true }
        }
        .onDisappear {
            password = ""
            confirmation = ""
        }
    }

    private var runtimeFailure: String? {
        guard setupStarted, case let .failed(message) = runtime.state else { return nil }
        return message
    }

    private func beginSetup() {
        validationMessage = nil
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            validationMessage = "Enter an email and name for the local operator."
            return
        }
        guard password.count >= 12 else {
            validationMessage = "Use at least 12 characters for the local operator password."
            return
        }
        guard password == confirmation else {
            validationMessage = "The passwords do not match."
            return
        }
        setupStarted = true
        runtime.initialize(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password
        )
        password = ""
        confirmation = ""
    }
}
