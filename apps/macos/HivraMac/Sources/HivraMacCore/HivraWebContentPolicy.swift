import Foundation

/// What a navigation inside a web view may do. WebKit renders web-content schemes
/// itself; only an explicit allowlist ever leaves the app, and only on a user's link.
public enum HivraWebNavigationDecision: Equatable, Sendable {
    case allow
    case download
    /// Hand the URL to its system handler, subject to `HivraPageActivation.openApp`,
    /// then cancel the navigation.
    case openExternally(URL)
    case cancel(reason: String)
}

/// What a request for a new window may do.
public enum HivraNewWindowDecision: Equatable, Sendable {
    /// A real WebKit popup built from the supplied configuration, so `window.opener`,
    /// `postMessage` and `window.close()` keep working for OAuth, payments and connectors.
    case inAppPopup
    case openInDefaultBrowser(URL)
    /// Hand the URL to its system handler (mail, phone), subject to `HivraPageActivation.openApp`.
    case openExternally(URL)
    case refuse(reason: String)
}

public enum HivraWebContentPolicy {
    /// Schemes WebKit resolves itself. They are never handed to NSWorkspace.
    public static let webContentSchemes: Set<String> = ["http", "https", "about", "blob", "data", "javascript"]
    /// Schemes handed to their system handler for a link in the main frame, after
    /// `HivraPageActivation.openApp` agrees. Add "hivra" here once the app registers its
    /// own URL scheme.
    public static let externalSchemes: Set<String> = ["mailto", "tel"]

    /// `targetsMainFrame` is false for subframes and for new-window requests (no target frame).
    /// `sourceIsMainFrame` is false when a frame navigates another one, such as `target=_top`.
    public static func navigation(
        url: URL?,
        targetsMainFrame: Bool,
        sourceIsMainFrame: Bool,
        opensNewWindow: Bool,
        isLinkActivation: Bool,
        shouldPerformDownload: Bool
    ) -> HivraWebNavigationDecision {
        if shouldPerformDownload { return .download }
        guard let url, let scheme = url.scheme?.lowercased() else {
            return .cancel(reason: "navigation without a URL scheme")
        }
        // WebKit asks the new-window policy before it asks for a window. The window
        // request makes the whole decision, including external schemes.
        if opensNewWindow { return .allow }
        if webContentSchemes.contains(scheme) { return .allow }
        if externalSchemes.contains(scheme) {
            // A frame's link aimed at the top window is still the frame's request.
            return targetsMainFrame && sourceIsMainFrame && isLinkActivation
                ? .openExternally(url)
                : .cancel(reason: "\(scheme) requires a link activation in the main frame")
        }
        return .cancel(reason: "\(scheme) is not an allowed scheme")
    }

    /// Every call is already user-activated: WebKit's popup blocker stays on
    /// (`javaScriptCanOpenWindowsAutomatically == false`), so script without a user
    /// gesture never reaches the window request.
    public static func newWindow(
        url: URL?,
        isLinkActivation: Bool,
        sourceIsMainFrame: Bool,
        connectionURL: URL
    ) -> HivraNewWindowDecision {
        // window.open(), window.open('') and window.open('about:blank') create an
        // empty window the opener fills in later, so the destination is unknown here.
        guard let url, !url.absoluteString.isEmpty else { return .inAppPopup }
        switch url.scheme?.lowercased() {
        case "about":
            return isAboutBlank(url) ? .inAppPopup : .refuse(reason: "about page in a new window")
        case "http", "https":
            if isSameOrigin(url, connectionURL) || isAuthProvider(url, connectionURL: connectionURL) {
                return .inAppPopup
            }
            // A link the user followed (agent chat, help, docs) belongs in their browser.
            // Scripted windows and form posts keep their opener and request body in-app.
            return isLinkActivation ? .openInDefaultBrowser(url) : .inAppPopup
        case "blob":
            // Only the page's own origin can load its blobs; the popup shares its process.
            return .inAppPopup
        case let scheme? where externalSchemes.contains(scheme):
            return isLinkActivation && sourceIsMainFrame
                ? .openExternally(url)
                : .refuse(reason: "\(scheme) requires a link activation in the main frame")
        case let scheme?:
            return .refuse(reason: "\(scheme) is not allowed in a new window")
        case nil:
            return .refuse(reason: "new window without a URL scheme")
        }
    }

    /// Attachments and content WebKit cannot display are saved rather than shown.
    public static func shouldDownload(canShowMIMEType: Bool, contentDisposition: String?) -> Bool {
        if !canShowMIMEType { return true }
        guard let disposition = contentDisposition else { return false }
        let type = disposition.split(separator: ";", maxSplits: 1).first ?? ""
        return type.trimmingCharacters(in: .whitespaces).lowercased() == "attachment"
    }

    /// Sign-in providers whose popups must return to the page that opened them.
    public static func isAuthProvider(_ url: URL, connectionURL: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        let path = url.path.lowercased()
        switch host {
        case "accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com":
            return true
        case "github.com":
            return path == "/login" || path.hasPrefix("/login/") || path.hasPrefix("/sessions/")
        default:
            break
        }
        // Clerk development instances (<slug>.clerk.accounts.dev) and their account pages.
        if host.hasSuffix(".accounts.dev") { return true }
        // Clerk production instances serve from clerk.<domain> and accounts.<domain>
        // beside the connection's own domain.
        guard let connectionHost = connectionURL.host?.lowercased() else { return false }
        var labels = connectionHost.split(separator: ".").map(String.init)
        while labels.count >= 2 {
            let domain = labels.joined(separator: ".")
            if host == "clerk.\(domain)" || host == "accounts.\(domain)" { return true }
            labels.removeFirst()
        }
        return false
    }

    static func isAboutBlank(_ url: URL) -> Bool {
        let value = url.absoluteString.lowercased()
        return value == "about:blank" || value.hasPrefix("about:blank#") || value.hasPrefix("about:blank?")
    }

    public static func isSameOrigin(_ url: URL, _ other: URL) -> Bool {
        guard let origin = HivraTrustedWebOrigin(url), let otherOrigin = HivraTrustedWebOrigin(other) else { return false }
        return origin == otherOrigin
    }
}
