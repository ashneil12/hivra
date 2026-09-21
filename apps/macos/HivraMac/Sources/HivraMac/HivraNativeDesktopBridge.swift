import AppKit
import Foundation
import HivraMacCore
import OSLog
import WebKit

@MainActor
final class HivraNativeDesktopBridge: NSObject, WKScriptMessageHandlerWithReply {
    private static let logger = Logger(subsystem: "cloud.hivra.mac.alpha", category: "native-desktop")
    private static let maximumPreparedProfiles = 4
    private let trustedOrigin: HivraTrustedWebOrigin?
    private var profiles: [UUID: HivraMoonlightProfile] = [:]
    private var processes: [UUID: Process] = [:]
    private var stoppingSessions: Set<UUID> = []

    init(trustedURL: URL) {
        trustedOrigin = HivraTrustedWebOrigin(trustedURL)
        super.init()
    }

    deinit {
        for process in processes.values where process.isRunning { process.terminate() }
        for profile in profiles.values { try? profile.remove() }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              trustedOrigin?.matches(scheme: origin.protocol, host: origin.host, port: origin.port) == true else {
            return (nil, "native_profile_request_denied")
        }
        if let status = HivraNativeDesktopStatusRequest.parse(message.body) {
            let process = processes[status.sessionId]
            return ([
                "type": "hivra.native-desktop.status-result.v1",
                "sessionId": status.sessionId.uuidString.lowercased(),
                "processIdentifier": Int(status.processIdentifier),
                "running": process?.processIdentifier == status.processIdentifier && process?.isRunning == true,
            ], nil)
        }
        if let focus = HivraNativeDesktopFocusRequest.parse(message.body) {
            guard let process = processes[focus.sessionId], process.isRunning,
                  process.processIdentifier == focus.processIdentifier,
                  let application = NSRunningApplication(processIdentifier: focus.processIdentifier),
                  application.activate(options: [.activateAllWindows]) else {
                return (nil, "native_focus_request_denied")
            }
            return ([
                "type": "hivra.native-desktop.focused.v1",
                "sessionId": focus.sessionId.uuidString.lowercased(),
                "processIdentifier": Int(focus.processIdentifier),
            ], nil)
        }
        if let stop = HivraNativeDesktopStopRequest.parse(message.body) {
            guard let process = processes[stop.sessionId], process.isRunning,
                  process.processIdentifier == stop.processIdentifier else {
                return (nil, "native_stop_request_denied")
            }
            stoppingSessions.insert(stop.sessionId)
            process.terminate()
            for _ in 0..<40 where process.isRunning {
                try? await Task.sleep(for: .milliseconds(50))
            }
            // Moonlight can ignore SIGTERM while its Qt event loop is shutting
            // down. This is the exact child process Hivra launched and already
            // matched against the signed session request above, so escalate only
            // that PID rather than leaving the controller stuck indefinitely.
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                for _ in 0..<20 where process.isRunning {
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
            guard !process.isRunning else {
                stoppingSessions.remove(stop.sessionId)
                return (nil, "native_moonlight_stop_uncertain")
            }
            processes.removeValue(forKey: stop.sessionId)
            stoppingSessions.remove(stop.sessionId)
            guard let profile = profiles.removeValue(forKey: stop.sessionId) else {
                return (nil, "native_profile_request_denied")
            }
            do { try profile.remove() }
            catch { return (nil, "native_profile_discard_failed") }
            return ([
                "type": "hivra.native-desktop.stopped.v1",
                "sessionId": stop.sessionId.uuidString.lowercased(),
                "processIdentifier": Int(stop.processIdentifier),
            ], nil)
        }
        if let launch = HivraNativeDesktopLaunchRequest.parse(message.body) {
            guard launch.transport == "direct",
                  let profile = profiles[launch.sessionId],
                  processes[launch.sessionId] == nil else {
                return (nil, launch.transport == "relay"
                    ? "native_relay_unavailable" : "native_launch_request_denied")
            }
            do {
                let process = try HivraMoonlightLauncher.launch(
                    profile: profile,
                    pairedHost: HivraMoonlightPairedHost(
                        serverId: launch.serverId,
                        serverCertificatePEM: launch.serverCertificatePEM,
                        serverCertificateSHA256: launch.serverCertificateSHA256,
                        directIPv4: launch.connectionIPv4
                    )
                )
                processes[launch.sessionId] = process
                process.terminationHandler = { [weak self] finished in
                    let processIdentifier = finished.processIdentifier
                    Task { @MainActor [weak self] in
                        guard self?.stoppingSessions.contains(launch.sessionId) != true else { return }
                        guard self?.processes[launch.sessionId]?.processIdentifier == processIdentifier else { return }
                        self?.processes.removeValue(forKey: launch.sessionId)
                        if let completed = self?.profiles.removeValue(forKey: launch.sessionId) {
                            try? completed.remove()
                        }
                    }
                }
                return ([
                    "type": "hivra.native-desktop.launched.v1",
                    "sessionId": launch.sessionId.uuidString.lowercased(),
                    "streamingMode": profile.streamingMode.rawValue,
                    "processIdentifier": Int(process.processIdentifier),
                ], nil)
            } catch {
                Self.logger.error("Moonlight launch failed: \(String(reflecting: error), privacy: .public)")
                return (nil, "native_moonlight_launch_failed")
            }
        }
        if let discard = HivraNativeDesktopDiscardRequest.parse(message.body) {
            guard processes[discard.sessionId] == nil,
                  let profile = profiles[discard.sessionId] else {
                return (nil, "native_profile_request_denied")
            }
            do {
                try profile.remove()
                profiles.removeValue(forKey: discard.sessionId)
                return ([
                    "type": "hivra.native-desktop.profile-discarded.v1",
                    "sessionId": discard.sessionId.uuidString.lowercased(),
                ], nil)
            } catch {
                return (nil, "native_profile_discard_failed")
            }
        }
        guard let request = HivraNativeDesktopProfileRequest.parse(message.body),
              profiles[request.sessionId] == nil,
              profiles.count < Self.maximumPreparedProfiles else {
            return (nil, "native_profile_request_denied")
        }
        do {
            let profile = try HivraMoonlightProfile.prepare(
                in: try profileParent(),
                sessionId: request.sessionId,
                clientId: UUID(),
                streamingMode: request.streamingMode
            )
            profiles[request.sessionId] = profile
            return ([
                "type": "hivra.native-desktop.profile-ready.v1",
                "sessionId": request.sessionId.uuidString.lowercased(),
                "clientId": profile.clientId.uuidString.lowercased(),
                "clientCertificatePem": profile.certificatePEM,
                "clientCertificateSha256": profile.certificateSHA256,
                "streamingMode": profile.streamingMode.rawValue,
            ], nil)
        } catch {
            return (nil, "native_profile_preparation_failed")
        }
    }

    private func profileParent() throws -> URL {
        let parent = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appending(path: "hivra-native-desktop-profiles")
        if mkdir(parent.path, 0o700) != 0 && errno != EEXIST {
            throw HivraMoonlightProfile.ProfileError.privateParentRequired
        }
        return parent
    }
}
