import Foundation
import Testing

@testable import HivraMacCore

@Suite("Native workspace routing and identity")
struct HivraWorkspaceNavigationTests {
    @Test("destinations retain the working dashboard routes")
    func destinations() {
        #expect(HivraWorkspaceDestination.allCases.map(\.path) == [
            "/dashboard", "/dashboard/agents", "/dashboard/computers", "/dashboard/activity",
            "/dashboard/infrastructure", "/dashboard/launch", "/dashboard/settings",
        ])
        #expect(HivraWorkspaceDestination.overview.label == "Home")
    }

    @Test("normalizes equivalent routes and resolves against the exact profile origin")
    func resolvesSafeRoutes() {
        let profile = HivraConnectionProfile(name: "Custom", url: URL(string: "https://example.test:8443/dashboard?old=discard#discard")!, kind: .custom)
        #expect(HivraWorkspaceRoute.normalizedPath("/dashboard/") == "/dashboard")
        #expect(HivraWorkspaceRoute.normalizedPath("/dashboard/%61gent/abc/?tab=desktop") == "/dashboard/agent/abc?tab=desktop")
        #expect(HivraWorkspaceRoute.normalizedPath("/dashboard/agent/abc?open=fast&tab=desktop") == "/dashboard/agent/abc?tab=desktop&open=fast")
        #expect(HivraWorkspaceRoute.normalizedPath("/dashboard/agent/abc?open=native&tab=desktop") == "/dashboard/agent/abc?tab=desktop&open=native")
        #expect(HivraWorkspaceRoute.url(for: "/dashboard/agent/abc?tab=desktop", profile: profile)?.absoluteString == "https://example.test:8443/dashboard/agent/abc?tab=desktop")
        var unsafeProfile = profile
        unsafeProfile.url = URL(string: "https://user:secret@example.test/dashboard")!
        #expect(HivraWorkspaceRoute.url(for: "/dashboard", profile: unsafeProfile) == nil)
    }

    // Route families, arrival parameters and security rejections are shared with the
    // dashboard in apps/shared/native-contract (HivraNativeContractTests).
    @Test("bounds a route at 2,048 bytes before and after canonicalization")
    func boundsRouteLength() {
        let longest = "/dashboard/" + String(repeating: "x", count: 2_037)
        #expect(HivraWorkspaceRoute.normalizedPath(longest) == longest)
        #expect(HivraWorkspaceRoute.normalizedPath(longest + "x") == nil)
        #expect(HivraWorkspaceRoute.normalizedPath(longest + "?welcome=1") == nil)
        #expect(HivraWorkspaceRoute.normalizedPath("/dashboard/" + String(repeating: "é", count: 500)) == nil)
    }

    @Test("accepts only an exact trusted origin in the main frame")
    func checksBridgeTrust() {
        let trusted = URL(string: "https://example.test/dashboard")!
        #expect(HivraWorkspaceBridgeTrust.accepts(trustedURL: trusted, frameURL: URL(string: "https://EXAMPLE.test:443/dashboard/agents"), isMainFrame: true))
        for frame in ["https://example.test.evil/dashboard", "http://example.test/dashboard", "https://example.test:8443/dashboard",
                      "https://user:secret@example.test/dashboard", "file:///dashboard"] {
            #expect(!HivraWorkspaceBridgeTrust.accepts(trustedURL: trusted, frameURL: URL(string: frame), isMainFrame: true))
        }
        #expect(!HivraWorkspaceBridgeTrust.accepts(trustedURL: trusted, frameURL: trusted, isMainFrame: false))
        #expect(!HivraWorkspaceBridgeTrust.accepts(trustedURL: trusted, frameURL: nil, isMainFrame: true))
    }

    @Test("keeps resource surfaces in one tab while isolating source, profile and signed-in owner")
    func resourceTabIdentity() throws {
        let profile = UUID()
        let original = try #require(HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-1", path: "/dashboard/agent/abc?tab=desktop"))
        #expect(original == HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-1", path: "/dashboard/%61gent/abc/"))
        #expect(original == HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-1", path: "/dashboard/agent/abc/manage?tab=terminal"))
        #expect(original != HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-1", path: "/dashboard/instances/abc"))
        #expect(original != HivraWorkspaceTabIdentity(profileID: UUID(), ownerKey: "owner-1", path: "/dashboard/agent/abc"))
        #expect(original != HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-2", path: "/dashboard/agent/abc"))
        #expect(original.semanticKey == "resource:x-abc")
        #expect(HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "", path: "/dashboard") == nil)
        #expect(HivraWorkspaceTabIdentity(profileID: profile, ownerKey: "owner-1", path: "https://guest.invalid") == nil)
        let encoded = try JSONEncoder().encode(original)
        #expect(try JSONDecoder().decode(HivraWorkspaceTabIdentity.self, from: encoded) == original)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("desktop"))
    }
}
