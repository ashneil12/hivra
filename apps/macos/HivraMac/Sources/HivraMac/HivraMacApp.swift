import HivraMacCore
import SwiftUI

@main
struct HivraMacApp: App {
    @NSApplicationDelegateAdaptor(HivraAppDelegate.self) private var appDelegate
    @StateObject private var profileStore = HivraProfileStore()
    @StateObject private var signIn = HivraBrowserSignInCoordinator()
    @StateObject private var updates = HivraUpdates()
    @StateObject private var localRuntime = HivraLocalRuntimeManager()
    @AppStorage("hivra.mac.appearance") private var appearance = HivraAppearance.system.rawValue

    var body: some Scene {
        WindowGroup("Hivra", id: "workspace") {
            HivraRootView(localRuntime: localRuntime)
                .environmentObject(profileStore)
                .environmentObject(signIn)
                .onAppear {
                    let coordinator = signIn
                    appDelegate.onOpenURL { [weak coordinator] in coordinator?.handle($0) }
                }
                .preferredColorScheme(HivraAppearance(rawValue: appearance)?.colorScheme)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1360, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            HivraWorkspaceCommands()
            CommandGroup(after: .appInfo) {
                if updates.isAvailable {
                    Button("Check for Updates…") { updates.checkForUpdates() }
                        .disabled(!updates.canCheckForUpdates)
                }
            }
        }

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
