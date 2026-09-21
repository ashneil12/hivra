import SwiftUI

struct HivraLocalControlPanel: View {
    @ObservedObject var runtime: HivraLocalRuntimeManager
    let onSetup: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingOutput = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(HivraDesign.crimson)
                Text("LOCAL HIVRA")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .tracking(1)
                Spacer(minLength: 8)
                Circle().fill(statusColor).frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                Text(runtime.state.label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            Text(stateDescription)
                .font(.system(size: 12))
                .foregroundStyle(isFailed ? .orange : .secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let checkout = runtime.checkoutURL {
                VStack(alignment: .leading, spacing: 4) {
                    Text(checkout.lastPathComponent)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                    Text(checkout.path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .help(checkout.path)
            }

            HStack(spacing: 8) {
                primaryAction
                Spacer(minLength: 0)
                Menu {
                    Button("Choose source folder…", action: runtime.chooseCheckout)
                        .disabled(runtime.state.isBusy || runtime.state == .running)
                    Button("Check prerequisites", action: runtime.runDoctor)
                        .disabled(runtime.checkoutURL == nil || runtime.state.isBusy || runtime.state == .running)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 26, height: 28)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel("Local runtime options")
                .help("Source and prerequisite checks")
            }

            if !runtime.output.isEmpty {
                DisclosureGroup("Runtime output", isExpanded: $showingOutput) {
                    ScrollView {
                        Text(runtime.output)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 160)
                    .padding(10)
                    .background(HivraDesign.background(for: colorScheme))
                }
                .font(.system(size: 11))
            }
        }
        .padding(16)
        .background(HivraDesign.surface(for: colorScheme))
        .overlay { Rectangle().stroke(HivraDesign.border(for: colorScheme), lineWidth: 1) }
    }

    @ViewBuilder
    private var primaryAction: some View {
        switch runtime.state {
        case .checkoutNeeded:
            Button("Choose source…", action: runtime.chooseCheckout)
                .buttonStyle(HivraButtonStyle(.primary))
        case .setupNeeded:
            Button("Set up Local Hivra", action: onSetup)
                .buttonStyle(HivraButtonStyle(.primary))
        case .ready:
            Button("Start Local Hivra", action: runtime.start)
                .buttonStyle(HivraButtonStyle(.primary))
        case .failed:
            if runtime.hasConfiguration {
                Button("Start Local Hivra", action: runtime.start)
                    .buttonStyle(HivraButtonStyle(.primary))
            } else {
                Button("Set up Local Hivra", action: onSetup)
                    .buttonStyle(HivraButtonStyle(.primary))
            }
        case .running:
            Button("Stop Local Hivra", action: runtime.stop)
                .buttonStyle(HivraButtonStyle())
        case .checking, .initializing, .stopping:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Button("Cancel operation", action: runtime.cancelOperation)
                    .buttonStyle(HivraButtonStyle())
            }
        case .starting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Starting local services…")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 36)
        }
    }

    private var isFailed: Bool {
        if case .failed = runtime.state { return true }
        return false
    }

    private var stateDescription: String {
        switch runtime.state {
        case .checkoutNeeded: "Choose a Hivra source folder to run a workspace on this Mac."
        case .setupNeeded: "Create a local operator account before starting your workspace."
        case .ready: "Your local installation is configured and ready to start."
        case .checking: "Checking this Mac’s local installation."
        case .initializing: "Creating the local installation. Setup output is available below."
        case .starting: "Waiting for the local control plane to report that it is ready."
        case .running: "The local control plane is running on this Mac."
        case .stopping: "Stopping the local control plane."
        case .failed(let message): message
        }
    }

    private var statusColor: Color {
        switch runtime.state {
        case .running: .green
        case .failed: .orange
        case .checking, .initializing, .starting, .stopping: .yellow
        default: .secondary
        }
    }
}
