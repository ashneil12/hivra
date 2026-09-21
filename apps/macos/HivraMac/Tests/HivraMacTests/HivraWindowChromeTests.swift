import AppKit
import HivraMacCore
import Testing

@Suite("Integrated workspace window chrome")
@MainActor
struct HivraWindowChromeTests {
    @Test("removes duplicate toolbar chrome while retaining real Mac window controls")
    func nativeControlsSurvive() {
        _ = NSApplication.shared
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.toolbar = NSToolbar(identifier: "old-wrapper-toolbar")
        window.isMovableByWindowBackground = true

        HivraWindowChrome.configure(window, title: "Research computer · Canary")

        #expect(window.title == "Research computer · Canary")
        #expect(window.titleVisibility == .hidden)
        #expect(window.toolbar == nil)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.titlebarSeparatorStyle == .none)
        #expect(window.styleMask.contains(.fullSizeContentView))
        #expect(window.styleMask.contains([.titled, .closable, .miniaturizable, .resizable]))
        #expect(window.standardWindowButton(.closeButton) != nil)
        #expect(window.standardWindowButton(.miniaturizeButton) != nil)
        #expect(window.standardWindowButton(.zoomButton) != nil)
        #expect(!window.isMovableByWindowBackground)

        HivraWindowChrome.configure(window, title: "Home · Canary")
        #expect(window.title == "Home · Canary")
        #expect(window.standardWindowButton(.closeButton) != nil)
    }
}
