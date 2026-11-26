import AppKit
import Combine
import Foundation
import HivraMacCore

/// Runs browser sign-in (see `HivraBrowserSignIn`): opens the browser, waits
/// for hivra://auth/callback, trades the code for a ticket and hands the
/// ticket's finish page to the workspace that asked.
@MainActor
final class HivraBrowserSignInCoordinator: ObservableObject {
    enum Phase: Equatable {
        case idle
        case waitingForBrowser
        case finishing
        case failed(String)
    }

    struct Completion: Equatable {
        let id = UUID()
        let profileID: UUID
        let finishURL: URL
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var completion: Completion?
    /// Which connections answer the hand-off (the website has it switched on).
    @Published private(set) var supported: [UUID: Bool] = [:]

    private var pending: (request: HivraBrowserSignIn.Request, profile: HivraConnectionProfile, intent: HivraBrowserSignIn.Intent)?
    private var probing: Set<UUID> = []
    private let session: URLSession
    private let openURL: (URL) -> Void

    init(session: URLSession = .shared, openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }) {
        self.session = session
        self.openURL = openURL
    }

    func isSupported(_ profile: HivraConnectionProfile) -> Bool {
        supported[profile.id] == true
    }

    /// Asks the website once whether it has browser sign-in on. A switched-off
    /// site answers 404; a switched-on one refuses an empty request with 400.
    func probe(_ profile: HivraConnectionProfile) {
        guard profile.kind == .hivraCloud, supported[profile.id] == nil, !probing.contains(profile.id),
              let url = HivraBrowserSignIn.exchangeURL(connection: profile.url) else { return }
        probing.insert(profile.id)
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        Task {
            let status = (try? await session.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
            probing.remove(profile.id)
            if let status { supported[profile.id] = status == 400 }
        }
    }

    func start(_ intent: HivraBrowserSignIn.Intent, for profile: HivraConnectionProfile) {
        let request = HivraBrowserSignIn.Request.make()
        guard let url = request.browserURL(connection: profile.url, intent: intent) else {
            phase = .failed("This connection can't open browser sign-in.")
            return
        }
        pending = (request, profile, intent)
        phase = .waitingForBrowser
        openURL(url)
    }

    /// Opens the browser again for the sign-in already waiting.
    func reopenBrowser() {
        guard let pending,
              let url = pending.request.browserURL(connection: pending.profile.url, intent: pending.intent) else { return }
        openURL(url)
    }

    func cancel() {
        pending = nil
        phase = .idle
    }

    func handle(_ url: URL) {
        guard let callback = HivraBrowserSignIn.callback(from: url) else { return }
        guard let pending, pending.request.state == callback.state else {
            // A link from an older attempt, or one this app did not start.
            phase = .failed("That sign-in link is out of date. Please try again.")
            return
        }
        self.pending = nil
        phase = .finishing
        Task { await exchange(callback.code, request: pending.request, profile: pending.profile) }
    }

    private func exchange(_ code: String, request: HivraBrowserSignIn.Request, profile: HivraConnectionProfile) async {
        guard let url = HivraBrowserSignIn.exchangeURL(connection: profile.url) else {
            phase = .failed("This connection can't finish browser sign-in.")
            return
        }
        var post = URLRequest(url: url, timeoutInterval: 20)
        post.httpMethod = "POST"
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        post.httpBody = HivraBrowserSignIn.exchangeBody(code: code, verifier: request.verifier)
        do {
            let (data, response) = try await session.data(for: post)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let ticket = HivraBrowserSignIn.ticket(fromResponse: data),
                  let finish = HivraBrowserSignIn.finishURL(connection: profile.url, ticket: ticket) else {
                phase = .failed("That sign-in has expired. Please try again.")
                return
            }
            completion = Completion(profileID: profile.id, finishURL: finish)
            phase = .idle
            NSApp.activate()
        } catch {
            phase = .failed("Couldn't reach Hivra. Check your connection and try again.")
        }
    }
}
