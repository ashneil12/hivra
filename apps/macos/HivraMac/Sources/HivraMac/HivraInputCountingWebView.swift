import AppKit
import WebKit

/// A web view that numbers the user's own presses in it: mouse buttons and keys.
/// WebKit reports a script's `click()` as a link activation, so `HivraPageActivation`
/// relies on this count to tell a person's click from a page's.
final class HivraInputCountingWebView: WKWebView {
    private static let escapeKeyCode: UInt16 = 53

    private(set) var userInputCount: UInt64 = 0

    // Counted before WebKit sees the event, so any request the press causes finds it.
    override func mouseDown(with event: NSEvent) {
        userInputCount += 1
        super.mouseDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        userInputCount += 1
        super.rightMouseDown(with: event)
    }

    override func otherMouseDown(with event: NSEvent) {
        userInputCount += 1
        super.otherMouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        // As in HTML, Escape and the app's own shortcuts are not activation.
        if event.keyCode != Self.escapeKeyCode, !event.modifierFlags.contains(.command) {
            userInputCount += 1
        }
        super.keyDown(with: event)
    }
}
