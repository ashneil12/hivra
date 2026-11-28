import Foundation
import HivraMacCore
import Testing

@testable import HivraMac

@MainActor
struct HivraProfileStoreTests {
    @Test("public builds ignore legacy developer overrides without rewriting them")
    func preservesDeveloperState() throws {
        let suite = "hivra.mac.profile-tests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let internalStore = HivraProfileStore(defaults: defaults, allowsDeveloperConnections: true)
        internalStore.setDeveloperConnections(true)
        try internalStore.add(name: "QA", address: "https://qa.example.test", kind: .hivraCloud)
        let remembered = try #require(internalStore.selectedProfile)
        let before = defaults.persistentDomain(forName: suite) ?? [:]

        let publicStore = HivraProfileStore(defaults: defaults, allowsDeveloperConnections: false)
        #expect(!publicStore.developerConnections)
        #expect(publicStore.profiles == [.hivra])
        #expect(publicStore.selectedProfile == .hivra)
        publicStore.setDeveloperConnections(true)
        publicStore.select(remembered)
        #expect(publicStore.selectedProfile == .hivra)
        publicStore.select(.hivra)
        #expect(NSDictionary(dictionary: before).isEqual(to: defaults.persistentDomain(forName: suite) ?? [:]))

        let reopened = HivraProfileStore(defaults: defaults, allowsDeveloperConnections: true)
        #expect(reopened.developerConnections)
        #expect(reopened.selectedProfile == remembered)
    }

    @Test("a saved public profile ID cannot replace the bundled production origin")
    func keepsCanonicalProductionOrigin() throws {
        let suite = "hivra.mac.profile-tests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let edited = HivraConnectionProfile(
            id: HivraConnectionProfile.builtInHivraID,
            name: "QA",
            url: try #require(URL(string: "https://qa.example.test/dashboard")),
            kind: .hivraCloud
        )
        defaults.set(try JSONEncoder().encode([edited]), forKey: "hivra.mac.connection-profiles.v1")
        defaults.set(edited.id.uuidString, forKey: "hivra.mac.selected-profile.v1")
        defaults.set(true, forKey: HivraProfileStore.developerConnectionsKey)

        let store = HivraProfileStore(defaults: defaults, allowsDeveloperConnections: false)
        #expect(store.selectedProfile?.url.absoluteString == "https://hivra.cloud/dashboard")
        #expect(store.selectedProfile?.name == "Hivra")
    }
}
