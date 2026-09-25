import AppKit
import Foundation
import Testing
import WebKit
import HivraMacCore
@testable import HivraMac

/// What a page may start without the user: downloads and hand-offs to other Mac apps,
/// driven through real WebKit pages, script clicks and the user's own mouse events.
@Suite("Page activation in the Mac shell", .serialized)
@MainActor
struct HivraBrowserActivationTests {
    /// Saves a blob with a download link, as the dashboard's own exports do.
    private let saveBlob = """
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([body], {type: 'text/plain'}));
        link.download = name;
        document.body.append(link);
        link.click();
        return true;
        """

    private func save(_ name: String, in browser: HivraBrowserModel) async throws {
        _ = try await browser.webView.callAsyncJavaScript(saveBlob, arguments: ["body": name, "name": name], contentWorld: .page)
    }

    @Test("cross-origin frames cannot save files without the user's input, and are never asked about")
    func crossOriginFramesCannotDownloadOnTheirOwn() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let server = try await HivraLocalHTTPServer { path in
            path.hasPrefix("/note")
                ? .init(contentType: "text/plain", headers: ["Content-Disposition": "attachment; filename=\"note.txt\""],
                        body: Data("note".utf8))
                : .init(contentType: "application/octet-stream", body: Data("drop".utf8))
        }
        defer { server.stop() }
        let browser = fixture.connectionBrowser()
        let frames = (0..<3).map { "<iframe src='\(server.origin.absoluteString)/drop.bin?\($0)'></iframe>" }.joined()
            + "<iframe src='\(server.origin.absoluteString)/note'></iframe>"
        try await fixture.show(frames, in: browser)
        try await fixture.eventually("every frame fetched its file") { server.requests.count == 4 }

        // Positive control: the page's own first download still saves once the frames have answered.
        try await save("own.txt", in: browser)
        try await fixture.eventually("the page's own download saved") { fixture.downloadedFiles().contains("own.txt") }
        try await Task.sleep(for: .milliseconds(500))
        #expect(fixture.downloadedFiles() == ["own.txt"])
        #expect(fixture.dialogs.presentations.isEmpty)
    }

    @Test("the user's click inside a cross-origin frame saves its file")
    func userClickInCrossOriginFrameDownloads() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let server = try await HivraLocalHTTPServer { path in
            path.hasPrefix("/frame")
                ? .init(contentType: "text/html", body: Data("""
                    <a id="get" href="/report.bin" style="display:block;width:100vw;height:100vh">Get report</a>
                    """.utf8))
                : .init(contentType: "application/octet-stream",
                        headers: ["Content-Disposition": "attachment; filename=\"report.bin\""], body: Data("report".utf8))
        }
        defer { server.stop() }
        let browser = fixture.connectionBrowser()
        fixture.host(browser)
        // An agent's web UI embedded in its resource page.
        try await fixture.show("""
            <iframe id="agent" src="\(server.origin.absoluteString)/frame" onload="window.agentLoaded = true"
                    style="width:400px;height:200px;border:0"></iframe>
            """, in: browser)
        try await fixture.eventually("agent frame loaded") {
            try await browser.webView.evaluateJavaScript("window.agentLoaded === true") as? Bool == true
        }

        try await fixture.click("#agent", in: browser)
        try await fixture.eventually("the frame's file saved") { fixture.downloadedFiles() == ["report.bin"] }
        #expect(fixture.dialogs.presentations.isEmpty)
    }

    @Test("a page saves one file on its own, then asks once before saving more")
    func repeatedDownloadsAsk() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        fixture.host(browser)
        try await fixture.show("""
            <button id="save" style="display:block;width:200px;height:40px">Save</button>
            <script>
              document.getElementById('save').addEventListener('click', () => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob(['clicked'], {type: 'text/plain'}));
                link.download = 'clicked.txt';
                document.body.append(link);
                link.click();
              });
            </script>
            """, in: browser)

        // No input: the first file saves, as in a browser.
        try await save("one.txt", in: browser)
        try await fixture.eventually("first file saved") { fixture.downloadedFiles() == ["one.txt"] }

        // More files without input: one question for the page, however many requests wait on it.
        fixture.dialogs.holdsQuestions = true
        try await save("two.txt", in: browser)
        try await save("three.txt", in: browser)
        try await fixture.eventually("the page was asked") { fixture.dialogs.questions("more-downloads").count == 1 }
        try await Task.sleep(for: .milliseconds(300))
        #expect(fixture.dialogs.questions("more-downloads")
            == [.init(kind: "more-downloads", message: "", origin: "http://127.0.0.1:1", offeredSuppression: false)])
        fixture.dialogs.holdsQuestions = false
        try await Task.sleep(for: .milliseconds(500))
        #expect(fixture.downloadedFiles() == ["one.txt"])

        // The answer stands for this page: no second question, nothing saved.
        try await save("four.txt", in: browser)
        try await Task.sleep(for: .milliseconds(500))
        #expect(fixture.downloadedFiles() == ["one.txt"])
        #expect(fixture.dialogs.questions("more-downloads").count == 1)

        // The user's own click is a new allowance.
        try await fixture.click("#save", in: browser)
        try await fixture.eventually("the clicked file saved") { fixture.downloadedFiles() == ["clicked.txt", "one.txt"] }

        // A new page starts afresh, and a page the user allows keeps saving.
        try await fixture.show("<p>next page</p>", in: browser)
        fixture.dialogs.moreDownloadsAnswers = [true]
        for name in ["five.txt", "six.txt", "seven.txt"] {
            try await save(name, in: browser)
            try await fixture.eventually("\(name) saved") { fixture.downloadedFiles().contains(name) }
        }
        #expect(fixture.dialogs.questions("more-downloads").count == 2)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("a script's clicks on a mail link never open Mail without asking")
    func scriptedMailClicksAsk() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        fixture.dialogs.holdsQuestions = true
        // No user input at all: the page clicks its own mail link three times.
        try await fixture.show("""
            <a id="m" href="mailto:spam@example.com">mail</a>
            <script>setTimeout(() => { for (let i = 0; i < 3; i++) document.getElementById('m').click() }, 50)</script>
            """, in: browser)

        try await fixture.eventually("the user was asked") { fixture.dialogs.questions("open-app").count == 1 }
        try await Task.sleep(for: .milliseconds(300))
        // One question while it shows; the other clicks are refused, not stacked.
        #expect(fixture.dialogs.questions("open-app")
            == [.init(kind: "open-app", message: "mailto:spam@example.com", origin: "http://127.0.0.1:1", offeredSuppression: true)])
        fixture.dialogs.holdsQuestions = false
        try await Task.sleep(for: .milliseconds(300))
        #expect(fixture.systemURLs.opened.isEmpty)

        // Cancelled with "Don't allow this page to open apps": later clicks are refused without asking.
        fixture.dialogs.appOpenAnswers = [.init(value: false, suppressesFurtherDialogs: true)]
        _ = try await browser.webView.evaluateJavaScript("document.getElementById('m').click(); true")
        try await fixture.eventually("asked again") { fixture.dialogs.questions("open-app").count == 2 }
        try await Task.sleep(for: .milliseconds(200))
        _ = try await browser.webView.evaluateJavaScript("for (let i = 0; i < 3; i++) document.getElementById('m').click(); true")
        try await Task.sleep(for: .milliseconds(500))
        #expect(fixture.dialogs.questions("open-app").count == 2)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("a mail link in a frame cannot open Mail, even aimed at the top window")
    func frameMailLinksStayInApp() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        fixture.host(browser)
        try await fixture.show("""
            <iframe id="frame" style="width:400px;height:200px;border:0" srcdoc="
              <a id='top' target='_top' href='mailto:top@example.com' style='display:block;width:100vw;height:100vh'>mail</a>
            "></iframe>
            """, in: browser)
        try await fixture.eventually("frame link ready") {
            try await browser.webView.evaluateJavaScript(
                "document.getElementById('frame').contentDocument?.getElementById('top') != null") as? Bool == true
        }

        try await fixture.click("#frame", in: browser)
        _ = try await browser.webView.evaluateJavaScript(
            "document.getElementById('frame').contentDocument.getElementById('top').click(); true")
        try await Task.sleep(for: .milliseconds(500))
        #expect(fixture.systemURLs.opened.isEmpty)
        #expect(fixture.dialogs.presentations.isEmpty)
    }

    @Test("another site's mail link asks first, naming the site, even after the user's click")
    func foreignMailLinksAsk() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let browser = fixture.connectionBrowser()
        fixture.host(browser)
        try await fixture.show("<a id=\"m\" href=\"mailto:help@foreign.invalid\" style=\"display:block;height:40px\">mail</a>",
                               in: browser, at: URL(string: "https://foreign.invalid/help")!)

        fixture.dialogs.appOpenAnswers = [.init(value: true)]
        try await fixture.click("#m", in: browser)
        try await fixture.eventually("Mail opened after the user agreed") { fixture.systemURLs.opened.count == 1 }
        #expect(fixture.dialogs.questions("open-app")
            == [.init(kind: "open-app", message: "mailto:help@foreign.invalid", origin: "foreign.invalid", offeredSuppression: true)])
        #expect(fixture.systemURLs.opened == [URL(string: "mailto:help@foreign.invalid")!])
    }

    @Test("a link from an agent's web UI to its own origin opens in the app, where its session is")
    func sameOriginLinksKeepTheirSession() async throws {
        let fixture = try BrowserFixture()
        defer { fixture.cleanUp() }
        let server = try await HivraLocalHTTPServer { _ in .init(contentType: "text/html", body: Data("<p>artifact</p>".utf8)) }
        defer { server.stop() }
        let browser = fixture.connectionBrowser()
        defer { browser.closeOwnedPopups() }
        fixture.host(browser)
        try await fixture.show("""
            <a id="file" href="\(server.origin.absoluteString)/artifact" target="_blank" style="display:block;height:40px">artifact</a>
            """, in: browser, at: server.origin.appendingPathComponent("webchat"))

        try await fixture.click("#file", in: browser)
        try await fixture.eventually("the artifact opened in an in-app popup") { server.requests.contains("/artifact") }
        #expect(browser.popupWindows.count == 1)
        #expect(fixture.systemURLs.opened.isEmpty)
    }

    @Test("only the user's own presses count as input")
    func inputCounting() throws {
        _ = NSApplication.shared
        let webView = HivraInputCountingWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 100),
                                                configuration: HivraBrowserConfiguration.make())
        func key(_ characters: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) throws -> NSEvent {
            try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
                                          characters: characters, charactersIgnoringModifiers: characters,
                                          isARepeat: false, keyCode: code))
        }
        func mouse(_ type: NSEvent.EventType) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(with: type, location: NSPoint(x: 10, y: 10), modifierFlags: [],
                                            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
                                            eventNumber: 0, clickCount: 1, pressure: 1))
        }
        #expect(webView.userInputCount == 0)
        webView.keyDown(with: try key("\u{1b}", code: 53))
        webView.keyDown(with: try key("r", code: 15, modifiers: .command))
        #expect(webView.userInputCount == 0)
        webView.keyDown(with: try key("a", code: 0))
        webView.mouseDown(with: try mouse(.leftMouseDown))
        webView.otherMouseDown(with: try mouse(.otherMouseDown))
        #expect(webView.userInputCount == 3)
    }
}
