import Combine
import Foundation
import Sparkle

/// App updates through Sparkle. Off (no menu item, no checks) unless the
/// bundle carries a feed address and the public key that update archives are
/// signed with, which only release builds do.
@MainActor
final class HivraUpdates: ObservableObject {
    @Published private(set) var canCheckForUpdates = false
    let isAvailable: Bool
    private let controller: SPUStandardUpdaterController?
    private var observation: AnyCancellable?

    init(bundle: Bundle = .main) {
        let key = (bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let feed = (bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String) ?? ""
        isAvailable = !key.isEmpty && feed.hasPrefix("https://")
        guard isAvailable else {
            controller = nil
            return
        }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        self.controller = controller
        observation = controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.canCheckForUpdates = $0 }
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
