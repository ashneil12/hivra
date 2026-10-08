import AppKit
import Combine
import HivraMacCore
import SwiftUI
import WebKit

/// Hosts a web popup (OAuth, connectors, file viewers) created from the opener's
/// configuration. It carries no native bridges, is never restored, and closes when
/// the page calls `window.close()`, when the user closes it, or when its opener goes away.
@MainActor
final class HivraPopupWindowController: NSWindowController, NSWindowDelegate {
    let browser: HivraBrowserModel
    private var onClose: ((HivraPopupWindowController) -> Void)?
    private weak var openerWindow: NSWindow?
    private var titleSubscription: AnyCancellable?

    init(
        browser: HivraBrowserModel,
        windowFeatures: WKWindowFeatures,
        openerWindow: NSWindow?,
        onClose: @escaping (HivraPopupWindowController) -> Void
    ) {
        self.browser = browser
        self.onClose = onClose
        self.openerWindow = openerWindow
        let screen = openerWindow?.screen ?? NSScreen.main
        let size = HivraPopupWindowGeometry.contentSize(
            requestedWidth: windowFeatures.width?.doubleValue,
            requestedHeight: windowFeatures.height?.doubleValue,
            visibleFrame: screen?.visibleFrame
        )
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.minSize = HivraPopupWindowGeometry.minimumSize
        window.title = HivraPopupTitle.placeholder
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: HivraPopupContentView(browser: browser))
        browser.requestClose = { [weak self] in self?.close() }
        titleSubscription = browser.$pageTitle.combineLatest(browser.$currentURL)
            .sink { [weak window] title, url in
                window?.title = HivraPopupTitle.make(pageTitle: title, url: url)
            }
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        guard let window else { return }
        if let openerWindow {
            // Over the window that asked for it, like a browser popup.
            let opener = openerWindow.frame
            window.setFrameOrigin(NSPoint(x: opener.midX - window.frame.width / 2,
                                          y: opener.midY - window.frame.height / 2))
            window.setFrame(window.constrainFrameRect(window.frame, to: openerWindow.screen), display: false)
        } else {
            window.center()
        }
        showWindow(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let onClose else { return }
        self.onClose = nil
        titleSubscription = nil
        browser.requestClose = nil
        browser.closeOwnedPopups()
        browser.webView.stopLoading()
        window?.delegate = nil
        // Releasing the view ends the page, so the opener observes `popup.closed`.
        window?.contentView = nil
        onClose(self)
    }
}

private struct HivraPopupContentView: View {
    @ObservedObject var browser: HivraBrowserModel

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
            HivraWebView(webView: browser.webView)
            if let failure = browser.failure {
                HivraPopupRecovery(failure: failure, address: HivraWebOriginLabel.make(url: browser.currentURL),
                                   onRetry: browser.reload)
            }
        }
        .overlay(alignment: .bottom) {
            HivraDownloadBanner(browser: browser)
        }
    }
}
