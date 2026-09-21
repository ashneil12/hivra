import Foundation
import Testing
import WebKit

@testable import HivraMacCore

@Suite("Hivra browser history", .serialized)
struct HivraBrowserHistoryTests {
    @MainActor
    private func eventually(_ label: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(condition(), Comment(rawValue: label))
    }

    @MainActor
    @Test("same-document navigation updates the native URL and history controls")
    func followsHistoryWithoutDocumentReload() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hivra-history-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let initial = directory.appendingPathComponent("index.html")
        try Data("<html><body>History fixture</body></html>".utf8).write(to: initial, options: .withoutOverwriting)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        var currentURL: URL?
        var canGoBack = false
        var canGoForward = false
        var isLoading = true
        let observation = HivraBrowserStateObservation(webView: webView) {
            currentURL = webView.url
            canGoBack = webView.canGoBack
            canGoForward = webView.canGoForward
            isLoading = webView.isLoading
        }
        // A real local document creates a back/forward item. Synthetic
        // loadHTMLString documents do not provide that initial history entry.
        // No server, user account, cookie or external network is needed.
        webView.loadFileURL(initial, allowingReadAccessTo: directory)
        try await eventually("initial document loaded") { currentURL == initial && !isLoading }
        try await webView.evaluateJavaScript("history.pushState({}, '', '?page=computers'); true")
        try await eventually("pushState updates URL and Back") {
            currentURL?.query == "page=computers" && canGoBack
        }
        try await webView.evaluateJavaScript("history.replaceState({}, '', '?page=agent&tab=files'); true")
        try await eventually("replaceState updates URL") {
            currentURL?.query == "page=agent&tab=files"
        }
        webView.goBack()
        try await eventually("Back restores original document and enables Forward") { currentURL == initial && canGoForward }
        webView.goForward()
        try await eventually("Forward restores current computer") { currentURL?.query == "page=agent&tab=files" && canGoBack }
        withExtendedLifetime(observation) { webView.stopLoading() }
    }
}
