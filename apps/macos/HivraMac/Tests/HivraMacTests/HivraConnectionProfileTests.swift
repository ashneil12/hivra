import Foundation
import Testing

@testable import HivraMacCore

@Suite("Hivra connection profiles")
struct HivraConnectionProfileTests {
    @Test("a public build seeds only Hivra")
    func seedsHivraOnly() {
        let profiles = HivraConnectionProfile.defaults(includeDeveloper: false)

        #expect(profiles.map(\.id) == [HivraConnectionProfile.builtInHivraID])
        #expect(profiles[0].isBuiltInHivra)
        #expect(profiles[0].url.absoluteString == "https://hivra.cloud/dashboard")
    }

    @Test("developer builds add local and Canary after Hivra")
    func seedsDeveloperProfiles() {
        let profiles = HivraConnectionProfile.defaults

        #expect(profiles.map(\.kind) == [.hivraCloud, .local, .hivraCloud])
        #expect(profiles[0].isBuiltInHivra)
        #expect(profiles[1].id == HivraConnectionProfile.builtInLocalID)
        #expect(profiles[2].id == HivraConnectionProfile.builtInCanaryID)
        #expect(profiles[1].isBuiltInLocal)
        #expect(profiles[2].isBuiltInCanary)
        #expect(profiles[1].url.absoluteString == "http://127.0.0.1:3000/dashboard")
        #expect(profiles[2].url.absoluteString == "https://canary.hermesos.cloud/dashboard")
    }

    @Test("saved connections from an earlier version gain Hivra once")
    func addsHivraToSavedProfiles() {
        let saved = HivraConnectionProfile.developerDefaults
        let upgraded = HivraConnectionProfile.addingHivra(to: saved)

        #expect(upgraded.first?.id == HivraConnectionProfile.builtInHivraID)
        #expect(upgraded.count == saved.count + 1)
        #expect(HivraConnectionProfile.addingHivra(to: upgraded) == upgraded)
    }

    @Test("Hivra is recognised only on its own origin")
    func bindsHivraIdentity() {
        let wrongOrigin = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInHivraID,
            name: "Not Hivra",
            url: URL(string: "https://hivra.cloud.example/dashboard")!,
            kind: .hivraCloud
        )
        let withCredentials = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInHivraID,
            name: "Hivra",
            url: URL(string: "https://a:b@hivra.cloud/dashboard")!,
            kind: .hivraCloud
        )
        #expect(!wrongOrigin.isBuiltInHivra)
        #expect(!withCredentials.isBuiltInHivra)
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
