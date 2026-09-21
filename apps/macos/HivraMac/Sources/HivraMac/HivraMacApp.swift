import HivraMacCore
import SwiftUI

@main
struct HivraMacApp: App {
    @StateObject private var profileStore = HivraProfileStore()
    @StateObject private var localRuntime = HivraLocalRuntimeManager()
    @AppStorage("hivra.mac.appearance") private var appearance = HivraAppearance.system.rawValue

    var body: some Scene {
        WindowGroup("Hivra", id: "workspace") {
            HivraRootView(localRuntime: localRuntime)
                .environmentObject(profileStore)
                .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1360, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands { HivraWorkspaceCommands() }

        WindowGroup("Hivra Surface", for: HivraDetachedSurface.self) { $surface in
            HivraDetachedSurfaceView(surface: surface)
                .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 760)

        Settings {
            HivraAppSettingsView(runtime: localRuntime)
                .environmentObject(profileStore)
                .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
        }
    }
}
