import AppKit
import Combine
import Foundation
import HivraMacCore
import OSLog
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

/// What a browser may reach beyond ordinary web content.
enum HivraBrowserRole {
    /// Owned by a connection profile: the connection browser, resource tabs and their
    /// pop-out windows. Only these views carry the native bridges, trusting the profile's origin.
    case connection(HivraConnectionProfile)
    /// URL-based surface windows: ordinary web content with no native bridges.
    case unprivileged
}

enum HivraBrowserFailure: Equatable {
    case unreachable(String)
    case contentProcessTerminated
}

@MainActor
final class HivraBrowserModel: NSObject, ObservableObject {
    private static let logger = Logger(subsystem: "cloud.hivra.mac.alpha", category: "web-content")
    private static let downloadNoticeDuration: Duration = .seconds(10)

    @Published private(set) var currentURL: URL?
    @Published private(set) var pageTitle: String?
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var failure: HivraBrowserFailure?
    @Published private(set) var workspaceSnapshot: HivraWorkspaceSnapshot?
    @Published private(set) var surfaceSnapshot: HivraSurfaceSnapshot?
    @Published private(set) var downloadNotice: HivraDownloadNotice?

    let webView: HivraInputCountingWebView
    /// True only for connection-owned views that carry the native bridges.
    let isPrivileged: Bool
    let isPopup: Bool
    private let nativeDesktopBridge: HivraNativeDesktopBridge?
    private let workspaceBridge: HivraWorkspaceBridge?
    /// The connection origin that routing and new-window policy are judged against.
    private let trustedURL: URL
    private let services: HivraBrowserServices
    private weak var opener: HivraBrowserModel?
    var handleWorkspaceNavigation: ((URL) -> Bool)?
    /// A dashboard route opened in a new window joins the workspace instead of a popup.
    var handleWorkspaceNewWindow: ((URL) -> Bool)?
    /// Closes the popup window hosting this browser, after `window.close()` or an empty download window.
    var requestClose: (() -> Void)?
    private var workspaceNavigationRequest = UUID()
    private var localAuthenticationTask: Task<Void, Never>?
    private var navigationObservation: HivraBrowserStateObservation?
    private var lastRequestedURL: URL?
    private var retryURL: URL?
    private var presentedDialogs = 0
    private var dialogsSuppressed = false
    private var downloadNoticeDismissal: Task<Void, Never>?
    /// Downloads and app hand-offs this document may start without asking.
    private var activation = HivraPageActivation()
    /// One question per requesting origin; further downloads from it wait for the answer.
    private var pendingDownloadQuestions: [String: Task<Bool, Never>] = [:]
    /// Popup windows this page opened. They close with it.
    private(set) var popupWindows: [HivraPopupWindowController] = []

    convenience init(
        initialURL: URL,
        role: HivraBrowserRole,
        localCredentials: HivraLocalOperatorCredentials? = nil,
        services: HivraBrowserServices = .live
    ) {
        switch role {
        case .connection(let profile):
            let nativeDesktopBridge = HivraNativeDesktopBridge(trustedURL: profile.url)
            let configuration = HivraBrowserConfiguration.make(nativeDesktopHandler: nativeDesktopBridge)
            let workspaceBridge = HivraWorkspaceBridge(trustedURL: profile.url)
            HivraWorkspaceBridge.install(in: configuration, trustedURL: profile.url, handler: workspaceBridge)
            self.init(configuration: configuration, trustedURL: profile.url, nativeDesktopBridge: nativeDesktopBridge,
                      workspaceBridge: workspaceBridge, services: services, opener: nil)
        case .unprivileged:
            self.init(configuration: HivraBrowserConfiguration.make(), trustedURL: initialURL, nativeDesktopBridge: nil,
                      workspaceBridge: nil, services: services, opener: nil)
        }
        load(initialURL, localCredentials: localCredentials)
    }

    private init(
        configuration: WKWebViewConfiguration,
        trustedURL: URL,
        nativeDesktopBridge: HivraNativeDesktopBridge?,
        workspaceBridge: HivraWorkspaceBridge?,
        services: HivraBrowserServices,
        opener: HivraBrowserModel?
    ) {
        self.nativeDesktopBridge = nativeDesktopBridge
        self.workspaceBridge = workspaceBridge
        self.trustedURL = trustedURL
        self.services = services
        self.opener = opener
        isPrivileged = nativeDesktopBridge != nil
        isPopup = opener != nil
        webView = HivraInputCountingWebView(frame: .zero, configuration: configuration)
        super.init()

        workspaceBridge?.receive = { [weak self] message in
            self?.receiveWorkspaceMessage(message)
        }

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        navigationObservation = HivraBrowserStateObservation(webView: webView) { [weak self] in
            self?.updateState()
        }
    }

    deinit {
        // Explicit teardown closes popups first; this covers an owner that simply lets go.
        let popups = popupWindows
        guard !popups.isEmpty else { return }
        Task { @MainActor in
            for popup in popups { popup.close() }
        }
    }

    // Called only after the workspace bridge has validated the frame and origin.
    func receiveWorkspaceMessage(_ message: HivraWorkspaceBridgeMessage) {
        switch message {
        case .workspace(let snapshot): workspaceSnapshot = snapshot
        case .surfaces(let snapshot):
            guard let url = webView.url, url.path == snapshot.pathname else { return }
            surfaceSnapshot = snapshot
        }
    }

    func load(
        _ url: URL,
        localCredentials: HivraLocalOperatorCredentials? = nil
    ) {
        workspaceNavigationRequest = UUID()
        cancelAutomaticSignIn()
        failure = nil
        retryURL = nil
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
        lastRequestedURL = url
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
        let retry = retryURL
        failure = nil
        retryURL = nil
        if let retry {
            // A failed load never committed, so WebKit has nothing of its own to reload.
            loadPage(retry)
        } else if webView.backForwardList.currentItem == nil, let lastRequestedURL {
            loadPage(lastRequestedURL)
        } else {
            webView.reload()
        }
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

    /// Closes every popup this page opened, and theirs in turn.
    func closeOwnedPopups() {
        for popup in popupWindows { popup.close() }
    }

    func presentDownload(_ notice: HivraDownloadNotice) {
        downloadNoticeDismissal?.cancel()
        downloadNotice = notice
        downloadNoticeDismissal = Task { [weak self] in
            try? await Task.sleep(for: Self.downloadNoticeDuration)
            guard !Task.isCancelled, let self, downloadNotice?.id == notice.id else { return }
            downloadNotice = nil
        }
    }

    func dismissDownloadNotice() {
        downloadNoticeDismissal?.cancel()
        downloadNotice = nil
    }

    private func updateState() {
        // History navigation inside React does not invoke didCommit, but a settled login URL is still an account exit.
        if workspaceBridge != nil, !webView.isLoading, workspaceSnapshot?.ownerKey != nil,
           let url = webView.url, HivraWorkspacePolicy.isCommittedAccountEntry(url: url, trustedURL: trustedURL) {
            clearWorkspaceMetadata()
        }
        if let snapshot = surfaceSnapshot, snapshot.pathname != webView.url?.path { surfaceSnapshot = nil }
        currentURL = webView.url
        pageTitle = webView.title
        isLoading = webView.isLoading
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
    }

    private func openPopup(configuration: WKWebViewConfiguration, windowFeatures: WKWindowFeatures) -> WKWebView {
        // WebKit requires the supplied configuration: it carries the opener relationship,
        // web process and session. Only its script handlers are replaced, because a popup
        // is ordinary web content and never inherits the connection's native bridges.
        configuration.userContentController = WKUserContentController()
        let popup = HivraBrowserModel(configuration: configuration, trustedURL: trustedURL, nativeDesktopBridge: nil,
                                      workspaceBridge: nil, services: services, opener: self)
        let controller = HivraPopupWindowController(browser: popup, windowFeatures: windowFeatures,
                                                    openerWindow: webView.window) { [weak self] closed in
            self?.popupWindows.removeAll { $0 === closed }
        }
        popupWindows.append(controller)
        controller.present()
        return popup.webView
    }

    private var hasCommittedContent: Bool {
        guard let item = webView.backForwardList.currentItem else { return false }
        return item.url.scheme?.lowercased() != "about"
    }

    private func adopt(_ download: WKDownload) {
        // A popup opened only to fetch a file has nothing to show: report the download
        // where the user started it and close the empty window.
        if isPopup, !hasCommittedContent, let opener {
            services.downloads.track(download, for: opener)
            Task { @MainActor [weak self] in self?.requestClose?() }
        } else {
            services.downloads.track(download, for: self)
        }
    }

    private func logRefusal(_ reason: String, url: URL?, frame: String) {
        // Scheme and reason only: URLs can carry one-time tokens.
        let scheme = url?.scheme?.lowercased() ?? "none"
        Self.logger.notice("Refused \(scheme, privacy: .public) request from \(frame, privacy: .public): \(reason, privacy: .public)")
    }

    private func origin(of frame: WKFrameInfo) -> String {
        let origin = frame.securityOrigin
        return HivraWebOriginLabel.make(scheme: origin.protocol, host: origin.host, port: origin.port)
    }

    private func isConnectionOrigin(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return HivraTrustedWebOrigin(trustedURL)?.matches(scheme: origin.protocol, host: origin.host, port: origin.port) == true
    }

    private func webOrigin(of frame: WKFrameInfo) -> HivraTrustedWebOrigin? {
        let origin = frame.securityOrigin
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host
        components.port = origin.port == 0 ? nil : origin.port
        return components.url.flatMap(HivraTrustedWebOrigin.init)
    }

    /// Answers through `decide` once `HivraPageActivation` or the user has.
    private func decideDownload(
        requester: String,
        fromMainFrame: Bool,
        fromConnectionOrigin: Bool,
        url: URL?,
        decide: @escaping @MainActor (Bool) -> Void
    ) {
        let frame = fromMainFrame ? "main frame" : "subframe"
        switch activation.download(requester: requester, fromMainFrame: fromMainFrame,
                                   fromConnectionOrigin: fromConnectionOrigin, input: webView.userInputCount) {
        case .allow:
            decide(true)
        case .refuse(let reason):
            logRefusal("download: \(reason)", url: url, frame: frame)
            decide(false)
        case .ask:
            let question = pendingDownloadQuestions[requester] ?? askForMoreDownloads(from: requester)
            Task { [weak self] in
                let allowed = await question.value
                if !allowed { self?.logRefusal("download: the user did not allow more downloads", url: url, frame: frame) }
                decide(allowed)
            }
        }
    }

    private func askForMoreDownloads(from requester: String) -> Task<Bool, Never> {
        let document = activation.document
        let question = Task { [weak self] () -> Bool in
            guard let self else { return false }
            let allowed = await services.dialogs.confirmMoreDownloads(from: requester, in: webView.window)
            activation.recordDownloadAnswer(allowed, requester: requester, document: document)
            if activation.document == document { pendingDownloadQuestions[requester] = nil }
            return allowed
        }
        pendingDownloadQuestions[requester] = question
        return question
    }

    /// Hands `url` to its app when `HivraPageActivation` or the user allows it.
    private func openApp(_ url: URL, requestedBy frame: WKFrameInfo) {
        let requester = origin(of: frame)
        switch activation.openApp(fromConnectionOrigin: isConnectionOrigin(frame), input: webView.userInputCount) {
        case .allow:
            services.systemURLs.open(url)
        case .refuse(let reason):
            logRefusal(reason, url: url, frame: "main frame")
        case .ask:
            let document = activation.document
            Task { [weak self] in
                guard let self else { return }
                let response = await services.dialogs.confirmOpeningApp(for: url, from: requester, in: webView.window)
                activation.appOpenAnswered(blockingFurther: response.suppressesFurtherDialogs, document: document)
                if response.value {
                    services.systemURLs.open(url)
                } else {
                    logRefusal("the user did not allow opening the app", url: url, frame: "main frame")
                }
            }
        }
    }

    /// False when the user has asked this page to stop presenting dialogs.
    private func beginDialog() -> Bool {
        guard !dialogsSuppressed else { return false }
        presentedDialogs += 1
        return true
    }

    private func endDialog(suppressingFurther: Bool) {
        if suppressingFurther { dialogsSuppressed = true }
    }
}

extension HivraBrowserModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        workspaceNavigationRequest = UUID()
        failure = nil
        surfaceSnapshot = nil
        updateState()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        retryURL = nil
        // Dialog suppression, download allowances and answers last for one document, as in a browser.
        presentedDialogs = 0
        dialogsSuppressed = false
        activation.documentCommitted(input: self.webView.userInputCount)
        pendingDownloadQuestions = [:]
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
        if HivraNavigationErrorPolicy.shouldPresent(error) {
            retryURL = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL ?? lastRequestedURL
        }
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
        failure = .unreachable(error.localizedDescription)
        updateState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.logger.error("Web content process terminated; showing recovery")
        failure = .contentProcessTerminated
        updateState()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let targetsMainFrame = navigationAction.targetFrame?.isMainFrame == true
        let source = navigationAction.sourceFrame
        switch HivraWebContentPolicy.navigation(
            url: url,
            targetsMainFrame: targetsMainFrame,
            sourceIsMainFrame: source.isMainFrame,
            opensNewWindow: navigationAction.targetFrame == nil,
            isLinkActivation: navigationAction.navigationType == .linkActivated,
            shouldPerformDownload: navigationAction.shouldPerformDownload
        ) {
        case .download:
            // A download link: the frame holding it asks.
            decideDownload(requester: origin(of: source), fromMainFrame: source.isMainFrame,
                           fromConnectionOrigin: isConnectionOrigin(source), url: url) { allowed in
                decisionHandler(allowed ? .download : .cancel)
            }
        case .openExternally(let externalURL):
            openApp(externalURL, requestedBy: source)
            decisionHandler(.cancel)
        case .cancel(let reason):
            logRefusal(reason, url: url, frame: targetsMainFrame ? "main frame" : "subframe")
            decisionHandler(.cancel)
        case .allow:
            if targetsMainFrame, let url, ["http", "https"].contains(url.scheme?.lowercased()),
               handleWorkspaceNavigation?(url) == true {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        guard HivraWebContentPolicy.shouldDownload(
            canShowMIMEType: navigationResponse.canShowMIMEType,
            contentDisposition: disposition
        ) else {
            decisionHandler(.allow)
            return
        }
        // WebKit names no frame here. A subframe's download comes from the origin it
        // loads; the main frame's from the page it is showing.
        let responseURL = navigationResponse.response.url
        let fromMainFrame = navigationResponse.isForMainFrame
        let requesterURL = fromMainFrame ? webView.backForwardList.currentItem?.url ?? responseURL : responseURL
        decideDownload(
            requester: HivraWebOriginLabel.make(url: requesterURL) ?? HivraWebOriginLabel.opaque,
            fromMainFrame: fromMainFrame,
            fromConnectionOrigin: responseURL.map { HivraWebContentPolicy.isSameOrigin($0, trustedURL) } ?? false,
            url: responseURL
        ) { allowed in
            decisionHandler(allowed ? .download : .cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        adopt(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        adopt(download)
    }
}

extension HivraBrowserModel: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let url = navigationAction.request.url
        if let url, (navigationAction.request.httpMethod ?? "GET").uppercased() == "GET",
           handleWorkspaceNewWindow?(url) == true {
            return nil
        }
        let source = navigationAction.sourceFrame
        switch HivraWebContentPolicy.newWindow(
            url: url,
            isLinkActivation: navigationAction.navigationType == .linkActivated,
            sourceIsMainFrame: source.isMainFrame,
            sourceOrigin: webOrigin(of: source),
            connectionURL: trustedURL
        ) {
        case .inAppPopup:
            return openPopup(configuration: configuration, windowFeatures: windowFeatures)
        case .openInDefaultBrowser(let externalURL):
            // WebKit's popup blocker has already required a user gesture for this link.
            services.systemURLs.open(externalURL)
            return nil
        case .openExternally(let externalURL):
            openApp(externalURL, requestedBy: source)
            return nil
        case .refuse(let reason):
            logRefusal(reason, url: url, frame: "new window")
            return nil
        }
    }

    func webViewDidClose(_ webView: WKWebView) {
        // WebKit only honours window.close() for script-opened windows: our popups.
        requestClose?()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async {
        guard beginDialog() else { return }
        let response = await services.dialogs.alert(message, from: origin(of: frame),
                                                    offeringSuppression: presentedDialogs > 1, in: webView.window)
        endDialog(suppressingFurther: response.suppressesFurtherDialogs)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async -> Bool {
        guard beginDialog() else { return false }
        let response = await services.dialogs.confirm(message, from: origin(of: frame),
                                                      offeringSuppression: presentedDialogs > 1, in: webView.window)
        endDialog(suppressingFurther: response.suppressesFurtherDialogs)
        return response.value
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo
    ) async -> String? {
        guard beginDialog() else { return nil }
        let response = await services.dialogs.prompt(prompt, defaultText: defaultText, from: origin(of: frame),
                                                     offeringSuppression: presentedDialogs > 1, in: webView.window)
        endDialog(suppressingFurther: response.suppressesFurtherDialogs)
        return response.value
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo
    ) async -> [URL]? {
        await services.dialogs.chooseFiles(allowsMultipleSelection: parameters.allowsMultipleSelection,
                                           allowsDirectories: parameters.allowsDirectories, in: webView.window)
    }
}
