import AppKit
import Combine
import Foundation
import HivraMacCore
import WebKit

private final class HivraLocalAuthSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        // A local sign-in request carries a reusable operator password. Never
        // allow URLSession to replay it to a redirect destination.
        completionHandler(nil)
    }
}

@MainActor
final class HivraBrowserModel: NSObject, ObservableObject {
    @Published private(set) var currentURL: URL?
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var workspaceSnapshot: HivraWorkspaceSnapshot?
    @Published private(set) var surfaceSnapshot: HivraSurfaceSnapshot?

    let webView: WKWebView
    private let nativeDesktopBridge: HivraNativeDesktopBridge
    private let workspaceBridge: HivraWorkspaceBridge?
    private let trustedURL: URL
    var openDetachedSurface: ((URL) -> Void)?
    var handleWorkspaceNavigation: ((URL) -> Bool)?
    private var workspaceNavigationRequest = UUID()
    private var localAuthenticationTask: Task<Void, Never>?
    private var navigationObservation: HivraBrowserStateObservation?

    init(
        initialURL: URL,
        localCredentials: HivraLocalOperatorCredentials? = nil,
        nativeWorkspace: Bool = false
    ) {
        let nativeDesktopBridge = HivraNativeDesktopBridge(trustedURL: initialURL)
        let configuration = HivraBrowserConfiguration.make(nativeDesktopHandler: nativeDesktopBridge)
        let workspaceBridge = nativeWorkspace ? HivraWorkspaceBridge(trustedURL: initialURL) : nil
        if let workspaceBridge {
            HivraWorkspaceBridge.install(in: configuration, trustedURL: initialURL, handler: workspaceBridge)
        }

        self.nativeDesktopBridge = nativeDesktopBridge
        self.workspaceBridge = workspaceBridge
        trustedURL = initialURL
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        workspaceBridge?.receive = { [weak self] message in
            guard let self else { return }
            switch message {
            case .workspace(let snapshot): workspaceSnapshot = snapshot
            case .surfaces(let snapshot):
                guard let url = webView.url, url.path == snapshot.pathname else { return }
                surfaceSnapshot = snapshot
            }
        }

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        navigationObservation = HivraBrowserStateObservation(webView: webView) { [weak self] in
            self?.updateState()
        }
        load(initialURL, localCredentials: localCredentials)
    }

    func load(
        _ url: URL,
        localCredentials: HivraLocalOperatorCredentials? = nil
    ) {
        workspaceNavigationRequest = UUID()
        cancelAutomaticSignIn()
        errorMessage = nil
        if let localCredentials,
           HivraLocalAuthentication.supportsAutomaticSignIn(to: url) {
            localAuthenticationTask = Task { [weak self] in
                guard let self else { return }
                _ = await establishLocalSession(at: url, credentials: localCredentials)
                guard !Task.isCancelled else { return }
                // Manual local-operator sign-in remains the safe fallback for
                // existing installs, a changed password, or a rejected login.
                loadPage(url)
                localAuthenticationTask = nil
            }
            return
        }
        loadPage(url)
    }

    func cancelAutomaticSignIn() {
        localAuthenticationTask?.cancel()
        localAuthenticationTask = nil
    }

    func clearLocalSession(andLoad url: URL) {
        cancelAutomaticSignIn()
        webView.stopLoading()
        let cookieStore = webView.configuration.websiteDataStore.httpCookieStore
        localAuthenticationTask = Task { [weak self] in
            let cookies = await withCheckedContinuation { continuation in
                cookieStore.getAllCookies { continuation.resume(returning: $0) }
            }
            for cookie in cookies where
                cookie.name == HivraLocalAuthentication.sessionCookieName
                && cookie.domain == "127.0.0.1" {
                await withCheckedContinuation { continuation in
                    cookieStore.delete(cookie) { continuation.resume() }
                }
            }
            guard !Task.isCancelled, let self else { return }
            loadPage(url)
            localAuthenticationTask = nil
        }
    }

    private func loadPage(_ url: URL) {
        webView.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData))
    }

    private func establishLocalSession(
        at dashboardURL: URL,
        credentials: HivraLocalOperatorCredentials
    ) async -> Bool {
        do {
            let request = try HivraLocalAuthentication.loginRequest(
                dashboardURL: dashboardURL,
                credentials: credentials
            )
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            let redirectDelegate = HivraLocalAuthSessionDelegate()
            let session = URLSession(
                configuration: configuration,
                delegate: redirectDelegate,
                delegateQueue: nil
            )
            defer { session.invalidateAndCancel() }
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  HivraLocalAuthentication.isExpectedLoginResponse(
                    httpResponse.url,
                    for: request.url!
                  ),
                  let setCookie = httpResponse.value(forHTTPHeaderField: "Set-Cookie") else {
                return false
            }
            let cookies = HTTPCookie.cookies(
                withResponseHeaderFields: ["Set-Cookie": setCookie],
                for: request.url!
            )
            guard let sessionCookie = cookies.first(where: {
                $0.name == HivraLocalAuthentication.sessionCookieName
            }) else {
                return false
            }
            await withCheckedContinuation { continuation in
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(sessionCookie) {
                    continuation.resume()
                }
            }
            return true
        } catch {
            return false
        }
    }

    func reload() {
        errorMessage = nil
        webView.reload()
    }

    func stopLoading() {
        webView.stopLoading()
        updateState()
    }

    func toggleLoading() {
        if isLoading {
            stopLoading()
        } else {
            reload()
        }
    }

    func goBack() {
        webView.goBack()
    }

    func goForward() {
        webView.goForward()
    }

    func navigateWorkspace(to path: String) {
        guard let path = HivraWorkspaceRoute.normalizedPath(path),
              let url = HivraWorkspaceRoute.url(for: path, profile: .init(name: "", url: trustedURL, kind: .custom)) else { return }
        guard workspaceSnapshot?.ownerKey != nil, let currentURL = webView.url,
              HivraWorkspacePolicy.relativePath(url: currentURL, trustedURL: trustedURL) != nil else {
            load(url)
            return
        }
        let request = UUID()
        workspaceNavigationRequest = request
        webView.callAsyncJavaScript(
            "return !window.dispatchEvent(new CustomEvent('hivra:navigate', {detail: {href}, cancelable: true}));",
            arguments: ["href": path], in: nil, in: .page,
            completionHandler: { [weak self] result in
                guard let self, workspaceNavigationRequest == request else { return }
                if case .success(let value) = result, value as? Bool == true { return }
                // An absent listener does not acknowledge dispatch. Do not overwrite a newer user navigation.
                if webView.url == currentURL { load(url) }
            }
        )
    }

    func refreshWorkspace() {
        let currentURL = webView.url
        webView.callAsyncJavaScript(
            "return !window.dispatchEvent(new Event('hivra:refresh', {cancelable: true}));",
            arguments: [:], in: nil, in: .page,
            completionHandler: { [weak self] result in
                guard let self, webView.url == currentURL else { return }
                if case .success(let value) = result, value as? Bool == true { return }
                reload()
            }
        )
    }

    public func selectWorkspaceSurface(_ id: String) {
        guard let snapshot = surfaceSnapshot, let url = webView.url,
              workspaceSnapshot?.ownerKey != nil,
              HivraWorkspaceBridgeTrust.accepts(trustedURL: trustedURL, frameURL: url, isMainFrame: true),
              url.path == snapshot.pathname, snapshot.surfaces.contains(where: { $0.id == id }) else { return }
        webView.callAsyncJavaScript(
            "if (location.pathname !== pathname) return false; return !window.dispatchEvent(new CustomEvent('hivra:select-surface', {detail: {pathname, id}, cancelable: true}));",
            arguments: ["pathname": snapshot.pathname, "id": id], in: nil, in: .page, completionHandler: nil
        )
    }

    func clearWorkspaceMetadata() {
        surfaceSnapshot = nil
        workspaceSnapshot = HivraWorkspaceSnapshot(ownerKey: nil, resources: [], loading: false, errors: [:])
    }

    private func updateState() {
        // History navigation inside React does not invoke didCommit, but a settled login URL is still an account exit.
        if workspaceBridge != nil, !webView.isLoading, workspaceSnapshot?.ownerKey != nil,
           let url = webView.url, HivraWorkspacePolicy.isCommittedAccountEntry(url: url, trustedURL: trustedURL) {
            clearWorkspaceMetadata()
        }
        if let snapshot = surfaceSnapshot, snapshot.pathname != webView.url?.path { surfaceSnapshot = nil }
        currentURL = webView.url
        isLoading = webView.isLoading
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
    }
}

extension HivraBrowserModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        workspaceNavigationRequest = UUID()
        errorMessage = nil
        surfaceSnapshot = nil
        updateState()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if workspaceBridge != nil, let url = webView.url,
           HivraWorkspacePolicy.isCommittedAccountEntry(url: url, trustedURL: trustedURL) { clearWorkspaceMetadata() }
        updateState()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateState()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    private func handleNavigationFailure(_ error: Error) {
        guard HivraNavigationErrorPolicy.shouldPresent(error) else {
            updateState()
            return
        }
        errorMessage = error.localizedDescription
        updateState()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        if let scheme = url.scheme?.lowercased(), scheme != "http" && scheme != "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        if navigationAction.targetFrame?.isMainFrame == true,
           handleWorkspaceNavigation?(url) == true {
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }
}

extension HivraBrowserModel: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else {
            return nil
        }

        openDetachedSurface?(url)
        return nil
    }
}
