import HivraMacCore
import SwiftUI

struct HivraAddConnectionView: View {
    @EnvironmentObject private var profileStore: HivraProfileStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var addressFocused: Bool

    @State private var name = ""
    @State private var address = ""
    @State private var kind = HivraConnectionKind.custom
    @State private var validationMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            HivraSheetHeader(
                eyebrow: "Workspace connection",
                title: "Add a connection",
                detail: "Open another Hivra workspace from this Mac. You’ll sign in after opening the connection."
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)

            Form {
                Section {
                    Picker("Location", selection: $kind) {
                        ForEach(HivraConnectionKind.allCases, id: \.self) { kind in
                            Text(kind.displayName).tag(kind)
                        }
                    }
                    TextField("Name", text: $name, prompt: Text(kind.displayName))
                    TextField("Address", text: $address, prompt: Text(addressPlaceholder))
                        .textContentType(.URL)
                        .focused($addressFocused)
                        .onSubmit(connect)
                } footer: {
                    Text(connectionHint)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .frame(height: 196)

            if let validationMessage {
                Label(validationMessage, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 16)
                    .accessibilityLabel("Connection could not be added. \(validationMessage)")
            }

            Divider()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(HivraButtonStyle())
                Button("Add connection", action: connect)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(HivraButtonStyle(.primary))
                    .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(20)
        }
        .frame(width: 510)
        .background(HivraDesign.background(for: colorScheme))
        .onChange(of: kind) { previous, next in
            if address.isEmpty || address == defaultAddress(for: previous) {
                address = defaultAddress(for: next)
            }
            validationMessage = nil
        }
        .onAppear { addressFocused = true }
    }

    private var addressPlaceholder: String {
        kind == .custom ? "https://hivra.example.com" : defaultAddress(for: kind)
    }

    private var connectionHint: String {
        switch kind {
        case .local: "Connect to a running local workspace. To create one, open Local Hivra in the app’s Settings."
        case .hivraCloud: "The suggested address opens Hivra Canary. Use the address for your hosted workspace."
        case .custom: "Enter your Hivra server address. The connection is saved on this Mac."
        }
    }

    private func defaultAddress(for kind: HivraConnectionKind) -> String {
        switch kind {
        case .local: "http://127.0.0.1:3000"
        case .hivraCloud: "https://canary.hermesos.cloud"
        case .custom: ""
        }
    }

    private func connect() {
        do {
            try profileStore.add(name: name, address: address, kind: kind)
            dismiss()
        } catch {
            validationMessage = error.localizedDescription
            addressFocused = true
        }
    }
}
