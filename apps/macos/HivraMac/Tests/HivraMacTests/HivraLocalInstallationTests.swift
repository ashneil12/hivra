import Foundation
import Testing

@testable import HivraMac
@testable import HivraMacCore

@Suite("Local Hivra installation")
struct HivraLocalInstallationTests {
    @Test("builds local sign-in as a loopback POST without URL credentials")
    func buildsLocalSignInRequest() throws {
        let dashboard = URL(string: "http://127.0.0.1:3000/dashboard")!
        let credentials = HivraLocalOperatorCredentials(
            email: " Ash@Example.com ",
            password: "correct horse battery staple"
        )

        let request = try HivraLocalAuthentication.loginRequest(
            dashboardURL: dashboard,
            credentials: credentials,
            runtimeIsVerified: { true }
        )

        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "http://127.0.0.1:3000/api/self-host/auth/login")
        #expect(!request.url!.absoluteString.contains(credentials.password))
        let body = try #require(request.httpBody)
        let decoded = try JSONDecoder().decode(HivraLocalOperatorCredentials.self, from: body)
        #expect(decoded.email == "ash@example.com")
        #expect(decoded.password == credentials.password)
        #expect(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:3000")
    }

    @Test("binds automatic sign-in to the managed local runtime origin")
    func rejectsUnmanagedAutomaticSignIn() {
        let credentials = HivraLocalOperatorCredentials(
            email: "ash@example.com",
            password: "correct horse battery staple"
        )

        #expect(throws: HivraLocalAuthentication.RequestError.self) {
            try HivraLocalAuthentication.loginRequest(
                dashboardURL: URL(string: "https://canary.hermesos.cloud/dashboard")!,
                credentials: credentials
            )
        }
        #expect(HivraLocalAuthentication.supportsAutomaticSignIn(
            to: URL(string: "http://127.0.0.1:3000/dashboard")!
        ))
        #expect(!HivraLocalAuthentication.supportsAutomaticSignIn(
            to: URL(string: "http://localhost:3000/dashboard")!
        ))
        #expect(!HivraLocalAuthentication.supportsAutomaticSignIn(
            to: URL(string: "http://127.0.0.1:3001/dashboard")!
        ))
    }

    @Test("never builds a login request for a port the launched runtime does not own")
    func refusesUnverifiedRuntime() {
        let credentials = HivraLocalOperatorCredentials(
            email: "ash@example.com",
            password: "correct horse battery staple"
        )
        let dashboard = URL(string: "http://127.0.0.1:3000/dashboard")!

        #expect(throws: HivraLocalAuthentication.RequestError.runtimeNotVerified) {
            try HivraLocalAuthentication.loginRequest(
                dashboardURL: dashboard,
                credentials: credentials,
                runtimeIsVerified: { false }
            )
        }
    }

    @Test("accepts a port listener only when it descends from the launched runtime")
    func requiresRuntimeAncestry() {
        // 100 is the launched runtime; 200 is its npm child; 300 is the dashboard under it.
        let parents: [Int32: Int32] = [300: 200, 200: 100, 100: 1, 500: 1]

        #expect(HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [300], rootPID: 100, parentOf: parents))
        #expect(HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [100], rootPID: 100, parentOf: parents))
        #expect(!HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [500], rootPID: 100, parentOf: parents))
        #expect(!HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [300, 500], rootPID: 100, parentOf: parents))
        #expect(!HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [], rootPID: 100, parentOf: parents))
        #expect(!HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [999], rootPID: 100, parentOf: parents))
        #expect(!HivraLocalAuthentication.isOwnedByRuntime(listenerPIDs: [700], rootPID: 100, parentOf: [700: 800, 800: 700]))
    }

    @Test("runs only a launcher at the expected path that the user owns and nobody else can write")
    func trustsOnlyTheExpectedLauncher() throws {
        let root = try makeCheckout()
        defer { try? FileManager.default.removeItem(at: root) }
        let installation = HivraLocalInstallation(checkoutURL: root)
        #expect(HivraLocalLauncherTrust.isTrusted(installation))

        let launcher = installation.launcherURL
        let scripts = launcher.deletingLastPathComponent()

        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: launcher.path)
        #expect(!HivraLocalLauncherTrust.isTrusted(installation))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: launcher.path)

        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: scripts.path)
        #expect(!HivraLocalLauncherTrust.isTrusted(installation))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scripts.path)

        // A launcher that is a symlink to code elsewhere is not the expected file.
        let elsewhere = root.appending(path: "elsewhere.mjs")
        try Data().write(to: elsewhere)
        try FileManager.default.removeItem(at: launcher)
        try FileManager.default.createSymbolicLink(at: launcher, withDestinationURL: elsewhere)
        #expect(!HivraLocalLauncherTrust.isTrusted(installation))
    }

    private func makeCheckout() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "hivra-launcher-trust-\(UUID().uuidString)")
        let scripts = root.appending(path: "dashboard/scripts")
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        let launcher = scripts.appending(path: "hivra-self-host.mjs")
        try Data().write(to: launcher)
        for path in [root.path, root.appending(path: "dashboard").path, scripts.path] {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: launcher.path)
        return root
    }

    @Test("rejects a login response from a redirected URL")
    func rejectsRedirectedLoginResponse() {
        let requestURL = URL(string: "http://127.0.0.1:3000/api/self-host/auth/login")!

        #expect(HivraLocalAuthentication.isExpectedLoginResponse(requestURL, for: requestURL))
        #expect(!HivraLocalAuthentication.isExpectedLoginResponse(
            URL(string: "https://example.com/collect")!,
            for: requestURL
        ))
    }

    @Test("recognizes only a reachable installation-owned dashboard")
    func recognizesDashboardStatus() {
        #expect(HivraLocalInstallation.dashboardIsRunning(statusOutput: "database: up\ndashboard: up\ndashboard process: up\n"))
        #expect(!HivraLocalInstallation.dashboardIsRunning(statusOutput: "dashboard: up\ndashboard process: mismatch\n"))
        #expect(!HivraLocalInstallation.dashboardIsRunning(statusOutput: "dashboard: down\ndashboard process: up\npublic callback: up\n"))
        #expect(!HivraLocalInstallation.dashboardIsRunning(statusOutput: "dashboard: unhealthy (503)\ndashboard process: up\n"))
    }

    @Test("recognizes a checkout by its existing self-host launcher")
    func recognizesCheckout() throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "hivra-local-installation-\(UUID().uuidString)")
        let scripts = root.appending(path: "dashboard/scripts")
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        try Data().write(to: scripts.appending(path: "hivra-self-host.mjs"))
        defer { try? FileManager.default.removeItem(at: root) }

        let installation = HivraLocalInstallation(checkoutURL: root)

        #expect(installation.isValidCheckout)
        #expect(installation.dashboardURL.path == root.appending(path: "dashboard").path)
    }

    @Test("builds non-interactive setup arguments without placing the password on the command line")
    func buildsSetupCommand() {
        let root = URL(filePath: "/tmp/hivra-checkout", directoryHint: .isDirectory)
        let state = URL(filePath: "/tmp/hivra-state", directoryHint: .isDirectory)
        let installation = HivraLocalInstallation(checkoutURL: root)

        let command = installation.command(
            for: .initialize(email: "ash@example.com", name: "Ash"),
            stateDirectory: state
        )

        #expect(command.executableName == "node")
        #expect(command.arguments == [
            root.appending(path: "dashboard/scripts/hivra-self-host.mjs").path,
            "init",
            "--email", "ash@example.com",
            "--name", "Ash",
            "--state-dir", state.path,
        ])
        #expect(!command.arguments.joined(separator: " ").contains("password"))
    }

    @Test("keeps start and stop bound to the selected installation state")
    func bindsLifecycleCommands() {
        let root = URL(filePath: "/tmp/hivra-checkout", directoryHint: .isDirectory)
        let state = URL(filePath: "/tmp/hivra-state", directoryHint: .isDirectory)
        let installation = HivraLocalInstallation(checkoutURL: root)

        #expect(installation.command(for: .start, stateDirectory: state).arguments.suffix(2) == [
            "--state-dir", state.path,
        ])
        #expect(installation.command(for: .stop, stateDirectory: state).arguments.suffix(2) == [
            "--state-dir", state.path,
        ])
    }
}
