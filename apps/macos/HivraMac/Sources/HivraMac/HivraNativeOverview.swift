import HivraMacCore
import SwiftUI

extension HivraWorkspaceResource {
    var symbol: String { kind == .computer ? "desktopcomputer" : "sparkle" }
    var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
    var isRunning: Bool { ["running", "ready", "active"].contains(status.lowercased()) }
    var needsAttention: Bool { ["failed", "error", "degraded", "unhealthy", "needs_attention"].contains(status.lowercased()) }
}

extension HivraWorkspaceDestination {
    var symbol: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .computers: "desktopcomputer"
        case .agents: "sparkle"
        case .infrastructure: "server.rack"
        case .activity: "waveform.path"
        case .launch: "plus"
        case .settings: "person.crop.circle"
        }
    }
}

struct HivraResourceStatus: View {
    let resource: HivraWorkspaceResource
    var showsLabel = true
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(resource.isRunning ? HivraDesign.ok(for: scheme) : resource.needsAttention ? HivraDesign.bad(for: scheme) : HivraDesign.mutedText(for: scheme))
                .frame(width: 6, height: 6)
            if showsLabel { Text(resource.statusLabel).font(.system(size: 11)) }
        }
        .foregroundStyle(HivraDesign.secondaryText(for: scheme))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(resource.statusLabel)
    }
}

struct HivraNativeOverview: View {
    @ObservedObject var session: HivraWorkspaceSession
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 8) {
                            HivraLabel(session.profile.name)
                            Text("Your workspace")
                                .font(HivraDesign.display(30)).tracking(HivraDesign.displayTracking(30))
                                .accessibilityAddTraits(.isHeader)
                            Text("Open an agent. Step into a computer. Pick up where you left off.")
                                .font(.system(size: 13)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                        }
                        Spacer(minLength: 20)
                        Menu { launchItems } label: {
                            Label("Launch", systemImage: "plus")
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(HivraDesign.background(for: scheme))
                        }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                            .padding(.horizontal, 14).frame(height: 32)
                            .background(HivraDesign.foreground(for: scheme), in: RoundedRectangle(cornerRadius: HivraDesign.Radius.control, style: .continuous))
                            .accessibilityLabel("Launch a resource")
                    }

                    if let snapshot = session.snapshot, !snapshot.errors.isEmpty {
                        HivraInventoryNotice(snapshot: snapshot, refresh: session.refresh)
                    }

                    if !session.tabs.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            sectionLabel("Open in this window", count: session.tabs.count)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(session.tabs) { tab in
                                        Button { session.selectedTabID = tab.id } label: {
                                            HStack(spacing: 12) {
                                                Image(systemName: tab.resource.symbol).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(tab.displayName).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                                    if tab.pendingResourceUID == nil {
                                                        Text(tab.resource.description).font(.system(size: 11)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                                                    }
                                                }
                                                Spacer(minLength: 8)
                                                Image(systemName: "arrow.up.right").font(.system(size: 10)).foregroundStyle(HivraDesign.mutedText(for: scheme))
                                            }.padding(14).frame(width: 250, alignment: .leading)
                                                .hivraCard(cornerRadius: HivraDesign.Radius.card)
                                        }.buttonStyle(.plain).help("Return to the open \(tab.displayName) session")
                                    }
                                }
                            }
                        }
                    }

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 20, alignment: .top),
                                             count: min(geometry.size.width, 1240) - 64 >= 720 ? 2 : 1),
                              alignment: .leading, spacing: 20) {
                        resourceGroup(.agent, title: "Agents", detail: "Your runtimes, ready to work.")
                        resourceGroup(.computer, title: "Computers", detail: "Your desktops and development environments.")
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.branch")
                        Text("Each resource opens in its own tab. Switching views keeps your session in place.")
                    }.font(.system(size: 11.5)).foregroundStyle(HivraDesign.mutedText(for: scheme))
                }
                .padding(32)
                .frame(maxWidth: 1240, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
        .background { HivraWorkspaceBackdrop() }
        .accessibilityIdentifier("native-workspace-overview")
    }

    @ViewBuilder private var launchItems: some View {
        Button("New agent", systemImage: "sparkle") { session.launch(kind: .agent) }
        Button("New computer", systemImage: "desktopcomputer") { session.launch(kind: .computer) }
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            HivraLabel(title)
            Text("\(count)").font(.system(size: 10.5).monospacedDigit()).foregroundStyle(HivraDesign.mutedText(for: scheme))
        }
    }

    private func resourceGroup(_ kind: HivraWorkspaceResourceKind, title: String, detail: String) -> some View {
        let resources = session.resources.filter { $0.kind == kind }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(HivraDesign.display(17)).tracking(HivraDesign.displayTracking(17))
                        .accessibilityAddTraits(.isHeader)
                    Text(detail).font(.system(size: 12)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                }
                Spacer(minLength: 6)
                Button { session.select(kind == .agent ? .agents : .computers) } label: {
                    HStack(spacing: 5) { Text("\(resources.count)"); Image(systemName: "arrow.right") }
                        .font(.system(size: 12)).padding(.horizontal, 8)
                }.buttonStyle(HivraRowStyle(height: 26)).help("View all \(title.lowercased())")
            }.padding(18)
            Rectangle().fill(HivraDesign.stroke(.subtle, for: scheme)).frame(height: 1)
            if resources.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text(session.snapshot?.loading == true ? "Loading \(title.lowercased())…" : session.snapshot?.errors.isEmpty == false ? "Resources could not be loaded." : "No \(title.lowercased()) yet.")
                        .font(.system(size: 13)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                    if session.snapshot?.loading != true && session.snapshot?.errors.isEmpty == true {
                        Button("Launch \(kind == .agent ? "an agent" : "a computer")") { session.launch(kind: kind) }
                            .buttonStyle(HivraButtonStyle())
                    }
                }.padding(20).frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
            } else {
                ForEach(Array(resources.prefix(6)), id: \.uid) { resource in
                    HivraNativeResourceRow(resource: resource) { session.open(resource) }
                    if resource.uid != resources.prefix(6).last?.uid {
                        Rectangle().fill(HivraDesign.stroke(.subtle, for: scheme)).frame(height: 1).padding(.leading, 64)
                    }
                }
            }
        }
        .hivraGlass(cornerRadius: HivraDesign.Radius.panel, shadow: false)
    }
}

struct HivraNativeResourceRow: View {
    let resource: HivraWorkspaceResource
    let open: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false
    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: resource.symbol)
                    .font(.system(size: 15)).frame(width: 34, height: 34)
                    .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                    .background(HivraDesign.fill(.two, for: scheme), in: RoundedRectangle(cornerRadius: HivraDesign.Radius.card, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(resource.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Text(resource.description).font(.system(size: 12)).foregroundStyle(HivraDesign.secondaryText(for: scheme)).lineLimit(1)
                }
                Spacer(minLength: 10)
                HivraResourceStatus(resource: resource, showsLabel: false)
                Image(systemName: "arrow.up.right").font(.system(size: 10))
                    .foregroundStyle(hovering ? HivraDesign.foreground(for: scheme) : HivraDesign.mutedText(for: scheme))
            }
            .padding(.horizontal, 16).frame(minHeight: 62)
            .background(hovering ? HivraDesign.fill(.one, for: scheme) : .clear)
            .animation(HivraDesign.Motion.fast, value: hovering)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Open \(resource.name) · \(resource.statusLabel)")
        .accessibilityLabel("Open \(resource.name), \(resource.description), \(resource.statusLabel)")
    }
}

struct HivraInventoryNotice: View {
    let snapshot: HivraWorkspaceSnapshot
    let refresh: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(HivraDesign.bad(for: scheme))
            VStack(alignment: .leading, spacing: 4) {
                Text("Some resources could not be refreshed").font(.system(size: 12, weight: .medium))
                ForEach(snapshot.errors.keys.sorted(by: { $0.rawValue < $1.rawValue }), id: \.self) { source in
                    Text("\(source.rawValue.capitalized): \(snapshot.errors[source] ?? "Unavailable")")
                        .font(.system(size: 11)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                }
            }
            Spacer()
            Button("Retry", action: refresh).buttonStyle(HivraButtonStyle())
        }
        .padding(14)
        .background(HivraDesign.bad(for: scheme).opacity(0.07), in: RoundedRectangle(cornerRadius: HivraDesign.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: HivraDesign.Radius.card, style: .continuous)
                .strokeBorder(HivraDesign.bad(for: scheme).opacity(0.24), lineWidth: 1)
        }
    }
}

struct HivraNativeInventory: View {
    @ObservedObject var session: HivraWorkspaceSession
    let kind: HivraWorkspaceResourceKind
    @Environment(\.colorScheme) private var scheme

    private var all: [HivraWorkspaceResource] { session.resources.filter { $0.kind == kind } }
    private var filtered: [HivraWorkspaceResource] {
        all.filter { resource in
            let matchesQuery = session.query.isEmpty || "\(resource.name) \(resource.description) \(resource.status)".localizedCaseInsensitiveContains(session.query)
            let matchesStatus = session.statusFilter == "All" || (session.statusFilter == "Running" && resource.isRunning)
                || (session.statusFilter == "Stopped" && resource.status.lowercased() == "stopped")
                || (session.statusFilter == "Needs attention" && resource.needsAttention)
            return matchesQuery && matchesStatus
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text(kind == .agent ? "Agents" : "Computers")
                        .font(HivraDesign.display(28)).tracking(HivraDesign.displayTracking(28))
                        .accessibilityAddTraits(.isHeader)
                    Text("\(all.count) in \(session.profile.name)").font(.system(size: 12.5)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                }
                Spacer()
                Button { session.launch(kind: kind) } label: { Label(kind == .agent ? "New agent" : "New computer", systemImage: "plus") }
                    .buttonStyle(HivraButtonStyle(.primary))
            }
            HStack(spacing: 16) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(HivraDesign.mutedText(for: scheme))
                    TextField(kind == .agent ? "Search agents" : "Search computers", text: $session.query).textFieldStyle(.plain)
                    if !session.query.isEmpty {
                        Button { session.query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain).foregroundStyle(HivraDesign.mutedText(for: scheme))
                            .help("Clear search").accessibilityLabel("Clear search")
                    }
                }.font(.system(size: 13)).padding(.horizontal, 10).frame(height: 32).hivraField()
                Picker("Status", selection: $session.statusFilter) {
                    ForEach(["All", "Running", "Stopped", "Needs attention"], id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 150)
            }
            if let snapshot = session.snapshot, !snapshot.errors.isEmpty { HivraInventoryNotice(snapshot: snapshot, refresh: session.refresh) }
            if all.isEmpty && session.snapshot?.loading == true {
                VStack(spacing: 12) {
                    HivraThinkingOrb(size: 32, label: "Loading resources")
                    Text("Loading resources…").font(.system(size: 12.5)).foregroundStyle(HivraDesign.secondaryText(for: scheme))
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if all.isEmpty && session.snapshot?.errors.isEmpty == false {
                ContentUnavailableView("Resources unavailable", systemImage: "wifi.exclamationmark", description: Text("Retry the connection to load this inventory."))
            } else if all.isEmpty {
                ContentUnavailableView(
                    kind == .agent ? "No agents yet" : "No computers yet",
                    systemImage: kind == .agent ? "sparkle" : "desktopcomputer",
                    description: Text("Launch a resource to add it to this workspace.")
                )
            } else if filtered.isEmpty {
                ContentUnavailableView {
                    Label("No matching resources", systemImage: "magnifyingglass")
                } description: {
                    Text("Try a different name or change the status filter.")
                } actions: {
                    Button("Clear filters") { session.query = ""; session.statusFilter = "All" }
                        .buttonStyle(HivraButtonStyle())
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered, id: \.uid) { resource in
                            HivraNativeResourceRow(resource: resource) { session.open(resource) }
                            if resource.uid != filtered.last?.uid {
                                Rectangle().fill(HivraDesign.stroke(.subtle, for: scheme)).frame(height: 1).padding(.leading, 64)
                            }
                        }
                    }.hivraGlass(cornerRadius: HivraDesign.Radius.panel, shadow: false)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(28).frame(maxWidth: 1240).frame(maxWidth: .infinity)
        .background { HivraWorkspaceBackdrop() }
        .accessibilityIdentifier("native-\(kind.rawValue)-inventory")
    }
}

/// The workspace floor: the base with the soft Hivra Glass haze behind the cards.
private struct HivraWorkspaceBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HivraDesign.background(for: scheme)
            .overlay { HivraHaze() }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
