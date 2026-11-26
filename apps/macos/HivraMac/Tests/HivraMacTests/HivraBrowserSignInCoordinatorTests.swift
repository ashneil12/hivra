import Foundation
import Testing

@testable import HivraMac
@testable import HivraMacCore

@Suite("Browser sign-in coordinator")
@MainActor
struct HivraBrowserSignInCoordinatorTests {
    @Test("reopening the browser reuses the waiting sign-in attempt")
    func reopenUsesWaitingAttempt() {
        var opened: [URL] = []
        let coordinator = HivraBrowserSignInCoordinator(openURL: { opened.append($0) })

        coordinator.start(.signIn, for: .hivra)
        coordinator.reopenBrowser()

        #expect(opened.count == 2)
        #expect(opened[0] == opened[1])
        #expect(opened[0].path == "/desktop/sign-in")
    }
}
