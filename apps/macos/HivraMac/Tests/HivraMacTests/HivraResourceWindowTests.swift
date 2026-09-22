import AppKit
import Testing
import SwiftUI
import WebKit
import HivraMacCore
@testable import HivraMac

@Suite("Retained resource windows", .serialized)
@MainActor
struct HivraResourceWindowTests {
    private func eventually(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(condition())
    }

    private func fixture() async throws -> HivraWorkspaceSession {
        _ = NSApplication.shared
        let profile = HivraConnectionProfile(name: "Window QA", url: URL(string: "http://127.0.0.1:1/dashboard")!, kind: .custom)
        let session = HivraWorkspaceSession(profile: profile)
        session.connectionBrowser.webView.stopLoading()
        // Supply the display projection after the separately tested origin-validation boundary.
        let resources = ["agent", "computer"].map { kind in
            HivraWorkspaceResource(uid: "x-\(kind)", id: kind, source: .hivra,
                kind: kind == "agent" ? .agent : .computer, name: kind, description: "",
                status: "running", href: "/dashboard/agent/\(kind)")
        }
        session.connectionBrowser.receiveWorkspaceMessage(.workspace(.init(
            ownerKey: "window-qa", resources: resources, loading: false, errors: [:])))
        try await eventually { session.resources.count == 2 }
        return session
    }

    @Test("pop-out and return retain browser identity and independent windows")
    func roundTrip() async throws {
        let session = try await fixture()
        defer { session.clearOwnedViews() }
        let resource = try #require(session.resources.first)
        session.open(resource)
        let tab = try #require(session.activeTab)
        tab.browser.webView.stopLoading()
        tab.browser.webView.loadHTMLString("<input id='draft' value='unsent draft'><script>window.marker='retained'</script>", baseURL: HivraWorkspaceRoute.url(for: resource.href, profile: session.profile))
        try await eventually { !tab.browser.webView.isLoading }
        var returns = 0
        session.onReturnToWorkspace = { returns += 1 }
        let browser = tab.browser
        let mainWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                                  styleMask: [.titled], backing: .buffered, defer: false)
        mainWindow.isReleasedWhenClosed = false
        mainWindow.contentView = NSHostingView(rootView: WindowTestWorkspace(session: session, tab: tab))
        mainWindow.orderFront(nil)
        defer { mainWindow.contentView = nil; mainWindow.close() }
        try await eventually { browser.webView.window === mainWindow }
        session.detach(tab)
        let controller = try #require(session.detachedWindows[tab.id])
        try await eventually { browser.webView.window === controller.window }
        session.detach(tab)
        #expect(session.detachedWindows.count == 1)
        #expect(session.detachedWindows[tab.id] === controller)
        #expect(tab.browser === browser)
        session.open(try #require(session.resources.last))
        let second = try #require(session.activeTab)
        session.detach(second)
        #expect(session.detachedWindows.count == 2)
        #expect(second.browser !== browser)
        controller.window?.performClose(nil)
        #expect(session.detachedWindows[tab.id] == nil)
        #expect(session.detachedWindows[second.id] != nil)
        #expect(session.selectedTabID == tab.id)
        #expect(returns == 1)
        #expect(tab.browser === browser)
        try await eventually { browser.webView.window === mainWindow }
        let draft = try await browser.webView.evaluateJavaScript("document.getElementById('draft').value") as? String
        #expect(draft == "unsent draft")
        session.detach(tab)
        session.reattach(tab.id)
        #expect(returns == 2)
        #expect(session.detachedWindows[tab.id] == nil)
        #expect(tab.browser === browser)
    }

    @Test("closing tabs and clearing ownership close their windows")
    func cleanup() async throws {
        let session = try await fixture()
        defer { session.clearOwnedViews() }
        for resource in session.resources { session.open(resource) }
        let first = try #require(session.tabs.first)
        let second = try #require(session.tabs.last)
        session.detach(first)
        session.detach(second)
        let firstWindow = try #require(session.detachedWindows[first.id]?.window)
        let secondWindow = try #require(session.detachedWindows[second.id]?.window)
        session.close(first)
        #expect(!firstWindow.isVisible)
        #expect(session.detachedWindows.count == 1)
        session.connectionBrowser.receiveWorkspaceMessage(.workspace(.init(
            ownerKey: "another-owner", resources: [], loading: false, errors: [:])))
        try await eventually { session.tabs.isEmpty }
        #expect(!secondWindow.isVisible)
        #expect(session.detachedWindows.isEmpty)
        #expect(session.tabs.isEmpty)
        session.detach(first)
        #expect(session.detachedWindows.isEmpty)
    }
}

private struct WindowTestWorkspace: View {
    @ObservedObject var session: HivraWorkspaceSession
    let tab: HivraWorkspaceTab
    var body: some View {
        if session.detachedWindows[tab.id] == nil {
            HivraFocusedWorkPane(browser: tab.browser, profile: session.profile, onDetach: { _ in })
        } else {
            Text("Detached")
        }
    }
}
