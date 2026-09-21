import HivraMacCore
import SwiftUI

struct HivraDetachedSurfaceView: View {
    let surface: HivraDetachedSurface?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let surface {
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
