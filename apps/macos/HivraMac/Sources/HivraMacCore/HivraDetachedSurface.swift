import Foundation

/// Identifies a view of an existing resource, never a request to launch a runtime.
/// Matching URLs/titles focus an existing window; different surfaces stay independent.
public struct HivraDetachedSurface: Codable, Hashable, Sendable {
    public let url: URL
    public let title: String

    public init(url: URL, title: String) {
        self.url = url
        self.title = title
    }
}
