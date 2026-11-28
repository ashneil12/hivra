import Foundation
import Testing
@testable import HivraMacCore

@Suite("Separate resource windows")
struct HivraDetachedSurfaceTests {
    @Test("window restoration preserves the existing agent and selected surface")
    func preservesRoute() throws {
        let url = URL(string: "https://canary.hermesos.cloud/dashboard/agent/agent-one?tab=terminal")!
        let window = HivraDetachedSurface(url: url, title: "Agent One · Canary")
        let restored = try JSONDecoder().decode(HivraDetachedSurface.self, from: JSONEncoder().encode(window))
        #expect(restored == window)
        #expect(restored.url == url)
        #expect(restored.title == "Agent One · Canary")
        #expect(restored.canOpen(allowsDeveloperConnections: true))
        #expect(!restored.canOpen(allowsDeveloperConnections: false))
    }

    @Test("public builds only open detached windows on the production origin", arguments: [
        ("https://hivra.cloud/dashboard/activity", true),
        ("https://hivra.cloud:443/dashboard/activity", true),
        ("https://hivra.cloud:8443/dashboard/activity", false),
        ("http://hivra.cloud/dashboard/activity", false),
        ("file:///tmp/surface", false),
    ])
    func publicOrigin(url: String, allowed: Bool) throws {
        let window = HivraDetachedSurface(url: try #require(URL(string: url)), title: "Activity")
        #expect(window.canOpen(allowsDeveloperConnections: false) == allowed)
    }

    @Test("different agents and surfaces have independent window identities")
    func independentWindows() {
        let first = HivraDetachedSurface(url: URL(string: "https://example.com/dashboard/agent/one?tab=chat")!, title: "One")
        let second = HivraDetachedSurface(url: URL(string: "https://example.com/dashboard/agent/two?tab=chat")!, title: "Two")
        let terminal = HivraDetachedSurface(url: URL(string: "https://example.com/dashboard/agent/one?tab=terminal")!, title: "One")
        #expect(Set([first, second, terminal]).count == 3)
        #expect(first == HivraDetachedSurface(url: first.url, title: first.title))
    }
}
