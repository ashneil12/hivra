import Combine
import Foundation
import HivraMacCore

@MainActor
final class HivraProfileStore: ObservableObject {
    @Published private(set) var profiles: [HivraConnectionProfile]
    @Published var selectedProfileID: HivraConnectionProfile.ID?

    private let defaults: UserDefaults
    private let profilesKey = "hivra.mac.connection-profiles.v1"
    private let selectionKey = "hivra.mac.selected-profile.v1"

    static let developerConnectionsKey = "hivra.mac.developer-connections.v1"
    let allowsDeveloperConnections: Bool
    @Published private(set) var developerConnections: Bool

    init(
        defaults: UserDefaults = .standard,
        allowsDeveloperConnections: Bool = Bundle.main.object(forInfoDictionaryKey: "HivraDeveloperConnections") as? Bool == true
    ) {
        self.defaults = defaults
        self.allowsDeveloperConnections = allowsDeveloperConnections
        let developer = allowsDeveloperConnections &&
            (defaults.object(forKey: Self.developerConnectionsKey) == nil || defaults.bool(forKey: Self.developerConnectionsKey))
        developerConnections = developer

        guard allowsDeveloperConnections else {
            profiles = [.hivra]
            selectedProfileID = HivraConnectionProfile.builtInHivraID
            return
        }

        if developer,
           let data = defaults.data(forKey: profilesKey),
           let decoded = try? JSONDecoder().decode([HivraConnectionProfile].self, from: data),
           !decoded.isEmpty {
            profiles = HivraConnectionProfile.addingHivra(to: decoded)
        } else {
            profiles = HivraConnectionProfile.defaults(includeDeveloper: developer)
        }

        if let rawSelection = defaults.string(forKey: selectionKey),
           let selection = UUID(uuidString: rawSelection),
           profiles.contains(where: { $0.id == selection }) {
            selectedProfileID = selection
        } else {
            selectedProfileID = profiles.first?.id
        }
    }

    var selectedProfile: HivraConnectionProfile? {
        guard let selectedProfileID else { return profiles.first }
        return profiles.first(where: { $0.id == selectedProfileID }) ?? profiles.first
    }

    func add(name: String, address: String, kind: HivraConnectionKind) throws {
        let url = try HivraConnectionProfile.normalizedURL(from: address)
        let profile = HivraConnectionProfile(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? kind.displayName
                : name.trimmingCharacters(in: .whitespacesAndNewlines),
            url: url,
            kind: kind
        )
        profiles.append(profile)
        selectedProfileID = profile.id
        persist()
    }

    func remove(_ profile: HivraConnectionProfile) {
        profiles.removeAll(where: { $0.id == profile.id })
        if profiles.isEmpty {
            profiles = HivraConnectionProfile.defaults(includeDeveloper: developerConnections)
        }
        if selectedProfileID == profile.id {
            selectedProfileID = profiles.first?.id
        }
        persist()
    }

    func setDeveloperConnections(_ enabled: Bool) {
        guard allowsDeveloperConnections else { return }
        defaults.set(enabled, forKey: Self.developerConnectionsKey)
        developerConnections = enabled
        if enabled {
            if let data = defaults.data(forKey: profilesKey),
               let decoded = try? JSONDecoder().decode([HivraConnectionProfile].self, from: data),
               !decoded.isEmpty {
                profiles = HivraConnectionProfile.addingHivra(to: decoded)
            } else {
                profiles = HivraConnectionProfile.defaults(includeDeveloper: true)
            }
        } else {
            profiles = HivraConnectionProfile.defaults(includeDeveloper: false)
            selectedProfileID = HivraConnectionProfile.builtInHivraID
            persistSelection()
            return
        }
        persist()
    }

    func select(_ profile: HivraConnectionProfile) {
        guard profiles.contains(profile) else { return }
        selectedProfileID = profile.id
        if allowsDeveloperConnections { persistSelection() }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(profiles) {
            defaults.set(data, forKey: profilesKey)
        }
        persistSelection()
    }

    private func persistSelection() {
        defaults.set(selectedProfileID?.uuidString, forKey: selectionKey)
    }
}
