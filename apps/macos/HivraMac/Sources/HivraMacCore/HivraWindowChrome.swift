import AppKit

/// The workspace draws one header while AppKit continues to own the window controls.
public enum HivraWindowChrome {
    public static let headerHeight: CGFloat = 44

    @MainActor
    public static func configure(_ window: NSWindow, title: String) {
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.styleMask.insert(.fullSizeContentView)
        window.toolbar = nil
        // Only the header's drag region may move the window. Guest content must
        // keep its pointer events for text selection, terminal input and desktops.
        window.isMovableByWindowBackground = false
    }
}
