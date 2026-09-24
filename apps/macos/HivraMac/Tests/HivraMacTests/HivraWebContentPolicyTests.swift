import CoreGraphics
import Foundation
import Testing

@testable import HivraMacCore

@Suite("Web content policy")
struct HivraWebContentPolicyTests {
    private let connection = URL(string: "https://canary.hermesos.cloud/dashboard")!

    private func navigation(
        _ value: String,
        mainFrame: Bool = true,
        newWindow: Bool = false,
        link: Bool = false,
        download: Bool = false
    ) -> HivraWebNavigationDecision {
        HivraWebContentPolicy.navigation(url: URL(string: value), targetsMainFrame: mainFrame, opensNewWindow: newWindow,
                                         isLinkActivation: link, shouldPerformDownload: download)
    }

    private func newWindow(_ value: String?, link: Bool = false, mainFrame: Bool = true) -> HivraNewWindowDecision {
        HivraWebContentPolicy.newWindow(url: value.flatMap(URL.init(string:)), isLinkActivation: link,
                                        sourceIsMainFrame: mainFrame, connectionURL: connection)
    }

    @Test("web-content schemes stay inside WebKit from every frame")
    func webContentSchemesStayInWebKit() {
        for value in ["about:blank", "about:srcdoc", "blob:https://canary.hermesos.cloud/1", "data:text/html,hi",
                      "javascript:void(0)", "https://example.com/", "http://127.0.0.1:3000/dashboard"] {
            #expect(navigation(value, mainFrame: true) == .allow, Comment(rawValue: value))
            #expect(navigation(value, mainFrame: false) == .allow, Comment(rawValue: value))
        }
    }

    @Test("mail and phone links leave the app only from a main-frame link")
    func externalSchemesNeedMainFrameLink() {
        let mail = URL(string: "mailto:ops@example.com")!
        #expect(navigation(mail.absoluteString, link: true) == .openExternally(mail))
        #expect(navigation("tel:+15550100", link: true) == .openExternally(URL(string: "tel:+15550100")!))
        #expect(navigation(mail.absoluteString, mainFrame: false, link: true) != .openExternally(mail))
        // Script-driven location changes are not a user's link.
        #expect(navigation(mail.absoluteString, link: false) != .openExternally(mail))
    }

    @Test("other schemes are refused, never launched")
    func unknownSchemesAreRefused() {
        for value in ["smb://nas/share", "vnc://10.0.0.1", "file:///etc/hosts", "x-apple-helpviewer://x", "ssh://host"] {
            guard case .cancel = navigation(value, link: true) else {
                Issue.record("\(value) was not refused")
                continue
            }
        }
    }

    @Test("downloads win over every other rule, and new windows defer to the window request")
    func downloadsAndNewWindows() {
        #expect(navigation("blob:https://canary.hermesos.cloud/1", mainFrame: false, download: true) == .download)
        #expect(navigation("data:application/octet-stream;base64,aGk=", download: true) == .download)
        #expect(navigation("mailto:ops@example.com", newWindow: true, link: true) == .allow)
        #expect(navigation("smb://nas/share", newWindow: true) == .allow)
    }

    @Test("attachments and undisplayable responses download")
    func responseDownloads() {
        #expect(HivraWebContentPolicy.shouldDownload(canShowMIMEType: false, contentDisposition: nil))
        #expect(HivraWebContentPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: "attachment; filename=\"a.txt\""))
        #expect(HivraWebContentPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: " Attachment"))
        #expect(!HivraWebContentPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: "inline; filename=a.pdf"))
        #expect(!HivraWebContentPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: nil))
    }

    @Test("empty, blank and same-origin windows are in-app popups with an opener")
    func inAppPopups() {
        #expect(newWindow(nil) == .inAppPopup)
        #expect(newWindow("") == .inAppPopup)
        #expect(newWindow("about:blank") == .inAppPopup)
        #expect(newWindow("https://canary.hermesos.cloud/api/instances/1/browser-stream", link: true) == .inAppPopup)
        #expect(newWindow("blob:https://canary.hermesos.cloud/9") == .inAppPopup)
        #expect(newWindow("about:srcdoc") != .inAppPopup)
    }

    @Test("a user's cross-origin link opens in the default browser; scripted windows keep their opener")
    func crossOriginLinks() {
        let docs = URL(string: "https://docs.example.com/guide")!
        #expect(newWindow(docs.absoluteString, link: true) == .openInDefaultBrowser(docs))
        #expect(newWindow(docs.absoluteString, link: true, mainFrame: false) == .openInDefaultBrowser(docs))
        // window.open(url) and form posts with target=_blank (guest bootstrap) stay in-app.
        #expect(newWindow(docs.absoluteString, link: false) == .inAppPopup)
        // Another Hivra origin is still another origin.
        let cloud = URL(string: "https://hivra.cloud/dashboard/infrastructure")!
        #expect(newWindow(cloud.absoluteString, link: true) == .openInDefaultBrowser(cloud))
    }

    @Test("sign-in providers stay in-app so they can return to their opener")
    func authProviders() {
        for value in ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
                      "https://splendid-longhorn-99.clerk.accounts.dev/v1/oauth_callback",
                      "https://clerk.hermesos.cloud/v1/client", "https://accounts.hermesos.cloud/sign-in",
                      "https://clerk.canary.hermesos.cloud/v1/client", "https://appleid.apple.com/auth/authorize",
                      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                      "https://github.com/login/oauth/authorize?client_id=x"] {
            #expect(newWindow(value, link: true) == .inAppPopup, Comment(rawValue: value))
        }
        for value in ["https://github.com/ashneil12/hivra", "http://accounts.google.com/", "https://clerk.cloud/",
                      "https://accounts.google.com.evil.example/"] {
            #expect(!HivraWebContentPolicy.isAuthProvider(URL(string: value)!, connectionURL: connection), Comment(rawValue: value))
        }
    }

    @Test("mail links from a new-window request need a main-frame link; other schemes are refused")
    func newWindowSchemes() {
        let mail = URL(string: "mailto:ops@example.com")!
        #expect(newWindow(mail.absoluteString, link: true) == .openExternally(mail))
        #expect(newWindow(mail.absoluteString, link: true, mainFrame: false) != .openExternally(mail))
        #expect(newWindow(mail.absoluteString, link: false) != .openExternally(mail))
        for value in ["javascript:alert(1)", "data:text/html,hi", "smb://nas/share", "file:///etc/hosts"] {
            guard case .refuse = newWindow(value, link: true) else {
                Issue.record("\(value) was not refused")
                continue
            }
        }
    }
}

@Suite("Download names")
struct HivraDownloadNamingTests {
    private let folder = URL(fileURLWithPath: "/tmp/hivra-downloads", isDirectory: true)

    @Test("suggested names become one visible path component")
    func sanitizes() {
        #expect(HivraDownloadNaming.sanitizedFilename("report.pdf") == "report.pdf")
        #expect(HivraDownloadNaming.sanitizedFilename("../../etc/passwd") == "_.._etc_passwd")
        #expect(HivraDownloadNaming.sanitizedFilename(".env") == "env")
        #expect(HivraDownloadNaming.sanitizedFilename("a:b\u{0007}.txt") == "a_b.txt")
        #expect(HivraDownloadNaming.sanitizedFilename(" .. ") == HivraDownloadNaming.fallbackName)
        #expect(HivraDownloadNaming.sanitizedFilename("") == HivraDownloadNaming.fallbackName)
        let long = HivraDownloadNaming.sanitizedFilename(String(repeating: "é", count: 300) + ".tar.gz")
        #expect(long.utf8.count <= 255)
        #expect(long.hasSuffix(".tar.gz"))
    }

    @Test("an existing or in-progress name is never reused")
    func avoidsCollisions() {
        var taken: Set<String> = []
        func next(_ name: String) -> String {
            let url = HivraDownloadNaming.availableURL(for: name, in: folder) { taken.contains($0.lastPathComponent) }
            taken.insert(url.lastPathComponent)
            #expect(url.deletingLastPathComponent().standardizedFileURL == folder.standardizedFileURL)
            return url.lastPathComponent
        }
        #expect(next("report.pdf") == "report.pdf")
        #expect(next("report.pdf") == "report (1).pdf")
        #expect(next("report.pdf") == "report (2).pdf")
        #expect(next("README") == "README")
        #expect(next("README") == "README (1)")
        #expect(next("logs.tar.gz") == "logs.tar.gz")
        #expect(next("logs.tar.gz") == "logs (1).tar.gz")
    }
}

@Suite("Web presentation")
struct HivraWebPresentationTests {
    @Test("dialogs and popups name the page's origin")
    func originLabels() {
        #expect(HivraWebOriginLabel.make(scheme: "https", host: "canary.hermesos.cloud", port: 0) == "canary.hermesos.cloud")
        #expect(HivraWebOriginLabel.make(scheme: "https", host: "canary.hermesos.cloud", port: 443) == "canary.hermesos.cloud")
        #expect(HivraWebOriginLabel.make(scheme: "https", host: "example.com", port: 8443) == "example.com:8443")
        #expect(HivraWebOriginLabel.make(scheme: "http", host: "127.0.0.1", port: 3000) == "http://127.0.0.1:3000")
        #expect(HivraWebOriginLabel.make(scheme: "", host: "", port: 0) == "This page")
        #expect(HivraWebOriginLabel.make(scheme: "file", host: "", port: 0) == "This page")
    }

    @Test("popup titles always carry the origin")
    func popupTitles() {
        let google = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        #expect(HivraPopupTitle.make(pageTitle: "Sign in – Google accounts", url: google)
            == "Sign in – Google accounts — accounts.google.com")
        #expect(HivraPopupTitle.make(pageTitle: "  ", url: google) == "accounts.google.com")
        #expect(HivraPopupTitle.make(pageTitle: nil, url: URL(string: "about:blank")) == HivraPopupTitle.placeholder)
        let long = HivraPopupTitle.make(pageTitle: String(repeating: "a", count: 200), url: google)
        #expect(long.hasSuffix(" — accounts.google.com"))
        #expect(long.count < 120)
    }

    @Test("popup size follows window features within the screen")
    func popupGeometry() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        #expect(HivraPopupWindowGeometry.contentSize(requestedWidth: 560, requestedHeight: 720, visibleFrame: screen)
            == CGSize(width: 560, height: 720))
        #expect(HivraPopupWindowGeometry.contentSize(requestedWidth: nil, requestedHeight: nil, visibleFrame: screen)
            == HivraPopupWindowGeometry.defaultSize)
        #expect(HivraPopupWindowGeometry.contentSize(requestedWidth: 5000, requestedHeight: 5000, visibleFrame: screen)
            == CGSize(width: 1360, height: 820))
        #expect(HivraPopupWindowGeometry.contentSize(requestedWidth: 10, requestedHeight: -4, visibleFrame: screen)
            == CGSize(width: HivraPopupWindowGeometry.minimumSize.width, height: HivraPopupWindowGeometry.defaultSize.height))
    }
}
