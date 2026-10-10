import AppKit
import Testing
import WebKit
import HivraMacCore
@testable import HivraMac

/// Drives the real session and WebKit views through the dashboard URLs Canary emits.
@Suite("Workspace session routes", .serialized)
@MainActor
struct HivraWorkspaceSessionRouteTests {
    private let origin = "http://127.0.0.1:1"

    private func eventually(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(condition())
    }

    private func signedInSession() async throws -> HivraWorkspaceSession {
        _ = NSApplication.shared
        let profile = HivraConnectionProfile(name: "Route QA", url: URL(string: "\(origin)/dashboard")!, kind: .custom)
        let session = HivraWorkspaceSession(profile: profile)
        session.connectionBrowser.webView.stopLoading()
        // Supply the display projection after the separately tested origin-validation boundary.
        let resources = [
            HivraWorkspaceResource(uid: "x-codex", id: "codex", source: .hivra, kind: .agent, name: "Codex",
                                   description: "Codex", status: "provisioning", href: "/dashboard/agent/codex"),
            HivraWorkspaceResource(uid: "h-hermes", id: "hermes", source: .hermes, kind: .agent, name: "Hermes",
                                   description: "Hermes", status: "running", href: "/dashboard/instances/hermes"),
        ]
        session.connectionBrowser.receiveWorkspaceMessage(.workspace(.init(
            ownerKey: "route-qa", resources: resources, loading: false, errors: [:])))
        try await eventually { session.resources.count == 2 }
        return session
    }

    /// Stands in for the dashboard page at `url`: a live document whose marker is lost if it reloads.
    private func showLivePage(_ browser: HivraBrowserModel, at url: String) async throws {
        browser.webView.stopLoading()
        browser.webView.loadHTMLString("<script>window.liveSession = 'retained'</script>", baseURL: URL(string: url)!)
        // The URL changes before the document commits; wait for the committed page itself.
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if !browser.webView.isLoading, browser.currentURL?.absoluteString == url,
               await liveMarker(browser) == "retained" { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        Issue.record("The live page at \(url) never committed")
    }

    /// Nil once the document that set the marker has been replaced.
    private func liveMarker(_ browser: HivraBrowserModel) async -> String? {
        try? await browser.webView.evaluateJavaScript("window.liveSession") as? String
    }

    @Test("a launch result in the connection browser becomes its resource tab, and choosing it again keeps it live")
    func adoptsLaunchResult() async throws {
        let session = try await signedInSession()
        defer { session.clearOwnedViews() }
        let launching = session.connectionBrowser
        // Codex's launch result (launchResultHref) when its model key is delivered after launch.
        try await showLivePage(launching, at: "\(origin)/dashboard/agent/codex?welcome=1&tab=manage#model-settings")
        try await eventually { session.tabs.count == 1 }
        let tab = try #require(session.tabs.first)
        #expect(tab.resource.uid == "x-codex")
        #expect(tab.browser === launching)
        #expect(session.connectionBrowser !== launching)

        session.select(.agents)
        session.open(try #require(session.resources.first { $0.uid == "x-codex" }))
        #expect(session.tabs.count == 1)
        #expect(session.selectedTabID == tab.id)
        #expect(!tab.browser.webView.isLoading)
        #expect(await liveMarker(tab.browser) == "retained")
    }

    @Test("choosing an open resource whose page carries an unrecognized query selects it without reloading")
    func reselectionKeepsLivePage() async throws {
        let session = try await signedInSession()
        defer { session.clearOwnedViews() }
        let hermes = try #require(session.resources.first { $0.uid == "h-hermes" })
        session.open(hermes)
        let tab = try #require(session.activeTab)
        let live = "\(origin)/dashboard/instances/hermes?surface=chat&unrecognized=1"
        try await showLivePage(tab.browser, at: live)

        session.select(.agents)
        session.open(hermes)
        #expect(session.selectedTabID == tab.id)
        #expect(!tab.browser.webView.isLoading)
        #expect(tab.browser.webView.url?.absoluteString == live)
        #expect(await liveMarker(tab.browser) == "retained")
    }
}
