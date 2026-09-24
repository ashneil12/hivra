import CoreGraphics
import Foundation

/// How a page's origin is named in native chrome: JavaScript dialogs and popup titles.
public enum HivraWebOriginLabel {
    /// `canary.hermesos.cloud`, `http://127.0.0.1:3000`; opaque origins become "This page".
    public static func make(scheme: String, host: String, port: Int) -> String {
        let scheme = scheme.lowercased()
        guard !host.isEmpty, scheme == "http" || scheme == "https" else { return "This page" }
        let displayHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let defaultPort = scheme == "https" ? 443 : 80
        let authority = port == 0 || port == defaultPort ? displayHost : "\(displayHost):\(port)"
        // Plain HTTP stays visibly marked; HTTPS is the unremarkable default.
        return scheme == "https" ? authority : "http://\(authority)"
    }

    public static func make(url: URL?) -> String? {
        guard let url, let scheme = url.scheme, let host = url.host else { return nil }
        return make(scheme: scheme, host: host, port: url.port ?? 0)
    }
}

/// Popup windows have no address bar, so the title always names the page's origin.
public enum HivraPopupTitle {
    public static let placeholder = "Hivra"
    static let maximumPageTitleLength = 80

    public static func make(pageTitle: String?, url: URL?) -> String {
        let origin = HivraWebOriginLabel.make(url: url)
        let title = (pageTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return origin ?? placeholder }
        let bounded = title.count > maximumPageTitleLength
            ? String(title.prefix(maximumPageTitleLength - 1)) + "…" : title
        guard let origin, bounded != origin else { return bounded }
        return "\(bounded) — \(origin)"
    }
}

/// Popup size from `window.open` features, kept usable and on screen.
/// Requested positions are ignored: popups open over the window that asked for them.
public enum HivraPopupWindowGeometry {
    public static let defaultSize = CGSize(width: 980, height: 760)
    public static let minimumSize = CGSize(width: 360, height: 280)
    static let screenMargin: CGFloat = 40

    public static func contentSize(requestedWidth: Double?, requestedHeight: Double?, visibleFrame: CGRect?) -> CGSize {
        let maximum = visibleFrame.map {
            CGSize(width: max(minimumSize.width, $0.width - screenMargin * 2),
                   height: max(minimumSize.height, $0.height - screenMargin * 2))
        }
        func clamp(_ value: Double?, fallback: CGFloat, minimum: CGFloat, maximum: CGFloat?) -> CGFloat {
            let requested = value.flatMap { $0.isFinite && $0 > 0 ? CGFloat($0) : nil } ?? fallback
            return min(max(requested, minimum), maximum ?? .greatestFiniteMagnitude)
        }
        return CGSize(
            width: clamp(requestedWidth, fallback: defaultSize.width, minimum: minimumSize.width, maximum: maximum?.width),
            height: clamp(requestedHeight, fallback: defaultSize.height, minimum: minimumSize.height, maximum: maximum?.height)
        )
    }
}
