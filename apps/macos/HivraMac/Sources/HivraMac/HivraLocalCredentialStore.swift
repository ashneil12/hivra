import Foundation
import HivraMacCore
import Security

struct HivraLocalCredentialStore {
    private let service = "cloud.hivra.mac.local-operator"

    func load(stateDirectoryURL: URL) -> HivraLocalOperatorCredentials? {
        var query = baseQuery(stateDirectoryURL: stateDirectoryURL)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(HivraLocalOperatorCredentials.self, from: data)
    }

    @discardableResult
    func save(
        _ credentials: HivraLocalOperatorCredentials,
        stateDirectoryURL: URL
    ) -> Bool {
        guard let data = try? JSONEncoder().encode(credentials) else { return false }
        let query = baseQuery(stateDirectoryURL: stateDirectoryURL)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func remove(stateDirectoryURL: URL) -> Bool {
        let status = SecItemDelete(baseQuery(stateDirectoryURL: stateDirectoryURL) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private func baseQuery(stateDirectoryURL: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrService as String: service,
            kSecAttrAccount as String: stateDirectoryURL.standardizedFileURL.path,
        ]
    }
}
