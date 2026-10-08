import Foundation

/// What one page may start by itself: downloads and hand-offs to another Mac app.
///
/// WebKit reports a script's `click()` as a link activation, so these rules count the
/// user's own input instead: the web view numbers every mouse press and key press, and
/// each press can be spent by at most one request. Assistive technology presses links
/// without such input, which is why a request without it is asked about, not dropped,
/// wherever a browser would still honour it.
public struct HivraPageActivation: Sendable {
    public enum Decision: Equatable, Sendable {
        case allow
        /// Ask in a sheet on the page's window that names the requesting origin.
        case ask
        case refuse(reason: String)
    }

    /// Increases with every committed document, so an answer to a question asked by an
    /// earlier document is not applied to the next one.
    public private(set) var document: UInt64 = 0
    /// The last input number a request spent, or the last one before this document.
    private var spentInput: UInt64 = 0
    private var downloadAllowance = true
    private var downloadAnswers: [String: Bool] = [:]
    private var appOpensBlocked = false
    private var appOpenQuestionPending = false

    public init() {}

    /// A new document: input from before it is spent, it may download once without
    /// input again, and earlier answers are forgotten, as in a browser.
    public mutating func documentCommitted(input: UInt64) {
        document += 1
        spentInput = max(spentInput, input)
        downloadAllowance = true
        downloadAnswers = [:]
        appOpensBlocked = false
        appOpenQuestionPending = false
    }

    /// One download per document and one per user input. After that the user decides,
    /// once per requesting origin. A frame from another origin than the connection may
    /// download only right after input, and is never asked about: an embed or advert
    /// must not be able to prompt, let alone write to Downloads, on its own.
    public mutating func download(
        requester: String,
        fromMainFrame: Bool,
        fromConnectionOrigin: Bool,
        input: UInt64
    ) -> Decision {
        if spend(input) {
            downloadAllowance = false
            return .allow
        }
        guard fromMainFrame || fromConnectionOrigin else {
            return .refuse(reason: "a frame from another origin downloaded without user input")
        }
        if downloadAllowance {
            downloadAllowance = false
            return .allow
        }
        switch downloadAnswers[requester] {
        case true?: return .allow
        case false?: return .refuse(reason: "the user did not allow more downloads from this page")
        case nil: return .ask
        }
    }

    public mutating func recordDownloadAnswer(_ allowed: Bool, requester: String, document: UInt64) {
        guard document == self.document else { return }
        downloadAnswers[requester] = allowed
    }

    /// The connection's own page opens the app when the user's input led to the request.
    /// Any other page, and any request without input, asks first; while a question is
    /// showing, further requests are refused so a page cannot stack them.
    public mutating func openApp(fromConnectionOrigin: Bool, input: UInt64) -> Decision {
        if appOpensBlocked { return .refuse(reason: "the user blocked this page from opening apps") }
        if appOpenQuestionPending { return .refuse(reason: "a request to open an app is already waiting") }
        if spend(input), fromConnectionOrigin { return .allow }
        appOpenQuestionPending = true
        return .ask
    }

    public mutating func appOpenAnswered(blockingFurther: Bool, document: UInt64) {
        guard document == self.document else { return }
        appOpenQuestionPending = false
        if blockingFurther { appOpensBlocked = true }
    }

    private mutating func spend(_ input: UInt64) -> Bool {
        guard input > spentInput else { return false }
        spentInput = input
        return true
    }
}
