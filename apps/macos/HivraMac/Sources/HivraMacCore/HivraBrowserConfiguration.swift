import WebKit

public enum HivraBrowserConfiguration {
    public static let applicationName = "HivraMac/0.1"
    public static let nativeDesktopHandlerName = "hivraNativeDesktop"

    @MainActor
    public static func make(
        nativeDesktopHandler: WKScriptMessageHandlerWithReply? = nil
    ) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isElementFullscreenEnabled = true
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
