import HivraMacCore
import SwiftUI

struct HivraNativeSwitcher: View {
    @ObservedObject var session: HivraWorkspaceSession
    let onDismiss: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var searchFocused: Bool
    @State private var query = ""
    @State private var selectedUID: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15))
                    .foregroundStyle(HivraDesign.mutedText(for: colorScheme))
                TextField("Find an agent or computer…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 16))
                    .focused($searchFocused)
                    .onKeyPress(.downArrow) { moveSelection(by: 1); return .handled }
                    .onKeyPress(.upArrow) { moveSelection(by: -1); return .handled }
                    // Claim Escape before the field editor interprets it, so dismissal
                    // never depends on the text system passing cancelOperation along.
                    .onKeyPress(.escape) { onDismiss(); return .handled }
            }
            .padding(.horizontal, 18).padding(.vertical, 16)
            Rectangle().fill(HivraDesign.stroke(.regular, for: colorScheme)).frame(height: 1)

            HStack {
                Text(session.profile.name)
                    .lineLimit(1)
                Spacer()
                if session.snapshot?.loading == true {
                    HivraThinkingOrb(size: 20, label: "Refreshing")
                    Text("Refreshing…")
                } else {
                    Text("\(matches.count) \(matches.count == 1 ? "result" : "results")")
                }
            }
            .font(.system(size: 11.5))
            .foregroundStyle(HivraDesign.mutedText(for: colorScheme))
            .padding(.horizontal, 18)
            .padding(.vertical, 10)

            if !sourceErrors.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(HivraDesign.warn(for: colorScheme))
                    Text(sourceErrors)
                        .font(.system(size: 11))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Retry", action: session.refresh)
                        .buttonStyle(HivraButtonStyle())
                        .disabled(session.snapshot?.loading == true)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
            }

            if session.snapshot?.ownerKey == nil {
                emptyState("Sign in to your workspace", detail: "Your agents and computers appear after the connection confirms your account.")
            } else if matches.isEmpty {
                if session.snapshot?.loading == true && session.resources.isEmpty {
                    emptyState("Loading resources", detail: "Waiting for this workspace’s inventory.")
                } else if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    emptyState("No matching resources", detail: "Try another name, runtime, or operating system.")
                } else if !sourceErrors.isEmpty {
                    emptyState("Inventory unavailable", detail: "Retry the connection to load your agents and computers.")
                } else {
                    emptyState("No agents or computers yet", detail: "Use Launch to create the first resource in this workspace.")
                }
            } else {
                ScrollViewReader { proxy in
                    List(selection: $selectedUID) {
                        ForEach(matches, id: \.uid) { resource in
                            Button { open(resource) } label: {
                                resourceRow(resource)
                            }
                            .buttonStyle(.plain)
                            .tag(resource.uid)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 6)
                    .onChange(of: selectedUID) { _, uid in
                        if let uid { proxy.scrollTo(uid, anchor: .center) }
                    }
                    .accessibilityLabel("Agent and computer results")
                }
            }

            Rectangle().fill(HivraDesign.stroke(.regular, for: colorScheme)).frame(height: 1)
            HStack(spacing: 12) {
                Text("↑↓ Select")
                Text("↵ Open")
                Text("esc Close")
                Spacer()
                // The one dismiss control; Escape from anywhere in the switcher does the same.
                Button("Cancel", action: onDismiss)
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(HivraButtonStyle())
                Button("Open", action: openSelected)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(HivraButtonStyle(.primary))
                    .disabled(selectedResource == nil)
            }
            .font(.system(size: 11))
            .foregroundStyle(HivraDesign.mutedText(for: colorScheme))
            .padding(14)
        }
        .frame(width: 560, height: 500)
        .background {
            ZStack {
                HivraVisualEffect(material: .popover, blending: .behindWindow)
                HivraDesign.glassTint(for: colorScheme, strong: true)
            }
        }
        .onAppear {
            selectedUID = session.activeTab?.resourceUID
            reconcileSelection()
            searchFocused = true
        }
        .onChange(of: query) { _, _ in reconcileSelection() }
        .onChange(of: session.resources) { _, _ in reconcileSelection() }
        .onChange(of: session.snapshot?.ownerKey) { _, _ in
            query = ""
            selectedUID = nil
            onDismiss()
        }
        // Escape while the result list or another control has focus.
        .onExitCommand(perform: onDismiss)
    }

    private var matches: [HivraWorkspaceResource] {
        guard session.snapshot?.ownerKey != nil else { return [] }
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return session.resources.filter { resource in
            term.isEmpty || "\(resource.name) \(resource.description) \(resource.kind.rawValue) \(resource.uid)"
                .localizedStandardContains(term)
        }
    }

    private var selectedResource: HivraWorkspaceResource? {
        matches.first { $0.uid == selectedUID }
    }

    private var sourceErrors: String {
        (session.snapshot?.errors ?? [:])
            .sorted { $0.key.rawValue < $1.key.rawValue }
            .map(\.value)
            .joined(separator: " ")
    }

    private func resourceRow(_ resource: HivraWorkspaceResource) -> some View {
        HStack(spacing: 12) {
            Image(systemName: resource.kind == .computer ? "desktopcomputer" : "sparkles")
                .font(.system(size: 14))
                .foregroundStyle(HivraDesign.secondaryText(for: colorScheme))
                .frame(width: 30, height: 30)
                .background(HivraDesign.fill(.two, for: colorScheme), in: RoundedRectangle(cornerRadius: HivraDesign.Radius.card, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(resource.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(HivraDesign.foreground(for: colorScheme))
                    .lineLimit(2)
                Text(session.resources.filter { $0.name == resource.name }.count > 1
                     ? "\(resource.description) · \(resource.uid)" : resource.description)
                    .font(.system(size: 11.5))
                    .foregroundStyle(HivraDesign.secondaryText(for: colorScheme))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text("\(session.snapshot?.errors[resource.source] != nil ? "Last known: " : "")\(resource.status.replacingOccurrences(of: "_", with: " ").capitalized)")
                .font(.system(size: 11))
                .foregroundStyle(HivraDesign.mutedText(for: colorScheme))
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 120, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func emptyState(_ title: String, detail: String) -> some View {
        VStack(spacing: 8) {
            Text(title).font(HivraDesign.display(17)).tracking(HivraDesign.displayTracking(17))
            Text(detail)
                .font(.system(size: 12.5))
                .foregroundStyle(HivraDesign.secondaryText(for: colorScheme))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private func reconcileSelection() {
        if !matches.contains(where: { $0.uid == selectedUID }) {
            selectedUID = matches.first?.uid
        }
    }

    private func moveSelection(by delta: Int) {
        guard !matches.isEmpty else { return }
        let index = matches.firstIndex { $0.uid == selectedUID } ?? (delta > 0 ? -1 : matches.count)
        selectedUID = matches[max(0, min(matches.count - 1, index + delta))].uid
    }

    private func openSelected() {
        if let resource = selectedResource { open(resource) }
    }

    private func open(_ resource: HivraWorkspaceResource) {
        guard session.snapshot?.ownerKey != nil,
              let current = session.resources.first(where: { $0.uid == resource.uid }) else { return }
        session.open(current)
        onDismiss()
    }
}
