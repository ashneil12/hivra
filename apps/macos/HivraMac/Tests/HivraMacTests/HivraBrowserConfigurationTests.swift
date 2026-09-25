import Foundation
import Testing

@testable import HivraMacCore

@Suite("Hivra browser configuration")
struct HivraBrowserConfigurationTests {
    @MainActor
    @Test("appends Hivra identity without replacing WebKit's user agent")
    func appendsApplicationIdentity() {
        let configuration = HivraBrowserConfiguration.make()

        // The test runner is not the Hivra bundle, so its version is the development fallback.
        #expect(configuration.applicationNameForUserAgent == "HivraMac/\(HivraAppIdentity.developmentVersion)")
    }

    @MainActor
    @Test("keeps WebKit's popup blocker so window requests follow a user gesture")
    func blocksUnrequestedPopups() {
        #expect(!HivraBrowserConfiguration.make().preferences.javaScriptCanOpenWindowsAutomatically)
    }

    @MainActor
    @Test("separate windows share sign-in storage and permit element full screen")
    func separateWindowConfiguration() {
        let original = HivraBrowserConfiguration.make()
        let detached = HivraBrowserConfiguration.make()
        #expect(original !== detached)
        #expect(original.websiteDataStore === detached.websiteDataStore)
        #expect(detached.preferences.isElementFullscreenEnabled)
    }

    @Test("accepts only exact main-origin handoff request values")
    func nativeDesktopRequestContract() {
        let session = UUID()
        #expect(HivraNativeDesktopProfileRequest.parse([
            "type": HivraNativeDesktopProfileRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "streamingMode": "hq",
        ]) == HivraNativeDesktopProfileRequest(sessionId: session, streamingMode: .hq))
        #expect(HivraNativeDesktopProfileRequest.parse([
            "type": HivraNativeDesktopProfileRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "streamingMode": "performance",
        ]) == HivraNativeDesktopProfileRequest(sessionId: session, streamingMode: .performance))
        #expect(HivraNativeDesktopProfileRequest.parse([
            "type": HivraNativeDesktopProfileRequest.protocolName,
            "sessionId": session.uuidString,
            "streamingMode": "hq",
            "host": "attacker.invalid",
        ]) == nil)
        #expect(HivraNativeDesktopProfileRequest.parse([
            "type": "hivra.native-desktop.open-command.v1",
            "sessionId": session.uuidString,
            "streamingMode": "hq",
        ]) == nil)
        #expect(HivraNativeDesktopProfileRequest.parse([
            "type": HivraNativeDesktopProfileRequest.protocolName,
            "sessionId": session.uuidString,
            "streamingMode": "arbitrary",
        ]) == nil)
        #expect(HivraNativeDesktopDiscardRequest.parse([
            "type": HivraNativeDesktopDiscardRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
        ]) == HivraNativeDesktopDiscardRequest(sessionId: session))
        #expect(HivraNativeDesktopDiscardRequest.parse([
            "type": HivraNativeDesktopDiscardRequest.protocolName,
            "sessionId": session.uuidString,
            "host": "attacker.invalid",
        ]) == nil)
        #expect(HivraNativeDesktopStopRequest.parse([
            "type": HivraNativeDesktopStopRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": 4242,
        ]) == HivraNativeDesktopStopRequest(sessionId: session, processIdentifier: 4242))
        #expect(HivraNativeDesktopStopRequest.parse([
            "type": HivraNativeDesktopStopRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": true,
        ]) == nil)
        #expect(HivraNativeDesktopStatusRequest.parse([
            "type": HivraNativeDesktopStatusRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": 4242,
        ]) == HivraNativeDesktopStatusRequest(sessionId: session, processIdentifier: 4242))
        #expect(HivraNativeDesktopStatusRequest.parse([
            "type": HivraNativeDesktopStatusRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": false,
        ]) == nil)
        #expect(HivraNativeDesktopFocusRequest.parse([
            "type": HivraNativeDesktopFocusRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": 4242,
        ]) == HivraNativeDesktopFocusRequest(sessionId: session, processIdentifier: 4242))
        #expect(HivraNativeDesktopFocusRequest.parse([
            "type": HivraNativeDesktopFocusRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": true,
        ]) == nil)
        #expect(HivraNativeDesktopStopRequest.parse([
            "type": HivraNativeDesktopStopRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "processIdentifier": 4242,
            "command": "killall Moonlight",
        ]) == nil)
        let server = UUID()
        let boot = UUID()
        let certificate = "-----BEGIN CERTIFICATE-----\n" + String(repeating: "a", count: 96)
            + "\n-----END CERTIFICATE-----\n"
        let launch: [String: Any] = [
            "type": HivraNativeDesktopLaunchRequest.protocolName,
            "sessionId": session.uuidString.lowercased(),
            "serverId": server.uuidString.lowercased(),
            "serverCertificatePem": certificate,
            "serverCertificateSha256": String(repeating: "b", count: 64),
            "guestBootId": boot.uuidString.lowercased(),
            "connectionIpv4": "10.252.12.213",
            "transport": "direct",
        ]
        #expect(HivraNativeDesktopLaunchRequest.parse(launch)?.sessionId == session)
        #expect(HivraNativeDesktopLaunchRequest.parse(launch)?.serverId == server)
        for changed in [
            ["connectionIpv4": "127.0.0.1"],
            // Keep the out-of-range octet when sanitizing address fixtures.
            ["connectionIpv4": "10.240.20.999"],
            ["transport": "arbitrary"],
            ["serverCertificateSha256": "invalid"],
            ["serverCertificatePem": certificate + "PRIVATE KEY"],
            ["executable": "/tmp/Moonlight"],
        ] {
            #expect(HivraNativeDesktopLaunchRequest.parse(launch.merging(changed) { _, new in new }) == nil)
        }
    }

    @Test("matches only the configured web origin")
    func nativeDesktopOriginContract() throws {
        let origin = try #require(HivraTrustedWebOrigin(URL(string: "https://canary.hermesos.cloud/dashboard")!))
        #expect(origin.matches(scheme: "https", host: "CANARY.HERMESOS.CLOUD", port: 0))
        #expect(!origin.matches(scheme: "http", host: "canary.hermesos.cloud", port: 0))
        #expect(!origin.matches(scheme: "https", host: "evil.hermesos.cloud", port: 0))
        #expect(!origin.matches(scheme: "https", host: "canary.hermesos.cloud", port: 8443))
        #expect(HivraTrustedWebOrigin(URL(string: "file:///tmp/page")!) == nil)
        #expect(HivraTrustedWebOrigin(URL(string: "https://user@example.com")!) == nil)
    }

    @Test("does not present deliberate navigation cancellations as connection failures")
    func ignoresDeliberateNavigationCancellation() {
        #expect(!HivraNavigationErrorPolicy.shouldPresent(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        ))
        #expect(!HivraNavigationErrorPolicy.shouldPresent(
            NSError(domain: "WebKitErrorDomain", code: 102)
        ))
    }

    @Test("presents a real connection failure")
    func presentsConnectionFailure() {
        #expect(HivraNavigationErrorPolicy.shouldPresent(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        ))
    }
}

@Suite("App identity")
struct HivraAppIdentityTests {
    @Test("the user agent carries the Hivra bundle's short version")
    func bundleVersion() {
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: [
            "CFBundleIdentifier": "cloud.hivra.mac.alpha", "CFBundleShortVersionString": "0.2.1",
        ]) == "HivraMac/0.2.1")
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: [
            "CFBundleIdentifier": "cloud.hivra.mac", "CFBundleShortVersionString": "1.0.0-beta.2",
        ]) == "HivraMac/1.0.0-beta.2")
    }

    @Test("unbundled builds and foreign bundles report a development version")
    func developmentFallback() {
        let fallback = "HivraMac/\(HivraAppIdentity.developmentVersion)"
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: nil) == fallback)
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: [
            "CFBundleIdentifier": "com.apple.dt.xctest.tool", "CFBundleShortVersionString": "16.0",
        ]) == fallback)
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: [
            "CFBundleIdentifier": "cloud.hivra.macevil", "CFBundleShortVersionString": "9.9",
        ]) == fallback)
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: [
            "CFBundleIdentifier": "cloud.hivra.mac.alpha", "CFBundleShortVersionString": "1.0 (Safari) x",
        ]) == fallback)
        #expect(HivraAppIdentity.userAgentApplicationName(infoDictionary: ["CFBundleIdentifier": "cloud.hivra.mac.alpha"]) == fallback)
    }
}
