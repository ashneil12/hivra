import Foundation
import Testing

@testable import HivraMacCore

@Suite("Hivra connection profiles")
struct HivraConnectionProfileTests {
    @Test("seeds local and Canary profiles")
    func seedsDefaultProfiles() {
        let profiles = HivraConnectionProfile.defaults

        #expect(profiles.map(\.kind) == [.local, .hivraCloud])
        #expect(profiles[0].id == HivraConnectionProfile.builtInLocalID)
        #expect(profiles[1].id == HivraConnectionProfile.builtInCanaryID)
        #expect(profiles[0].isBuiltInLocal)
        #expect(profiles[1].isBuiltInCanary)
        #expect(profiles[0].url.absoluteString == "http://127.0.0.1:3000/dashboard")
        #expect(profiles[1].url.absoluteString == "https://canary.hermesos.cloud/dashboard")
    }

    @Test("binds built-in connection actions to stable identity and origin")
    func bindsBuiltInConnectionActions() {
        let localIDOnAnotherOrigin = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInLocalID,
            name: "Not managed local",
            url: URL(string: "http://localhost:3000/dashboard")!,
            kind: .local
        )
        let localOriginWithAnotherID = HivraConnectionProfile(
            name: "Another local connection",
            url: URL(string: "http://127.0.0.1:3000/dashboard")!,
            kind: .local
        )
        let canaryIDOnAnotherOrigin = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInCanaryID,
            name: "Not Canary",
            url: URL(string: "https://example.test/dashboard")!,
            kind: .hivraCloud
        )
        let canaryOriginWithAnotherID = HivraConnectionProfile(
            name: "Another hosted connection",
            url: URL(string: "https://canary.hermesos.cloud/dashboard")!,
            kind: .hivraCloud
        )
        let canaryIDWithURLCredentials = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInCanaryID,
            name: "Credential-bearing Canary",
            url: URL(string: "https://ash:secret@canary.hermesos.cloud/dashboard")!,
            kind: .hivraCloud
        )

        #expect(!localIDOnAnotherOrigin.isBuiltInLocal)
        #expect(!localOriginWithAnotherID.isBuiltInLocal)
        #expect(!canaryIDOnAnotherOrigin.isBuiltInCanary)
        #expect(!canaryOriginWithAnotherID.isBuiltInCanary)
        #expect(!canaryIDWithURLCredentials.isBuiltInCanary)
    }

    @Test("normalizes an address and adds the dashboard path")
    func normalizesAddress() throws {
        let url = try HivraConnectionProfile.normalizedURL(from: "localhost:3000")

        #expect(url.absoluteString == "http://localhost:3000/dashboard")
    }

    @Test("preserves a specific Hivra route")
    func preservesRoute() throws {
        let url = try HivraConnectionProfile.normalizedURL(
            from: "https://example.test/dashboard/computers"
        )

        #expect(url.absoluteString == "https://example.test/dashboard/computers")
    }

    @Test("rejects unsafe URL schemes")
    func rejectsUnsafeScheme() {
        #expect(throws: HivraConnectionProfile.ValidationError.self) {
            try HivraConnectionProfile.normalizedURL(from: "file:///tmp/private")
        }
    }
}
