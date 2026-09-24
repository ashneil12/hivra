import HivraMacCore
import SwiftUI

/// A web page opened in its own window. It is ordinary web content: the pane owns an
/// unprivileged browser, and restored windows only reopen HTTP(S) addresses.
struct HivraDetachedSurfaceView: View {
    let surface: HivraDetachedSurface?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let surface, HivraTrustedWebOrigin(surface.url) != nil {
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
