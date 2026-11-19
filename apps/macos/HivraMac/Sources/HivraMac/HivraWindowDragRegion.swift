import AppKit
import HivraMacCore
import SwiftUI

/// Sits behind the header controls; interactive SwiftUI controls take precedence.
struct HivraWindowDragRegion: NSViewRepresentable {
    let title: String
    var onWindow: ((NSWindow) -> Void)? = nil

    func makeNSView(context: Context) -> DragView {
        DragView(title: title, onWindow: onWindow)
    }

    func updateNSView(_ view: DragView, context: Context) {
        view.onWindow = onWindow
        view.title = title
        view.configureWindow()
    }

    final class DragView: NSView {
        var title: String
        var onWindow: ((NSWindow) -> Void)?

        init(title: String, onWindow: ((NSWindow) -> Void)?) {
            self.onWindow = onWindow
            self.title = title
            super.init(frame: .zero)
            setAccessibilityElement(false)
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            configureWindow()
        }

        func configureWindow() {
            guard let window else { return }
            HivraWindowChrome.configure(window, title: title)
            onWindow?(window)
        }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard event.clickCount == 2 else {
                window?.performDrag(with: event)
                return
            }
            // The global titlebar preference remains effective for our drag region.
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.miniaturize(nil)
            case "None": break
            default: window?.performZoom(nil)
            }
        }
    }
}
