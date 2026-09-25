import AppKit
import SwiftUI
import Testing
import HivraMacCore
@testable import HivraMac

@MainActor
private final class DismissalLog {
    var count = 0
}

private struct SwitcherSheetHost: View {
    let session: HivraWorkspaceSession
    let log: DismissalLog
    @State private var showing = true

    var body: some View {
        Color.clear
            .frame(width: 700, height: 600)
            .sheet(isPresented: $showing) {
                HivraNativeSwitcher(session: session) {
                    log.count += 1
                    showing = false
                }
            }
    }
}

@Suite("Resource switcher", .serialized)
@MainActor
struct HivraNativeSwitcherTests {
    private func eventually(_ label: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(condition(), Comment(rawValue: label))
    }

    private func press(_ characters: String, keyCode: UInt16, in window: NSWindow) async throws {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            let event = try #require(NSEvent.keyEvent(
                with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
            // Straight to the sheet: another suite's window may be key while tests run in parallel.
            window.sendEvent(event)
            try await Task.sleep(for: .milliseconds(80))
        }
    }

    private func presentSwitcher() async throws -> (HivraWorkspaceSession, DismissalLog, NSWindow, NSWindow) {
        _ = NSApplication.shared
        let profile = HivraConnectionProfile(name: "Switcher QA", url: URL(string: "http://127.0.0.1:1/dashboard")!, kind: .custom)
        let session = HivraWorkspaceSession(profile: profile)
        session.connectionBrowser.webView.stopLoading()
        let resources = ["agent", "computer"].map { kind in
            HivraWorkspaceResource(uid: "x-\(kind)", id: kind, source: .hivra,
                                   kind: kind == "agent" ? .agent : .computer, name: kind, description: "",
                                   status: "running", href: "/dashboard/agent/\(kind)")
        }
        session.connectionBrowser.receiveWorkspaceMessage(.workspace(.init(
            ownerKey: "switcher-qa", resources: resources, loading: false, errors: [:])))
        try await eventually("inventory adopted") { session.resources.count == 2 }
        let log = DismissalLog()
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 600), styleMask: [.titled],
                              backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        parent.contentView = NSHostingView(rootView: SwitcherSheetHost(session: session, log: log))
        parent.makeKeyAndOrderFront(nil)
        try await eventually("switcher sheet presented") { parent.attachedSheet != nil }
        let sheet = try #require(parent.attachedSheet)
        try await eventually("search field focused") { sheet.firstResponder is NSTextView }
        return (session, log, parent, sheet)
    }

    @Test("Escape closes the switcher from the search field, with a query typed")
    func escapeFromSearch() async throws {
        let (session, log, parent, sheet) = try await presentSwitcher()
        defer { parent.contentView = nil; parent.close(); session.clearOwnedViews() }
        for (character, code) in [("c", UInt16(8)), ("o", UInt16(31))] {
            try await press(character, keyCode: code, in: sheet)
        }
        #expect((sheet.firstResponder as? NSTextView)?.string == "co")

        try await press("\u{1b}", keyCode: 53, in: sheet)
        try await eventually("switcher dismissed") { parent.attachedSheet == nil }
        #expect(log.count == 1)
    }

    @Test("Escape closes the switcher when the result list has focus")
    func escapeFromResults() async throws {
        let (session, log, parent, sheet) = try await presentSwitcher()
        defer { parent.contentView = nil; parent.close(); session.clearOwnedViews() }
        try await press("\t", keyCode: 48, in: sheet)
        #expect(!(sheet.firstResponder is NSTextView))

        try await press("\u{1b}", keyCode: 53, in: sheet)
        try await eventually("switcher dismissed") { parent.attachedSheet == nil }
        #expect(log.count == 1)
    }
}
