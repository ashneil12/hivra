import AppKit
import Combine
import Foundation
import Testing
import WebKit
import HivraMacCore
@testable import HivraMac

/// Records system hand-offs instead of launching Mail, a browser or a Finder window.
@MainActor
final class RecordingSystemURLs: HivraSystemURLOpening {
    private(set) var opened: [URL] = []

    func open(_ url: URL) -> Bool {
        opened.append(url)
        return true
    }
}

/// Answers JavaScript dialogs and file pickers the way a user would, and records what was asked.
@MainActor
final class ScriptedWebDialogs: HivraWebDialogPresenting {
    struct Presentation: Equatable {
        let kind: String
        let message: String
        let origin: String
        let offeredSuppression: Bool
    }

    var confirmAnswers: [Bool] = []
    var promptAnswer: String?
    var suppressNext = false
    var chosenFiles: [URL]?
    private(set) var presentations: [Presentation] = []
    private(set) var fileRequests: [(multiple: Bool, directories: Bool)] = []

    func alert(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Void> {
        record("alert", message, origin, offeringSuppression)
        return .init(value: (), suppressesFurtherDialogs: takeSuppression())
    }

    func confirm(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Bool> {
        record("confirm", message, origin, offeringSuppression)
        let answer = confirmAnswers.isEmpty ? false : confirmAnswers.removeFirst()
        return .init(value: answer, suppressesFurtherDialogs: takeSuppression())
    }

    func prompt(_ message: String, defaultText: String?, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<String?> {
        record("prompt", message, origin, offeringSuppression)
        return .init(value: promptAnswer, suppressesFurtherDialogs: takeSuppression())
    }

    func chooseFiles(allowsMultipleSelection: Bool, allowsDirectories: Bool, in window: NSWindow?) async -> [URL]? {
        fileRequests.append((allowsMultipleSelection, allowsDirectories))
        return chosenFiles
    }

    private func record(_ kind: String, _ message: String, _ origin: String, _ offered: Bool) {
        presentations.append(.init(kind: kind, message: message, origin: origin, offeredSuppression: offered))
    }

    private func takeSuppression() -> Bool {
        defer { suppressNext = false }
        return suppressNext
    }
}

@MainActor
final class BrowserFixture {
    static let profile = HivraConnectionProfile(name: "Web QA", url: URL(string: "http://127.0.0.1:1/dashboard")!, kind: .custom)

    let systemURLs = RecordingSystemURLs()
    let dialogs = ScriptedWebDialogs()
    let folder: URL
    let services: HivraBrowserServices

    init() throws {
        _ = NSApplication.shared
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hivra-web-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        self.folder = folder
        let downloads = folder.appendingPathComponent("Downloads", isDirectory: true)
        services = HivraBrowserServices(systemURLs: systemURLs, dialogs: dialogs,
                                        downloads: HivraDownloadManager(directory: { downloads }))
    }

    var downloads: URL { folder.appendingPathComponent("Downloads", isDirectory: true) }

    func connectionBrowser() -> HivraBrowserModel {
        HivraBrowserModel(initialURL: Self.profile.url, role: .connection(Self.profile), services: services)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Replaces the page with a local document at `origin`. No server or network is used.
    func show(_ body: String, in browser: HivraBrowserModel, at origin: URL = profile.url) async throws {
        let marker = UUID().uuidString
        browser.webView.stopLoading()
        browser.webView.loadHTMLString("<!doctype html><html><head><title>Fixture</title></head><body data-fixture=\"\(marker)\">\(body)</body></html>", baseURL: origin)
        try await eventually("fixture page ready") {
            (try? await browser.webView.evaluateJavaScript("document.body?.dataset.fixture")) as? String == marker
                && browser.webView.url == origin
        }
    }

    func eventually(_ label: String, _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(try await condition(), Comment(rawValue: label))
    }
}

@Suite("Web content in the Mac shell", .serialized)
@MainActor
struct HivraBrowserWebContentTests {
    @Test("window.open('about:blank') opens a real popup with its opener, never the system")
    func blankPopupKeepsOpener() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        try await fixture.show("<p>workspace</p>", in: browser)

        let opened = try await browser.webView.evaluateJavaScript("""
            window.addEventListener('message', event => { window.received = event.data });
            window.popup = window.open('about:blank', '_blank', 'width=520,height=640');
            window.popup !== null
            """) as? Bool
        #expect(opened == true)
        let popup = try #require(browser.popupWindows.first)
        #expect(browser.popupWindows.count == 1)
        let window = try #require(popup.window)
        #expect(window.isVisible)
        #expect(!window.isRestorable)
        #expect(window.contentRect(forFrameRect: window.frame).size == CGSize(width: 520, height: 640))
        #expect(!popup.browser.isPrivileged)

        // The popup can answer the page that opened it, as an OAuth callback does.
        _ = try await popup.browser.webView.evaluateJavaScript("window.opener.postMessage('signed-in', '*'); true")
        try await fixture.eventually("opener received the popup's message") {
            try await browser.webView.evaluateJavaScript("window.received ?? ''") as? String == "signed-in"
        }

        // window.close() from the popup closes its native window, and the opener sees it closed.
        _ = try await popup.browser.webView.evaluateJavaScript("setTimeout(() => window.close(), 0); true")
        try await fixture.eventually("popup window closed") { browser.popupWindows.isEmpty && !window.isVisible }
        try await fixture.eventually("opener observes popup.closed") {
            try await browser.webView.evaluateJavaScript("window.popup.closed") as? Bool == true
        }
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("an empty named window for a connector keeps its handle and requested size")
    func emptyNamedPopup() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        try await fixture.show("<p>connectors</p>", in: browser)

        let opened = try await browser.webView.evaluateJavaScript(
            "window.connector = window.open('', 'composio_connect', 'width=560,height=720'); window.connector !== null"
        ) as? Bool
        #expect(opened == true)
        let window = try #require(browser.popupWindows.first?.window)
        #expect(window.contentRect(forFrameRect: window.frame).size == CGSize(width: 560, height: 720))
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("script without a user gesture cannot open windows")
    func popupBlockerStaysOn() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        try await fixture.show("<script>window.unrequested = window.open('about:blank');</script>", in: browser)

        #expect(try await browser.webView.evaluateJavaScript("window.unrequested === null") as? Bool == true)
        #expect(browser.popupWindows.isEmpty)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("popups carry no native bridges while the connection page that opened them does")
    func popupsAreUnprivileged() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        try await fixture.show("<p>workspace</p>", in: browser)

        // Positive control: the connection page reaches its bridge, which refuses a malformed request.
        #expect(try await browser.webView.evaluateJavaScript("typeof window.__HIVRA_NATIVE_WORKSPACE__") as? String == "object")
        let control = try await browser.webView.callAsyncJavaScript("""
            try { await window.webkit.messageHandlers.hivraNativeDesktop.postMessage({type: 'probe'}); return 'accepted' }
            catch (error) { return String(error.message ?? error) }
            """, contentWorld: .page) as? String
        #expect(control == "native_profile_request_denied")

        _ = try await browser.webView.evaluateJavaScript("window.popup = window.open('about:blank'); true")
        let popup = try #require(browser.popupWindows.first?.browser)
        #expect(!popup.isPrivileged)
        // about:blank inherits the opener's trusted origin, which is exactly why it must not inherit the bridge.
        #expect(try await popup.webView.evaluateJavaScript("window.origin") as? String == "http://127.0.0.1:1")
        let bridges = try await popup.webView.evaluateJavaScript("""
            [typeof window.webkit?.messageHandlers?.hivraNativeDesktop,
             typeof window.webkit?.messageHandlers?.hivraWorkspace,
             typeof window.__HIVRA_NATIVE_WORKSPACE__].join(',')
            """) as? String
        #expect(bridges == "undefined,undefined,undefined")
    }

    @Test("foreign-origin and detached pages cannot reach Moonlight profile preparation or launch")
    func nativeDesktopIsBoundToTheConnection() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        // Launch names a session that was never prepared, so even a broken origin gate
        // could not start Moonlight on the machine running these tests.
        let attempts = """
            const requests = [
              {type: 'hivra.native-desktop.prepare-profile.v1', sessionId: '\(UUID().uuidString.lowercased())', streamingMode: 'hq'},
              {type: 'hivra.native-desktop.launch.v1', sessionId: '\(UUID().uuidString.lowercased())',
               serverId: '\(UUID().uuidString.lowercased())',
               serverCertificatePem: '-----BEGIN CERTIFICATE-----\\n' + 'a'.repeat(96) + '\\n-----END CERTIFICATE-----\\n',
               serverCertificateSha256: 'b'.repeat(64), guestBootId: '\(UUID().uuidString.lowercased())',
               connectionIpv4: '10.252.12.213', transport: 'direct'},
            ];
            const results = [];
            for (const request of requests) {
              try { await window.webkit.messageHandlers.hivraNativeDesktop.postMessage(request); results.push('accepted') }
              catch (error) { results.push(error instanceof TypeError ? 'unavailable' : String(error.message ?? error)) }
            }
            return results.join(',');
            """
        let foreign = URL(string: "https://foreign.invalid/agent-link")!

        // URL-based surface windows are ordinary web content, on any origin.
        for origin in [foreign, BrowserFixture.profile.url] {
            let detached = HivraBrowserModel(initialURL: origin, role: .unprivileged, services: fixture.services)
            try await fixture.show("<p>detached</p>", in: detached, at: origin)
            #expect(!detached.isPrivileged)
            let result = try await detached.webView.callAsyncJavaScript(attempts, contentWorld: .page) as? String
            #expect(result == "unavailable,unavailable", Comment(rawValue: origin.absoluteString))
        }

        // A connection view whose main frame left the profile origin keeps the bridge but is refused.
        let connection = fixture.connectionBrowser()
        try await fixture.show("<p>guest transport</p>", in: connection, at: foreign)
        let refused = try await connection.webView.callAsyncJavaScript(attempts, contentWorld: .page) as? String
        #expect(refused == "native_profile_request_denied,native_profile_request_denied")
    }

    @Test("about:, srcdoc and data frames, custom-scheme frames and blob downloads never reach the system")
    func webContentSchemesStayInApp() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        try await fixture.show("""
            <iframe src="about:blank"></iframe>
            <iframe srcdoc="<p>inline</p>"></iframe>
            <iframe src="data:text/html,<p>data</p>"></iframe>
            <iframe src="vnc://10.0.0.1"></iframe>
            <iframe id="mailframe" srcdoc="<a id='mail' href='mailto:frame@example.com'>mail</a>"></iframe>
            """, in: browser)
        try await fixture.eventually("subframes loaded") {
            try await browser.webView.evaluateJavaScript(
                "document.getElementById('mailframe').contentDocument?.getElementById('mail') != null"
            ) as? Bool == true
        }

        // A mail link inside a frame and a scripted mailto: are not the user's main-frame link.
        _ = try await browser.webView.evaluateJavaScript(
            "document.getElementById('mailframe').contentDocument.getElementById('mail').click(); true")
        _ = try await browser.webView.evaluateJavaScript("location.href = 'mailto:script@example.com'; true")

        // The same file twice: the second download must not replace the first.
        let download = """
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([body], {type: 'text/plain'}));
            link.download = 'report.txt';
            document.body.append(link);
            link.click();
            return true;
            """
        let first = fixture.downloads.appendingPathComponent("report.txt")
        let second = fixture.downloads.appendingPathComponent("report (1).txt")
        _ = try await browser.webView.callAsyncJavaScript(download, arguments: ["body": "first"], contentWorld: .page)
        try await fixture.eventually("first download saved") { (try? String(contentsOf: first, encoding: .utf8)) == "first" }
        #expect(browser.downloadNotice?.outcome == .finished(first))
        _ = try await browser.webView.callAsyncJavaScript(download, arguments: ["body": "second"], contentWorld: .page)
        try await fixture.eventually("second download saved beside the first") {
            (try? String(contentsOf: second, encoding: .utf8)) == "second"
        }
        #expect((try? String(contentsOf: first, encoding: .utf8)) == "first")
        #expect(browser.downloadNotice?.outcome == .finished(second))
        // Downloads keep Gatekeeper's quarantine like any browser download.
        #expect(getxattr(first.path, "com.apple.quarantine", nil, 0, 0, 0) > 0)

        #expect(fixture.systemURLs.opened.isEmpty)
        #expect(browser.popupWindows.isEmpty)
    }

    @Test("a user's mail link opens Mail and a cross-origin link opens the default browser")
    func userLinksLeaveTheApp() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        try await fixture.show("""
            <a id="mail" href="mailto:ops@example.com">Email ops</a>
            <a id="docs" href="https://docs.example.com/guide" target="_blank" rel="noopener">Guide</a>
            """, in: browser)

        _ = try await browser.webView.evaluateJavaScript("document.getElementById('mail').click(); true")
        _ = try await browser.webView.evaluateJavaScript("document.getElementById('docs').click(); true")
        try await fixture.eventually("both links handed to the system") { fixture.systemURLs.opened.count == 2 }
        #expect(fixture.systemURLs.opened == [URL(string: "mailto:ops@example.com")!, URL(string: "https://docs.example.com/guide")!])
        #expect(browser.popupWindows.isEmpty)
    }

    @Test("JavaScript dialogs return what the user decides and name the requesting origin")
    func javaScriptDialogs() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        try await fixture.show("<p>agent settings</p>", in: browser)

        fixture.dialogs.confirmAnswers = [true, false]
        #expect(try await browser.webView.evaluateJavaScript("confirm('Delete this agent?')") as? Bool == true)
        #expect(try await browser.webView.evaluateJavaScript("confirm('Delete this agent?')") as? Bool == false)
        fixture.dialogs.promptAnswer = "renamed"
        #expect(try await browser.webView.evaluateJavaScript("prompt('New name', 'agent')") as? String == "renamed")
        #expect(try await browser.webView.evaluateJavaScript("alert('Saved'); 'shown'") as? String == "shown")
        #expect(fixture.dialogs.presentations == [
            .init(kind: "confirm", message: "Delete this agent?", origin: "http://127.0.0.1:1", offeredSuppression: false),
            .init(kind: "confirm", message: "Delete this agent?", origin: "http://127.0.0.1:1", offeredSuppression: true),
            .init(kind: "prompt", message: "New name", origin: "http://127.0.0.1:1", offeredSuppression: true),
            .init(kind: "alert", message: "Saved", origin: "http://127.0.0.1:1", offeredSuppression: true),
        ])

        // Once the user blocks further dialogs, the page's dialogs resolve as cancelled until it navigates.
        fixture.dialogs.confirmAnswers = [true, true]
        fixture.dialogs.suppressNext = true
        #expect(try await browser.webView.evaluateJavaScript("confirm('Again?')") as? Bool == true)
        #expect(try await browser.webView.evaluateJavaScript("confirm('And again?')") as? Bool == false)
        #expect(try await browser.webView.evaluateJavaScript("alert('Loop'); 'skipped'") as? String == "skipped")
        #expect(fixture.dialogs.presentations.count == 5)
        try await fixture.show("<p>next page</p>", in: browser)
        #expect(try await browser.webView.evaluateJavaScript("confirm('New page?')") as? Bool == true)
        #expect(fixture.dialogs.presentations.last == .init(kind: "confirm", message: "New page?", origin: "http://127.0.0.1:1",
                                                            offeredSuppression: false))
    }

    @Test("file inputs open a native picker honouring multiple and directory selection")
    func fileUploads() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let key = fixture.folder.appendingPathComponent("deploy-key.pub")
        try Data("ssh-ed25519 AAAA test".utf8).write(to: key)
        let browser = fixture.connectionBrowser()
        try await fixture.show("""
            <input id="attachments" type="file" multiple>
            <input id="folder" type="file" webkitdirectory>
            """, in: browser)

        fixture.dialogs.chosenFiles = [key]
        _ = try await browser.webView.evaluateJavaScript("document.getElementById('attachments').click(); true")
        try await fixture.eventually("the chosen file reaches the page") {
            try await browser.webView.evaluateJavaScript(
                "Array.from(document.getElementById('attachments').files).map(file => file.name).join(',')"
            ) as? String == "deploy-key.pub"
        }
        fixture.dialogs.chosenFiles = nil
        _ = try await browser.webView.evaluateJavaScript("document.getElementById('folder').click(); true")
        try await fixture.eventually("the folder picker was requested") { fixture.dialogs.fileRequests.count == 2 }
        #expect(fixture.dialogs.fileRequests.map(\.multiple) == [true, false])
        #expect(fixture.dialogs.fileRequests.map(\.directories) == [false, true])
    }

    @Test("a terminated web content process shows recovery, and Reload recovers it")
    func contentProcessRecovery() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        try await fixture.show("<p>terminal</p>", in: browser)
        var loadingStates: [Bool] = []
        let observation = browser.$isLoading.sink { loadingStates.append($0) }
        defer { observation.cancel() }

        (browser as WKNavigationDelegate).webViewWebContentProcessDidTerminate?(browser.webView)
        #expect(browser.failure == .contentProcessTerminated)

        loadingStates.removeAll()
        browser.reload()
        #expect(browser.failure == nil)
        try await fixture.eventually("reload started a new load") { loadingStates.contains(true) }
    }

    @Test("Try again after a failed first load retries the same address")
    func retryAfterFailedFirstLoad() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        // A port nothing listens on refuses the connection, so no page ever commits.
        let address = try #require(URL(string: "http://127.0.0.1:\(try unusedLocalPort())/dashboard"))
        let browser = HivraBrowserModel(initialURL: address, role: .unprivileged, services: fixture.services)
        try await fixture.eventually("first load failed") {
            if case .unreachable? = browser.failure { return true }
            return false
        }
        #expect(browser.webView.backForwardList.currentItem == nil)
        var attempts = 0
        let observation = browser.$isLoading.removeDuplicates().sink { if $0 { attempts += 1 } }
        defer { observation.cancel() }

        browser.reload()
        #expect(browser.failure == nil)
        try await fixture.eventually("the same address was requested again and failed again") {
            if case .unreachable? = browser.failure { return attempts >= 1 }
            return false
        }
    }

    @Test("popups close with the tab or workspace that opened them, nested popups included")
    func popupsCloseWithTheirOwner() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let session = try await makeSession(fixture)
        defer { session.clearOwnedViews() }
        let resource = try #require(session.resources.first)
        session.open(resource)
        let tab = try #require(session.activeTab)
        try await fixture.show("<p>agent</p>", in: tab.browser,
                               at: try #require(HivraWorkspaceRoute.url(for: resource.href, profile: session.profile)))

        _ = try await tab.browser.webView.evaluateJavaScript("window.open('about:blank'); true")
        let popup = try #require(tab.browser.popupWindows.first)
        _ = try await popup.browser.webView.evaluateJavaScript("window.open('about:blank'); true")
        let nested = try #require(popup.browser.popupWindows.first)
        let popupWindow = try #require(popup.window)
        let nestedWindow = try #require(nested.window)
        #expect(popupWindow.isVisible && nestedWindow.isVisible)

        session.close(tab)
        #expect(!popupWindow.isVisible)
        #expect(!nestedWindow.isVisible)
        #expect(tab.browser.popupWindows.isEmpty)

        try await fixture.show("<p>home</p>", in: session.connectionBrowser)
        _ = try await session.connectionBrowser.webView.evaluateJavaScript("window.open('about:blank'); true")
        let connectionPopup = try #require(session.connectionBrowser.popupWindows.first?.window)
        session.clearOwnedViews()
        #expect(!connectionPopup.isVisible)
        #expect(session.connectionBrowser.popupWindows.isEmpty)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("a dashboard route opened in a new window joins the workspace instead of a popup")
    func dashboardRoutesJoinTheWorkspace() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let session = try await makeSession(fixture)
        defer { session.clearOwnedViews() }
        try await fixture.show("<p>home</p>", in: session.connectionBrowser)

        let handle = try await session.connectionBrowser.webView.evaluateJavaScript(
            "window.open('/dashboard/agent/computer?tab=terminal', '_blank') === null"
        ) as? Bool
        #expect(handle == true)
        #expect(session.activeTab?.resourceUID == "x-computer")
        #expect(session.connectionBrowser.popupWindows.isEmpty)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    #if DEBUG
    @Test("debug builds allow Web Inspector")
    func debugBuildsAreInspectable() throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        #expect(fixture.connectionBrowser().webView.isInspectable)
    }
    #endif

    /// A loopback port that was free a moment ago; connecting to it is refused.
    private func unusedLocalPort() throws -> UInt16 {
        let socketDescriptor = socket(AF_INET, SOCK_STREAM, 0)
        try #require(socketDescriptor >= 0)
        defer { close(socketDescriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                bind(socketDescriptor, generic, length) == 0 && getsockname(socketDescriptor, generic, &length) == 0
            }
        }
        try #require(bound)
        return UInt16(bigEndian: address.sin_port)
    }

    private func makeSession(_ fixture: BrowserFixture) async throws -> HivraWorkspaceSession {
        let session = HivraWorkspaceSession(profile: BrowserFixture.profile, services: fixture.services)
        session.connectionBrowser.webView.stopLoading()
        // Supply the display projection after the separately tested origin-validation boundary.
        let resources = ["agent", "computer"].map { kind in
            HivraWorkspaceResource(uid: "x-\(kind)", id: kind, source: .hivra,
                                   kind: kind == "agent" ? .agent : .computer, name: kind, description: "",
                                   status: "running", href: "/dashboard/agent/\(kind)")
        }
        session.connectionBrowser.receiveWorkspaceMessage(.workspace(.init(
            ownerKey: "web-qa", resources: resources, loading: false, errors: [:])))
        try await fixture.eventually("inventory adopted") { session.resources.count == 2 }
        return session
    }
}
