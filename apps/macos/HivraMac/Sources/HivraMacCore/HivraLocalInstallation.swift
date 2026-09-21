import Foundation

public enum HivraLocalAction: Sendable {
    case doctor
    case initialize(email: String, name: String)
    case start
    case status
    case stop
}

public struct HivraLocalProcessCommand: Equatable, Sendable {
    public let executableName: String
    public let arguments: [String]
    public let workingDirectory: URL

    public init(executableName: String, arguments: [String], workingDirectory: URL) {
        self.executableName = executableName
        self.arguments = arguments
        self.workingDirectory = workingDirectory
    }
}

public struct HivraLocalInstallation: Equatable, Sendable {
    public let checkoutURL: URL

    public init(checkoutURL: URL) {
        self.checkoutURL = checkoutURL.standardizedFileURL
    }

    public var dashboardURL: URL {
        checkoutURL.appending(path: "dashboard", directoryHint: .isDirectory)
    }

    public var launcherURL: URL {
        dashboardURL.appending(path: "scripts/hivra-self-host.mjs", directoryHint: .notDirectory)
    }

    public var isValidCheckout: Bool {
        FileManager.default.fileExists(atPath: launcherURL.path)
    }

    public static func dashboardIsRunning(statusOutput: String) -> Bool {
        let lines = statusOutput
            .split(whereSeparator: \Character.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        return lines.contains("dashboard: up") && lines.contains("dashboard process: up")
    }

    public func command(
        for action: HivraLocalAction,
        stateDirectory: URL? = nil
    ) -> HivraLocalProcessCommand {
        var arguments = [launcherURL.path]

        switch action {
        case .doctor:
            arguments.append("doctor")
        case let .initialize(email, name):
            arguments.append(contentsOf: [
                "init",
                "--email", email,
                "--name", name,
            ])
        case .start:
            arguments.append("start")
        case .status:
            arguments.append("status")
        case .stop:
            arguments.append("stop")
        }

        if let stateDirectory {
            arguments.append(contentsOf: ["--state-dir", stateDirectory.standardizedFileURL.path])
        }

        return HivraLocalProcessCommand(
            executableName: "node",
            arguments: arguments,
            workingDirectory: dashboardURL
        )
    }
}
