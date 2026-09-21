import AppKit
import HivraMacCore
import SwiftUI

/// Sits behind the header controls; interactive SwiftUI controls take precedence.
struct HivraWindowDragRegion: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> DragView {
        DragView(title: title)
    }

    func updateNSView(_ view: DragView, context: Context) {
        view.title = title
        view.configureWindow()
    }

    final class DragView: NSView {
        var title: String

        init(title: String) {
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

struct HivraChromeButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .frame(width: 30, height: 30)
            .background(configuration.isPressed ? HivraDesign.foreground(for: scheme).opacity(0.1) : .clear,
                        in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
    }
}
