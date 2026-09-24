import AppKit
import Foundation
import HivraMacCore
import OSLog
import WebKit

/// Hands a URL to the system (default browser, Mail). Web content reaches it only
/// through `HivraWebContentPolicy`; tests substitute it to prove what never leaves the app.
@MainActor
protocol HivraSystemURLOpening: AnyObject {
    @discardableResult func open(_ url: URL) -> Bool
}

extension NSWorkspace: HivraSystemURLOpening {}

struct HivraWebDialogResponse<Value> {
    var value: Value
    /// The user asked this page to stop presenting dialogs.
    var suppressesFurtherDialogs = false
}

/// Native presentation for JavaScript dialogs and file inputs.
@MainActor
protocol HivraWebDialogPresenting: AnyObject {
    func alert(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Void>
    func confirm(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Bool>
    func prompt(_ message: String, defaultText: String?, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<String?>
    func chooseFiles(allowsMultipleSelection: Bool, allowsDirectories: Bool, in window: NSWindow?) async -> [URL]?
}

/// Everything a web view may ask of the Mac beyond rendering.
@MainActor
struct HivraBrowserServices {
    var systemURLs: any HivraSystemURLOpening
    var dialogs: any HivraWebDialogPresenting
    var downloads: HivraDownloadManager

    static let live = HivraBrowserServices(
        systemURLs: NSWorkspace.shared,
        dialogs: HivraWebDialogs(),
        downloads: HivraDownloadManager(directory: {
            FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: "Downloads", directoryHint: .isDirectory)
        })
    )
}

/// JavaScript dialogs as sheets on the page's window, always naming the page's origin.
@MainActor
final class HivraWebDialogs: HivraWebDialogPresenting {
    static let maximumMessageLength = 2_000

    func alert(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Void> {
        let alert = makeAlert(message, from: origin, offeringSuppression: offeringSuppression)
        alert.addButton(withTitle: "OK")
        _ = await run(alert, in: window)
        return .init(value: (), suppressesFurtherDialogs: suppressed(alert))
    }

    func confirm(_ message: String, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<Bool> {
        let alert = makeAlert(message, from: origin, offeringSuppression: offeringSuppression)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let response = await run(alert, in: window)
        return .init(value: response == .alertFirstButtonReturn, suppressesFurtherDialogs: suppressed(alert))
    }

    func prompt(_ message: String, defaultText: String?, from origin: String, offeringSuppression: Bool, in window: NSWindow?) async -> HivraWebDialogResponse<String?> {
        let alert = makeAlert(message, from: origin, offeringSuppression: offeringSuppression)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        let response = await run(alert, in: window)
        return .init(value: response == .alertFirstButtonReturn ? field.stringValue : nil,
                     suppressesFurtherDialogs: suppressed(alert))
    }

    func chooseFiles(allowsMultipleSelection: Bool, allowsDirectories: Bool, in window: NSWindow?) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = allowsDirectories
        panel.allowsMultipleSelection = allowsMultipleSelection
        panel.resolvesAliases = true
        panel.prompt = "Choose"
        let response: NSApplication.ModalResponse
        if let window, window.isVisible {
            response = await panel.beginSheetModal(for: window)
        } else {
            response = panel.runModal()
        }
        return response == .OK ? panel.urls : nil
    }

    private func makeAlert(_ message: String, from origin: String, offeringSuppression: Bool) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "\(origin) says"
        alert.informativeText = message.count > Self.maximumMessageLength
            ? String(message.prefix(Self.maximumMessageLength)) + "…" : message
        if offeringSuppression {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Don’t allow more dialogs from this page"
        }
        return alert
    }

    private func suppressed(_ alert: NSAlert) -> Bool {
        alert.showsSuppressionButton && alert.suppressionButton?.state == .on
    }

    /// A sheet on the page's window (queued behind any sheet already shown there);
    /// app-modal only for a page that is not on screen, such as a background tab.
    private func run(_ alert: NSAlert, in window: NSWindow?) async -> NSApplication.ModalResponse {
        if let window, window.isVisible {
            return await alert.beginSheetModal(for: window)
        }
        return alert.runModal()
    }
}

/// A finished or failed download, shown briefly by the pane that started it.
struct HivraDownloadNotice: Identifiable, Equatable {
    enum Outcome: Equatable {
        case finished(URL)
        case failed
    }

    let id = UUID()
    let filename: String
    let outcome: Outcome
}

/// Saves downloads to ~/Downloads without replacing existing files, and tells the
/// originating browser when each one finishes or fails.
@MainActor
final class HivraDownloadManager: NSObject, WKDownloadDelegate {
    private static let logger = Logger(subsystem: "cloud.hivra.mac.alpha", category: "downloads")

    private struct Entry {
        weak var owner: HivraBrowserModel?
        var destination: URL?
        var suggestedFilename: String?
    }

    private let directory: () -> URL
    private var entries: [WKDownload: Entry] = [:]
    /// Destinations chosen for downloads still in progress; they may not exist on disk yet.
    private var reserved: Set<String> = []

    init(directory: @escaping () -> URL) {
        self.directory = directory
    }

    func track(_ download: WKDownload, for owner: HivraBrowserModel) {
        entries[download] = Entry(owner: owner)
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String
    ) async -> URL? {
        let folder = directory()
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            Self.logger.error("Downloads folder unavailable: \(String(reflecting: error), privacy: .public)")
            return nil
        }
        let destination = HivraDownloadNaming.availableURL(for: suggestedFilename, in: folder) { candidate in
            reserved.contains(candidate.path) || FileManager.default.fileExists(atPath: candidate.path)
        }
        reserved.insert(destination.path)
        entries[download, default: Entry()].destination = destination
        entries[download]?.suggestedFilename = destination.lastPathComponent
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = finish(download), let destination = entry.destination else { return }
        // Bounces the Downloads stack in the Dock, as Safari does.
        DistributedNotificationCenter.default().post(
            name: Notification.Name("com.apple.DownloadFileFinished"),
            object: destination.resolvingSymlinksInPath().path
        )
        entry.owner?.presentDownload(HivraDownloadNotice(filename: destination.lastPathComponent, outcome: .finished(destination)))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        Self.logger.error("Download failed: \(String(reflecting: error), privacy: .public)")
        guard let entry = finish(download) else { return }
        entry.owner?.presentDownload(HivraDownloadNotice(
            filename: entry.suggestedFilename ?? HivraDownloadNaming.fallbackName,
            outcome: .failed
        ))
    }

    private func finish(_ download: WKDownload) -> Entry? {
        guard let entry = entries.removeValue(forKey: download) else { return nil }
        if let destination = entry.destination { reserved.remove(destination.path) }
        return entry
    }
}
