import Foundation
import Testing

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
            credentials: credentials
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
