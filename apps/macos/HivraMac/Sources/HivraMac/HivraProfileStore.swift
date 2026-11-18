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

    /// Local and Canary connections, and adding others, are for Hivra's own
    /// team: on in internal builds (Info.plist `HivraDeveloperConnections`) or
    /// from App settings. A public build shows Hivra only.
    static let developerConnectionsKey = "hivra.mac.developer-connections.v1"

    static func developerConnectionsEnabled(defaults: UserDefaults = .standard, bundle: Bundle = .main) -> Bool {
        if defaults.object(forKey: developerConnectionsKey) != nil {
            return defaults.bool(forKey: developerConnectionsKey)
        }
        return bundle.object(forInfoDictionaryKey: "HivraDeveloperConnections") as? Bool ?? true
    }

    @Published private(set) var developerConnections: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let developer = Self.developerConnectionsEnabled(defaults: defaults)
        developerConnections = developer

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
        selectedProfileID = profile.id
        persistSelection()
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
