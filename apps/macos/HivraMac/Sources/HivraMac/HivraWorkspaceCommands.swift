import HivraMacCore
import SwiftUI

struct HivraWorkspaceActions {
    let switchResource: () -> Void
    let select: (HivraWorkspaceDestination) -> Void
    let launch: () -> Void
    let closeTab: () -> Void
    let openSeparateWindow: () -> Void
    let focus: () -> Void
    let toggleSidebar: () -> Void
    let refresh: () -> Void
    let goBack: () -> Void
    let goForward: () -> Void
    let hasOpenTab: Bool
}

private struct HivraWorkspaceActionsKey: FocusedValueKey {
    typealias Value = HivraWorkspaceActions
}

extension FocusedValues {
    var hivraWorkspaceActions: HivraWorkspaceActions? {
        get { self[HivraWorkspaceActionsKey.self] }
        set { self[HivraWorkspaceActionsKey.self] = newValue }
    }
}

struct HivraWorkspaceCommands: Commands {
    @FocusedValue(\.hivraWorkspaceActions) private var actions
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Workspace Window") { openWindow(id: "workspace") }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("Launch Agent or Computer") { actions?.launch() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(actions == nil)
            Button("Open in Separate Window") { actions?.openSeparateWindow() }
                .keyboardShortcut("o", modifiers: [.command, .option])
                .disabled(actions?.hasOpenTab != true)
            Button("Close Work Tab") { actions?.closeTab() }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(actions?.hasOpenTab != true)
        }
        CommandMenu("Workspace") {
          Group {
            Button("Switch Agent or Computer…") { actions?.switchResource() }
                .keyboardShortcut("k", modifiers: .command)
            Divider()
            // Command 1-5 follow the dashboard's primary navigation order.
            ForEach(Array(HivraWorkspaceDestination.primaryNavigation.enumerated()), id: \.element) { index, destination in
                Button(destination.label) { actions?.select(destination) }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
            Divider()
            Button("Focus Work Pane") { actions?.focus() }
                .keyboardShortcut("f", modifiers: [.command, .shift])
            Button("Toggle Sidebar") { actions?.toggleSidebar() }
                .keyboardShortcut("s", modifiers: [.command, .option])
            Button("Refresh") { actions?.refresh() }
                .keyboardShortcut("r", modifiers: .command)
            Divider()
            Button("Back") { actions?.goBack() }
                .keyboardShortcut("[", modifiers: .command)
            Button("Forward") { actions?.goForward() }
                .keyboardShortcut("]", modifiers: .command)
          }
          .disabled(actions == nil)
        }
    }
}
