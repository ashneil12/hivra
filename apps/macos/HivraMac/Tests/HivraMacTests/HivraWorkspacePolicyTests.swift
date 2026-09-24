import Foundation
import Testing

@testable import HivraMacCore

@Suite("Native workspace lifecycle decisions")
struct HivraWorkspacePolicyTests {
    private let a = HivraWorkspaceResource(uid: "x-a", id: "a", source: .hivra, kind: .agent,
                                          name: "A", description: "Runtime", status: "running", href: "/dashboard/agent/a")
    private let b = HivraWorkspaceResource(uid: "x-b", id: "b", source: .hivra, kind: .computer,
                                          name: "B", description: "Ubuntu", status: "running", href: "/dashboard/agent/b?tab=desktop")

    @Test("direct and newly launched resource URLs wait for real inventory, then adopt the existing browser")
    func delayedInventory() {
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: nil, resources: [], openUIDs: []) == .waitingForInventory("x-b"))
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: nil, resources: [b], openUIDs: []) == .adopt(b))
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: nil, resources: [b], openUIDs: ["x-b"]) == .selectExisting("x-b"))
    }

    @Test("delayed startup adoption selects a deep link without overriding a manual native selection")
    func deferredSelection() {
        #expect(HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: false, showingWebDestination: false,
            hasObservedOwnedRoute: false, hasExplicitSelection: false))
        #expect(!HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: false, showingWebDestination: false,
            hasObservedOwnedRoute: false, hasExplicitSelection: true))
        #expect(!HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: false, showingWebDestination: false,
            hasObservedOwnedRoute: true, hasExplicitSelection: true))
        #expect(HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: false, showingWebDestination: true,
            hasObservedOwnedRoute: true, hasExplicitSelection: true))
        #expect(!HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: true, showingWebDestination: true,
            hasObservedOwnedRoute: true, hasExplicitSelection: true))
    }

    @Test("a replacement inventory browser preserves a manual Agents selection after background resource adoption")
    func backgroundAdoptionReturnDestination() {
        #expect(!HivraWorkspacePolicy.shouldSelectAdoptedResource(hasSelectedTab: false, showingWebDestination: false,
            hasObservedOwnedRoute: true, hasExplicitSelection: true))
        let destination = HivraWorkspacePolicy.destinationAfterResourceTransfer(.agents, showingWebDestination: false)
        #expect(destination == .agents)
        #expect(!HivraWorkspacePolicy.shouldAdoptConnectionDestination(routeChanged: true, hasSelectedTab: false,
            isInitialOwnedRoute: true, hasExplicitSelection: true, showingWebDestination: false))
        // A later intentional browser route still updates its native destination.
        #expect(HivraWorkspacePolicy.shouldAdoptConnectionDestination(routeChanged: true, hasSelectedTab: false,
            isInitialOwnedRoute: false, hasExplicitSelection: true, showingWebDestination: true))
    }

    @Test("a launch transferred to a resource tab returns to native Home when the last tab closes")
    func launchReturnDestination() {
        let destination = HivraWorkspacePolicy.destinationAfterResourceTransfer(.launch, showingWebDestination: true)
        #expect(destination == .overview)
        #expect(!HivraWorkspacePolicy.shouldAdoptConnectionDestination(routeChanged: true, hasSelectedTab: true,
            isInitialOwnedRoute: true, hasExplicitSelection: true, showingWebDestination: false))
        let tab = UUID()
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: tab, tabs: [tab], selected: tab) == nil)
        #expect(destination == .overview)
    }

    @Test("surface changes preserve identity, while resource navigation adopts or reuses its actual target")
    func retainedResourceNavigation() {
        #expect(HivraWorkspacePolicy.adoption(path: "/dashboard/agent/a?tab=terminal", currentUID: "x-a", resources: [a, b], openUIDs: ["x-b"]) == .unchanged)
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: "x-a", resources: [a], openUIDs: []) == .waitingForInventory("x-b"))
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: "x-a", resources: [a, b], openUIDs: []) == .adopt(b))
        #expect(HivraWorkspacePolicy.adoption(path: b.href, currentUID: "x-a", resources: [a, b], openUIDs: ["x-b"]) == .selectExisting("x-b"))
        #expect(HivraWorkspacePolicy.adoption(path: "/dashboard/settings/help", currentUID: "x-a", resources: [a, b], openUIDs: []) == .leaveResource("/dashboard/settings/help"))
        #expect(HivraWorkspacePolicy.destination(for: "/dashboard/settings/help") == .settings)
    }

    @Test("only explicit owner changes invalidate owned views; a same-owner loading snapshot retains them")
    func ownerTransitions() {
        #expect(!HivraWorkspacePolicy.invalidatesOwner(previous: "a", next: "a"))
        #expect(HivraWorkspacePolicy.invalidatesOwner(previous: "a", next: nil))
        #expect(HivraWorkspacePolicy.invalidatesOwner(previous: "a", next: "b"))
        #expect(!HivraWorkspacePolicy.invalidatesOwner(previous: nil, next: "b"))
    }

    @Test("a committed account entry is distinct from an ordinary dashboard reload or a guest origin")
    func loginAndReload() {
        let trusted = URL(string: "https://example.test/dashboard")!
        for path in ["/", "/sign-in", "/sign-in/factor-one", "/sign-up", "/login"] {
            #expect(HivraWorkspacePolicy.isCommittedAccountEntry(url: URL(string: "https://example.test" + path)!, trustedURL: trusted))
        }
        for path in ["/dashboard", "/dashboard/agent/a?tab=terminal", "/sign-in-lookalike", "/docs"] {
            #expect(!HivraWorkspacePolicy.isCommittedAccountEntry(url: URL(string: "https://example.test" + path)!, trustedURL: trusted))
        }
        #expect(!HivraWorkspacePolicy.isCommittedAccountEntry(url: URL(string: "https://guest.test/sign-in")!, trustedURL: trusted))
    }

    @Test("closing selects an adjacent retained tab, preserves an inactive selection, and handles the last tab")
    func closingTabs() {
        let ids = [UUID(), UUID(), UUID()]
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: ids[1], tabs: ids, selected: ids[1]) == ids[2])
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: ids[2], tabs: ids, selected: ids[2]) == ids[1])
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: ids[0], tabs: ids, selected: ids[2]) == ids[2])
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: ids[0], tabs: [ids[0]], selected: ids[0]) == nil)
        #expect(HivraWorkspacePolicy.selectionAfterClosing(tabID: ids[0], tabs: ids, selected: nil) == nil)
    }

    @Test("canonical origins omit default ports, normalize hosts, and carry no route or credential parameters")
    func markerOrigins() {
        #expect(HivraWorkspaceBridgeTrust.canonicalOrigin(URL(string: "https://EXAMPLE.test:443/dashboard?token=private#secret")!) == "https://example.test")
        #expect(HivraWorkspaceBridgeTrust.canonicalOrigin(URL(string: "http://localhost:80/dashboard")!) == "http://localhost")
        #expect(HivraWorkspaceBridgeTrust.canonicalOrigin(URL(string: "http://127.0.0.1:3000/dashboard")!) == "http://127.0.0.1:3000")
        #expect(HivraWorkspaceBridgeTrust.canonicalOrigin(URL(string: "http://[::1]:3000/dashboard")!) == "http://[::1]:3000")
        #expect(HivraWorkspaceBridgeTrust.canonicalOrigin(URL(string: "https://user:secret@example.test/dashboard")!) == nil)
    }

    @Test("URL adoption requires the exact profile origin and strips no forbidden credential query")
    func relativeRoutes() {
        let trusted = URL(string: "https://example.test/dashboard")!
        #expect(HivraWorkspacePolicy.relativePath(url: URL(string: "https://example.test/dashboard/agent/a?tab=terminal")!, trustedURL: trusted) == "/dashboard/agent/a?tab=terminal")
        #expect(HivraWorkspacePolicy.relativePath(url: URL(string: "https://guest.test/dashboard/agent/a")!, trustedURL: trusted) == nil)
        #expect(HivraWorkspacePolicy.relativePath(url: URL(string: "https://example.test/dashboard?token=private")!, trustedURL: trusted) == nil)
        #expect(!HivraWorkspacePolicy.shouldReloadResourceOnReselection(
            currentURL: URL(string: "https://example.test/dashboard/agent/a?tab=desktop&open=fast"), trustedURL: trusted))
        #expect(HivraWorkspacePolicy.shouldReloadResourceOnReselection(
            currentURL: URL(string: "https://example.test/dashboard/agent/a?tab=desktop"), trustedURL: trusted,
            requestedPath: "/dashboard/agent/a?tab=desktop&open=native"))
        #expect(HivraWorkspacePolicy.shouldReloadResourceOnReselection(
            currentURL: URL(string: "https://guest.test/guacamole/#/client/expired"), trustedURL: trusted))
        #expect(HivraWorkspacePolicy.shouldReloadResourceOnReselection(currentURL: nil, trustedURL: trusted))
    }

    @Test("a launch result is adopted as its resource whatever one-shot arrival state its URL carries")
    func launchResultAdoption() throws {
        let trusted = URL(string: "https://example.test/dashboard")!
        let hermes = HivraWorkspaceResource(uid: "h-h", id: "h", source: .hermes, kind: .agent,
                                            name: "H", description: "Hermes", status: "provisioning", href: "/dashboard/instances/h")
        for (href, expected) in [
            ("/dashboard/agent/a?welcome=1&tab=terminal", a),
            ("/dashboard/agent/a?welcome=1&tab=aeon", a),
            ("/dashboard/agent/a?welcome=1&tab=manage#model-settings", a),
            ("/dashboard/agent/b?tab=desktop", b),
            ("/dashboard/instances/h?surface=chat&welcome=1", hermes),
        ] {
            let path = try #require(HivraWorkspacePolicy.relativePath(url: URL(string: "https://example.test" + href)!, trustedURL: trusted),
                                    Comment(rawValue: href))
            #expect(HivraWorkspacePolicy.adoption(path: path, currentUID: nil, resources: [a, b, hermes], openUIDs: []) == .adopt(expected),
                    Comment(rawValue: href))
            // Its later surface changes stay in the same tab.
            #expect(HivraWorkspacePolicy.adoption(path: path, currentUID: expected.uid, resources: [a, b, hermes], openUIDs: []) == .unchanged,
                    Comment(rawValue: href))
        }
    }

    @Test("re-selecting an open resource keeps its live page unless it left the resource or asks for a new transport")
    func reselectionRetainsLiveSessions() {
        let trusted = URL(string: "https://example.test/dashboard")!
        for current in [
            "https://example.test/dashboard/agent/a?welcome=1&tab=manage#model-settings",
            "https://example.test/dashboard/agent/a?tab=manage&unrecognized=1",
            "https://example.test/dashboard/agent/a/manage?tab=desktop&open=fast",
            "https://example.test/dashboard/%61gent/a/",
        ] {
            #expect(!HivraWorkspacePolicy.shouldReloadResourceOnReselection(
                currentURL: URL(string: current), trustedURL: trusted, requestedPath: a.href), Comment(rawValue: current))
        }
        #expect(!HivraWorkspacePolicy.shouldReloadResourceOnReselection(
            currentURL: URL(string: "https://example.test/dashboard/instances/h?surface=chat&welcome=1&unrecognized=1"),
            trustedURL: trusted, requestedPath: "/dashboard/instances/h"))
        for current in [
            // An expired guest transport, another origin, or another page of the dashboard.
            "https://guest.test/guacamole/#/client/expired", "http://example.test/dashboard/agent/a",
            "https://example.test:8443/dashboard/agent/a", "about:blank",
            "https://example.test/dashboard/billing?session_id=cs_test_a1B2c3", "https://example.test/dashboard/agent/b",
            "https://example.test/api/hivra/agents/a/export",
        ] {
            #expect(HivraWorkspacePolicy.shouldReloadResourceOnReselection(
                currentURL: URL(string: current), trustedURL: trusted, requestedPath: a.href), Comment(rawValue: current))
        }
        #expect(HivraWorkspacePolicy.shouldReloadResourceOnReselection(
            currentURL: URL(string: "https://example.test/dashboard/agent/b?tab=desktop"), trustedURL: trusted,
            requestedPath: "/dashboard/agent/b?tab=desktop&open=fast"))
    }
}
