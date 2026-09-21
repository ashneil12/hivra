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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        if let data = defaults.data(forKey: profilesKey),
           let decoded = try? JSONDecoder().decode([HivraConnectionProfile].self, from: data),
           !decoded.isEmpty {
            profiles = decoded
        } else {
            profiles = HivraConnectionProfile.defaults
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
            profiles = HivraConnectionProfile.defaults
        }
        if selectedProfileID == profile.id {
            selectedProfileID = profiles.first?.id
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
