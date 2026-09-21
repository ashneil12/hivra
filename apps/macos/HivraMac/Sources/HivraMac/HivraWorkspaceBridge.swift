import Foundation
import HivraMacCore
import WebKit

/// Display metadata and navigation only. Desktop authority stays in its separate bridge.
@MainActor
final class HivraWorkspaceBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "hivraWorkspace"
    private let trustedURL: URL
    var receive: ((HivraWorkspaceBridgeMessage) -> Void)?

    init(trustedURL: URL) { self.trustedURL = trustedURL }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard HivraWorkspaceBridgeTrust.accepts(
            trustedURL: trustedURL,
            frameURL: message.frameInfo.request.url,
            isMainFrame: message.frameInfo.isMainFrame
        ), let parsed = HivraWorkspaceBridgeMessage.parse(message.body) else { return }
        let origin = message.frameInfo.securityOrigin
        guard HivraTrustedWebOrigin(trustedURL)?.matches(scheme: origin.protocol, host: origin.host, port: origin.port) == true else { return }
        receive?(parsed)
    }

    static func install(in configuration: WKWebViewConfiguration, trustedURL: URL, handler: HivraWorkspaceBridge) {
        configuration.userContentController.add(handler, name: handlerName)
        guard let origin = HivraWorkspaceBridgeTrust.canonicalOrigin(trustedURL),
              let encoded = try? JSONSerialization.data(withJSONObject: [origin]),
              let json = String(data: encoded, encoding: .utf8) else { return }
        let script = """
        (() => {
          if (window.top !== window || location.origin !== new URL(\(json)[0]).origin) return;
          Object.defineProperty(window, '__HIVRA_NATIVE_WORKSPACE__', {
            value: Object.freeze({ version: 1 }), configurable: false, writable: false
          });
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
}
