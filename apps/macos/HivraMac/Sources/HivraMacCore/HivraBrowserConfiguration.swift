import WebKit

/// The product token appended to WebKit's user agent: `HivraMac/<CFBundleShortVersionString>`.
public enum HivraAppIdentity {
    public static let userAgentProduct = "HivraMac"
    /// Unbundled builds (swift run, swift test) have no Hivra version to report.
    public static let developmentVersion = "0.0.0-dev"
    static let bundleIdentifierPrefix = "cloud.hivra.mac"

    public static func userAgentApplicationName(infoDictionary: [String: Any]?) -> String {
        "\(userAgentProduct)/\(version(infoDictionary: infoDictionary))"
    }

    static func version(infoDictionary: [String: Any]?) -> String {
        // Only the Hivra bundle's version counts; a test runner's bundle is not the app.
        guard let identifier = infoDictionary?["CFBundleIdentifier"] as? String,
              identifier == bundleIdentifierPrefix || identifier.hasPrefix(bundleIdentifierPrefix + "."),
              let version = infoDictionary?["CFBundleShortVersionString"] as? String,
              !version.isEmpty, version.utf8.count <= 32,
              version.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || "._-+".unicodeScalars.contains($0) })
        else { return developmentVersion }
        return version
    }
}

public enum HivraBrowserConfiguration {
    public static let applicationName = HivraAppIdentity.userAgentApplicationName(infoDictionary: Bundle.main.infoDictionary)
    public static let nativeDesktopHandlerName = "hivraNativeDesktop"

    @MainActor
    public static func make(
        nativeDesktopHandler: WKScriptMessageHandlerWithReply? = nil
    ) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isElementFullscreenEnabled = true
        // macOS defaults this to true. Keep WebKit's popup blocker so every window
        // request reaching the app follows a user gesture, as in a browser.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = applicationName
        if let nativeDesktopHandler {
            configuration.userContentController.addScriptMessageHandler(
                nativeDesktopHandler,
                contentWorld: .page,
                name: nativeDesktopHandlerName
            )
        }
        return configuration
    }
}
