import Foundation
import WebKit

/// Observes full loads and same-document History API navigation alike.
@MainActor
public final class HivraBrowserStateObservation {
    private var observations: [NSKeyValueObservation] = []
    private let onChange: @MainActor () -> Void

    public init(webView: WKWebView, onChange: @escaping @MainActor () -> Void) {
        self.onChange = onChange
        let refresh: @Sendable () -> Void = { [weak self] in
            Task { @MainActor [weak self] in
                self?.onChange()
            }
        }
        // History API navigation does not finish a new document load. WebKit
        // still updates these KVO properties; no injected page script needed.
        observations = [
            webView.observe(\.url, options: [.initial, .new]) { _, _ in refresh() },
            webView.observe(\.canGoBack, options: [.new]) { _, _ in refresh() },
            webView.observe(\.canGoForward, options: [.new]) { _, _ in refresh() },
            webView.observe(\.isLoading, options: [.new]) { _, _ in refresh() },
            webView.observe(\.title, options: [.new]) { _, _ in refresh() },
        ]
    }
}
