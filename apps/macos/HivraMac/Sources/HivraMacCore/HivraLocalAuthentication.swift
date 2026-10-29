import Darwin
import Foundation

public struct HivraLocalOperatorCredentials: Codable, Equatable, Sendable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.password = password
    }
}

public enum HivraLocalAuthentication {
    public enum RequestError: LocalizedError {
        case unsupportedOrigin
        case runtimeNotVerified

        public var errorDescription: String? {
            switch self {
            case .unsupportedOrigin:
                "Automatic local sign-in is available only for a loopback Hivra installation."
            case .runtimeNotVerified:
                "Automatic local sign-in is paused: the server on 127.0.0.1:3000 is not the Hivra runtime this app started."
            }
        }
    }

    public static let sessionCookieName = "hivra_operator_session"
    public static let managedDashboardOrigin = URL(string: "http://127.0.0.1:3000")!

    /// The local runtime process this app launched, or nil when it did not launch one.
    /// Set and cleared by HivraLocalRuntimeManager. The operator password is sent only while
    /// this process (or one of its children) owns the managed port.
    public nonisolated(unsafe) static var launchedRuntimeProcessID: Int32? = nil

    public static func supportsAutomaticSignIn(to dashboardURL: URL) -> Bool {
        guard let candidate = origin(of: dashboardURL),
              let managedOrigin = origin(of: managedDashboardOrigin) else {
            return false
        }
        return candidate == managedOrigin
    }

    public static func isExpectedLoginResponse(
        _ responseURL: URL?,
        for requestURL: URL
    ) -> Bool {
        responseURL == requestURL
    }

    /// True only when every process listening on the managed port is the runtime this app launched
    /// or a child of it. Anything else, including a stale or unknown server, gets no password.
    public static func launchedRuntimeOwnsDashboardPort() -> Bool {
        guard let root = launchedRuntimeProcessID, root > 1, kill(root, 0) == 0 else { return false }
        guard let listeners = listeningProcessIDs(port: 3000), !listeners.isEmpty,
              let parents = parentProcessTable() else {
            return false
        }
        return isOwnedByRuntime(listenerPIDs: listeners, rootPID: root, parentOf: parents)
    }

    public static func isOwnedByRuntime(
        listenerPIDs: [Int32],
        rootPID: Int32,
        parentOf: [Int32: Int32]
    ) -> Bool {
        guard rootPID > 1, !listenerPIDs.isEmpty else { return false }
        return listenerPIDs.allSatisfy { listener in
            var current = listener
            for _ in 0..<64 {
                if current == rootPID { return true }
                guard let parent = parentOf[current], parent > 1, parent != current else { return false }
                current = parent
            }
            return false
        }
    }

    public static func loginRequest(
        dashboardURL: URL,
        credentials: HivraLocalOperatorCredentials,
        runtimeIsVerified: () -> Bool = { HivraLocalAuthentication.launchedRuntimeOwnsDashboardPort() }
    ) throws -> URLRequest {
        guard supportsAutomaticSignIn(to: dashboardURL),
              var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else {
            throw RequestError.unsupportedOrigin
        }
        // Checked before the password is encoded, so an unverified server never receives it.
        guard runtimeIsVerified() else {
            throw RequestError.runtimeNotVerified
        }

        components.path = "/api/self-host/auth/login"
        components.query = nil
        components.fragment = nil
        guard let loginURL = components.url else {
            throw RequestError.unsupportedOrigin
        }

        var request = URLRequest(
            url: loginURL,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 12
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(loginURL.origin, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONEncoder().encode(credentials)
        return request
    }

    private static func origin(of url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func listeningProcessIDs(port: Int) -> [Int32]? {
        guard let output = runTool("/usr/sbin/lsof", ["-nP", "-w", "-iTCP@127.0.0.1:\(port)", "-sTCP:LISTEN", "-Fp"]) else {
            return nil
        }
        return output.split(separator: "\n").compactMap { line in
            line.hasPrefix("p") ? Int32(line.dropFirst()) : nil
        }
    }

    private static func parentProcessTable() -> [Int32: Int32]? {
        guard let output = runTool("/bin/ps", ["-axo", "pid=,ppid="]) else { return nil }
        var table: [Int32: Int32] = [:]
        for line in output.split(separator: "\n") {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count == 2, let pid = Int32(fields[0]), let parent = Int32(fields[1]) else { continue }
            table[pid] = parent
        }
        return table.isEmpty ? nil : table
    }

    private static func runTool(_ executable: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}

private extension URL {
    var origin: String {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false) else {
            return absoluteString
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            ?? absoluteString
    }
}
