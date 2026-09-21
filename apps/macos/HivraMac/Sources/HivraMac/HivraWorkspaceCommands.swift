import SwiftUI

struct HivraWorkspaceActions {
    let switchResource: () -> Void
    let home: () -> Void
    let agents: () -> Void
    let computers: () -> Void
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
            Button("Home") { actions?.home() }
                .keyboardShortcut("1", modifiers: .command)
            Button("Agents") { actions?.agents() }
                .keyboardShortcut("2", modifiers: .command)
            Button("Computers") { actions?.computers() }
                .keyboardShortcut("3", modifiers: .command)
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
