import HivraMacCore
import SwiftUI

/// A web page opened in its own window. It is ordinary web content: the pane owns an
/// unprivileged browser.
struct HivraDetachedSurfaceView: View {
    let surface: HivraDetachedSurface?
    let allowsDeveloperConnections: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let surface, surface.canOpen(allowsDeveloperConnections: allowsDeveloperConnections) {
            HivraBrowserPane(
                profile: .init(name: surface.title, url: surface.url, kind: .custom)
            ) { nextURL in
                openWindow(value: HivraDetachedSurface(url: nextURL, title: surface.title))
            }
            .navigationTitle(surface.title)
        } else {
            ContentUnavailableView("No surface", systemImage: "macwindow")
        }
    }
}
