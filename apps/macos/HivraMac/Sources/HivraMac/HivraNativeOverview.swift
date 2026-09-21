import HivraMacCore
import SwiftUI

extension HivraWorkspaceResource {
    var symbol: String { kind == .computer ? "desktopcomputer" : "sparkle" }
    var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
    var isRunning: Bool { ["running", "ready", "active"].contains(status.lowercased()) }
    var needsAttention: Bool { ["failed", "error", "degraded", "unhealthy", "needs_attention"].contains(status.lowercased()) }
}

struct HivraResourceStatus: View {
    let resource: HivraWorkspaceResource
    var showsLabel = true
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(resource.isRunning ? Color.green : resource.needsAttention ? HivraDesign.crimson : Color.secondary)
                .frame(width: 6, height: 6)
            if showsLabel { Text(resource.statusLabel).font(.system(size: 11)) }
        }
        .foregroundStyle(.secondary)
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
                        VStack(alignment: .leading, spacing: 10) {
                            Text(session.profile.name.uppercased())
                                .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5)
                                .foregroundStyle(HivraDesign.crimson)
                            Text("Your workspace.")
                                .font(.system(size: 36, weight: .regular, design: .serif))
                            Text("Open an agent. Step into a computer. Pick up where you left off.")
                                .font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 20)
                        Menu { launchItems } label: { Label("Launch", systemImage: "plus") }
                            .menuStyle(.borderlessButton).fixedSize()
                            .padding(.horizontal, 14).frame(height: 36)
                            .background(HivraDesign.foreground(for: scheme))
                            .foregroundStyle(HivraDesign.background(for: scheme))
                            .accessibilityLabel("Launch a resource")
                    }

                    if let snapshot = session.snapshot, !snapshot.errors.isEmpty {
                        HivraInventoryNotice(snapshot: snapshot, refresh: session.refresh)
                    }

                    if !session.tabs.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            sectionLabel("OPEN IN THIS WINDOW", count: session.tabs.count)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(session.tabs) { tab in
                                        Button { session.selectedTabID = tab.id } label: {
                                            HStack(spacing: 12) {
                                                Image(systemName: tab.resource.symbol).foregroundStyle(HivraDesign.crimson)
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(tab.displayName).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                                    if tab.pendingResourceUID == nil {
                                                        Text(tab.resource.description).font(.system(size: 10)).foregroundStyle(.secondary)
                                                    }
                                                }
                                                Spacer(minLength: 8)
                                                Image(systemName: "arrow.up.right").font(.system(size: 10)).foregroundStyle(.secondary)
                                            }.padding(14).frame(width: 250, alignment: .leading)
                                                .background(HivraDesign.surface(for: scheme))
                                                .overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
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
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
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
        HStack {
            Text(title).font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1)
            Text("\(count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        }
    }

    private func resourceGroup(_ kind: HivraWorkspaceResourceKind, title: String, detail: String) -> some View {
        let resources = session.resources.filter { $0.kind == kind }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 24, weight: .regular, design: .serif))
                    Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Button { session.select(kind == .agent ? .agents : .computers) } label: {
                    HStack(spacing: 5) { Text("\(resources.count)"); Image(systemName: "arrow.right") }
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }.buttonStyle(.plain).help("View all \(title.lowercased())")
            }.padding(20)
            Divider()
            if resources.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text(session.snapshot?.loading == true ? "Loading \(title.lowercased())…" : session.snapshot?.errors.isEmpty == false ? "Resources could not be loaded." : "No \(title.lowercased()) yet.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                    if session.snapshot?.loading != true && session.snapshot?.errors.isEmpty == true {
                        Button("Launch \(kind == .agent ? "an agent" : "a computer")") { session.launch(kind: kind) }
                            .buttonStyle(HivraButtonStyle())
                    }
                }.padding(20).frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
            } else {
                ForEach(Array(resources.prefix(6)), id: \.uid) { resource in
                    HivraNativeResourceRow(resource: resource) { session.open(resource) }
                    if resource.uid != resources.prefix(6).last?.uid { Divider().padding(.leading, 20) }
                }
            }
        }
        .background(HivraDesign.surface(for: scheme))
        .overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
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
                    .font(.system(size: 17, weight: .light)).frame(width: 34, height: 34)
                    .overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
                VStack(alignment: .leading, spacing: 5) {
                    Text(resource.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text(resource.description).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 10)
                HivraResourceStatus(resource: resource, showsLabel: false)
                Image(systemName: "arrow.up.right").font(.system(size: 10)).foregroundStyle(hovering ? HivraDesign.crimson : .secondary)
            }
            .padding(.horizontal, 18).frame(minHeight: 72)
            .background(hovering ? HivraDesign.foreground(for: scheme).opacity(0.04) : .clear)
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
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(HivraDesign.crimson)
            VStack(alignment: .leading, spacing: 4) {
                Text("Some resources could not be refreshed").font(.system(size: 12, weight: .medium))
                ForEach(snapshot.errors.keys.sorted(by: { $0.rawValue < $1.rawValue }), id: \.self) { source in
                    Text("\(source.rawValue.capitalized): \(snapshot.errors[source] ?? "Unavailable")")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Retry", action: refresh).buttonStyle(.bordered)
        }.padding(14).background(HivraDesign.crimson.opacity(0.06))
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
                    Text(kind == .agent ? "Agents" : "Computers").font(.system(size: 32, weight: .regular, design: .serif))
                    Text("\(all.count) in \(session.profile.name)").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                Button { session.launch(kind: kind) } label: { Label(kind == .agent ? "New agent" : "New computer", systemImage: "plus") }
                    .buttonStyle(HivraButtonStyle(.primary))
            }
            HStack(spacing: 16) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(kind == .agent ? "Search agents" : "Search computers", text: $session.query).textFieldStyle(.plain)
                    if !session.query.isEmpty { Button { session.query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).help("Clear search") }
                }.padding(9).background(HivraDesign.surface(for: scheme)).overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
                Picker("Status", selection: $session.statusFilter) {
                    ForEach(["All", "Running", "Stopped", "Needs attention"], id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 150)
            }
            if let snapshot = session.snapshot, !snapshot.errors.isEmpty { HivraInventoryNotice(snapshot: snapshot, refresh: session.refresh) }
            if all.isEmpty && session.snapshot?.loading == true {
                ProgressView("Loading resources…").frame(maxWidth: .infinity, maxHeight: .infinity)
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
                            if resource.uid != filtered.last?.uid { Divider() }
                        }
                    }.background(HivraDesign.surface(for: scheme)).overlay(Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(28).frame(maxWidth: 1240).frame(maxWidth: .infinity)
        .background { HivraWorkspaceBackdrop() }
        .accessibilityIdentifier("native-\(kind.rawValue)-inventory")
    }
}

/// A quiet, static echo of Hivra's constellation motif; never competes with work.
private struct HivraWorkspaceBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HivraDesign.background(for: scheme).overlay {
            Canvas { context, size in
                let points: [CGPoint] = [
                    CGPoint(x: size.width * 0.67, y: 34),
                    CGPoint(x: size.width * 0.78, y: 80),
                    CGPoint(x: size.width * 0.87, y: 45),
                    CGPoint(x: size.width * 0.96, y: 102),
                    CGPoint(x: size.width * 0.92, y: 195)
                ]
                var line = Path()
                line.addLines(points)
                context.stroke(line, with: .color(HivraDesign.crimson.opacity(scheme == .dark ? 0.12 : 0.08)), lineWidth: 0.5)
                for point in points {
                    context.fill(Path(ellipseIn: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3)), with: .color(HivraDesign.crimson.opacity(0.22)))
                }
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}
