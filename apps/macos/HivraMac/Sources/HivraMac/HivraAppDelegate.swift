import AppKit

/// Receives hivra:// links. An Apple Event handler, rather than SwiftUI's
/// onOpenURL, so a link never opens an extra workspace window.
@MainActor
final class HivraAppDelegate: NSObject, NSApplicationDelegate {
    private var handler: ((URL) -> Void)?
    private var waiting: [URL] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURL(_:withReply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    /// Links that arrived before the window was ready are delivered now.
    func onOpenURL(_ handler: @escaping (URL) -> Void) {
        self.handler = handler
        let early = waiting
        waiting.removeAll()
        early.forEach(handler)
    }

    @objc private func handleGetURL(_ event: NSAppleEventDescriptor, withReply reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: text) else { return }
        if let handler { handler(url) } else { waiting.append(url) }
    }
}
