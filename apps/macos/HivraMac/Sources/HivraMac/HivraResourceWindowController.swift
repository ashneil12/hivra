import AppKit
import HivraMacCore
import SwiftUI

/// Moves the existing browser into a window; it never creates another resource session.
@MainActor
final class HivraResourceWindowController: NSWindowController, NSWindowDelegate {
    private var onReturn: (() -> Void)?

    init(tab: HivraWorkspaceTab, profile: HivraConnectionProfile, onReturn: @escaping () -> Void) {
        self.onReturn = onReturn
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 520)
        window.title = "\(tab.displayName) · \(profile.name)"
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: HivraResourceWindowView(tab: tab, profile: profile, onReturn: onReturn))
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        onReturn?()
        return false
    }

    func finish() {
        onReturn = nil
        window?.delegate = nil
        window?.contentView = nil
        window?.close()
    }
}

private struct HivraResourceWindowView: View {
    @ObservedObject var tab: HivraWorkspaceTab
    let profile: HivraConnectionProfile
    let onReturn: () -> Void
    @AppStorage("hivra.mac.appearance") private var appearance = HivraAppearance.system.rawValue

    var body: some View {
        // A popped-out resource offers Return to Hivra, never a further window.
        HivraFocusedWorkPane(browser: tab.browser, profile: profile, onDetach: { _ in }, onReturn: onReturn)
            .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
    }
}
