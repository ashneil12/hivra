import AppKit
import Combine
import Foundation
import HivraMacCore

enum HivraLocalRuntimeState: Equatable {
    case checkoutNeeded
    case setupNeeded
    case ready
    case checking
    case initializing
    case starting
    case running
    case stopping
    case failed(String)

    var label: String {
        switch self {
        case .checkoutNeeded:
            "Choose source"
        case .setupNeeded:
            "Setup needed"
        case .ready:
            "Stopped"
        case .checking:
            "Checking"
        case .initializing:
            "Setting up"
        case .starting:
            "Starting"
        case .running:
            "Running"
        case .stopping:
            "Stopping"
        case .failed:
            "Needs attention"
        }
    }

    var isBusy: Bool {
        switch self {
        case .checking, .initializing, .starting, .stopping:
            true
        default:
            false
        }
    }
}

@MainActor
final class HivraLocalRuntimeManager: ObservableObject {
    @Published private(set) var checkoutURL: URL?
    @Published private(set) var state: HivraLocalRuntimeState = .checkoutNeeded
    @Published private(set) var output = ""
    @Published private(set) var readyGeneration = 0
    @Published private(set) var credentialsGeneration = 0

    private let defaults: UserDefaults
    private let checkoutKey = "hivra.mac.local-checkout.v1"
    private var operationProcess: Process?
    private var runtimeProcess: Process?
    private var outputPipe: Pipe?
    private var didSignalReady = false
    private let credentialStore = HivraLocalCredentialStore()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        if let saved = defaults.string(forKey: checkoutKey) {
            let candidate = URL(fileURLWithPath: saved, isDirectory: true)
            if HivraLocalInstallation(checkoutURL: candidate).isValidCheckout {
                checkoutURL = candidate
            }
        }

        if checkoutURL == nil {
            checkoutURL = Self.detectBundledCheckout()
        }

        refreshConfigurationState()
    }

    var stateDirectoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".config/hivra", directoryHint: .isDirectory)
    }

    var installation: HivraLocalInstallation? {
        guard let checkoutURL else { return nil }
        let installation = HivraLocalInstallation(checkoutURL: checkoutURL)
        return installation.isValidCheckout ? installation : nil
    }

    var hasConfiguration: Bool {
        FileManager.default.fileExists(
            atPath: stateDirectoryURL.appending(path: "dashboard.env").path
        )
    }

    var savedCredentials: HivraLocalOperatorCredentials? {
        guard hasConfiguration else { return nil }
        return credentialStore.load(stateDirectoryURL: stateDirectoryURL)
    }

    var hasSavedCredentials: Bool {
        savedCredentials != nil
    }

    func chooseCheckout() {
        let panel = NSOpenPanel()
        panel.title = "Choose the Hivra source folder"
        panel.message = "Select the checkout containing dashboard/scripts/hivra-self-host.mjs."
        panel.prompt = "Use this folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let url = panel.url else { return }
        selectCheckout(url)
    }

    func selectCheckout(_ url: URL) {
        let candidate = HivraLocalInstallation(checkoutURL: url)
        guard candidate.isValidCheckout else {
            state = .failed("That folder is not a Hivra checkout.")
            return
        }

        checkoutURL = candidate.checkoutURL
        defaults.set(candidate.checkoutURL.path, forKey: checkoutKey)
        output = ""
        refreshConfigurationState()
    }

    func runDoctor() {
        guard let installation else {
            state = .checkoutNeeded
            return
        }
        state = .checking
        output = ""
        launchOneShot(
            installation.command(for: .doctor, stateDirectory: stateDirectoryURL),
            environment: [:]
        ) { [weak self] success in
            guard let self else { return }
            self.state = success ? (self.hasConfiguration ? .ready : .setupNeeded) : .failed("Local prerequisites are not ready.")
        }
    }

    func initialize(email: String, name: String, password: String) {
        guard let installation else {
            state = .checkoutNeeded
            return
        }
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              password.count >= 12 else {
            state = .failed("Enter an email, name, and password of at least 12 characters.")
            return
        }

        let credentials = HivraLocalOperatorCredentials(email: email, password: password)
        state = .initializing
        output = ""
        launchOneShot(
            installation.command(
                for: .initialize(email: email, name: name),
                stateDirectory: stateDirectoryURL
            ),
            environment: ["HIVRA_SETUP_PASSWORD": password]
        ) { [weak self] success in
            guard let self else { return }
            if success {
                if self.credentialStore.save(credentials, stateDirectoryURL: self.stateDirectoryURL) {
                    self.credentialsGeneration += 1
                } else {
                    self.output += "\nLocal setup succeeded, but automatic sign-in could not be saved to macOS Keychain. Use the local operator credentials manually.\n"
                }
                self.state = .ready
            } else {
                self.state = .failed("Local setup did not complete.")
            }
        }
    }

    func forgetSavedCredentials() {
        if credentialStore.remove(stateDirectoryURL: stateDirectoryURL) {
            credentialsGeneration += 1
        }
    }

    func start() {
        guard let installation else {
            state = .checkoutNeeded
            return
        }
        guard hasConfiguration else {
            state = .setupNeeded
            return
        }
        guard runtimeProcess == nil else { return }

        state = .starting
        output = ""
        didSignalReady = false

        let command = installation.command(for: .start, stateDirectory: stateDirectoryURL)
        let process = configuredProcess(for: command, environment: [:])
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        attachOutput(pipe)
        outputPipe = pipe
        runtimeProcess = process

        process.terminationHandler = { [weak self] process in
            let succeeded = process.terminationStatus == 0
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.detachOutput()
                self.runtimeProcess = nil
                if self.state != .stopping {
                    self.state = succeeded ? .ready : .failed("Local Hivra stopped unexpectedly.")
                }
            }
        }

        do {
            try process.run()
        } catch {
            detachOutput()
            runtimeProcess = nil
            state = .failed(error.localizedDescription)
        }
    }

    func reconcile() {
        guard let installation else {
            state = .checkoutNeeded
            return
        }
        guard hasConfiguration else {
            state = .setupNeeded
            return
        }
        guard operationProcess == nil, runtimeProcess == nil else { return }

        let wasRunning = state == .running
        state = .checking
        output = ""
        let command = installation.command(for: .status, stateDirectory: stateDirectoryURL)
        let process = configuredProcess(for: command, environment: [:])
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        operationProcess = process

        process.terminationHandler = { [weak self] process in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let statusOutput = String(data: data, encoding: .utf8) ?? ""
            let succeeded = process.terminationStatus == 0
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.operationProcess = nil
                self.output = statusOutput
                guard succeeded else {
                    self.state = .failed("Local Hivra status could not be verified.")
                    return
                }
                if HivraLocalInstallation.dashboardIsRunning(statusOutput: statusOutput) {
                    self.state = .running
                    if !wasRunning {
                        self.readyGeneration += 1
                    }
                } else {
                    self.state = .ready
                }
            }
        }

        do {
            try process.run()
        } catch {
            operationProcess = nil
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        guard let installation else { return }
        state = .stopping
        launchOneShot(
            installation.command(for: .stop, stateDirectory: stateDirectoryURL),
            environment: [:]
        ) { [weak self] success in
            guard let self else { return }
            self.state = success ? .ready : .failed("Local Hivra could not be stopped cleanly.")
        }
    }

    func cancelOperation() {
        operationProcess?.terminate()
    }

    private func refreshConfigurationState() {
        guard installation != nil else {
            state = .checkoutNeeded
            return
        }
        state = hasConfiguration ? .ready : .setupNeeded
    }

    private func launchOneShot(
        _ command: HivraLocalProcessCommand,
        environment: [String: String],
        completion: @escaping @MainActor (Bool) -> Void
    ) {
        guard operationProcess == nil else { return }
        let process = configuredProcess(for: command, environment: environment)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        attachOutput(pipe)
        outputPipe = pipe
        operationProcess = process

        process.terminationHandler = { [weak self] process in
            let succeeded = process.terminationStatus == 0
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.detachOutput()
                self.operationProcess = nil
                completion(succeeded)
            }
        }

        do {
            try process.run()
        } catch {
            detachOutput()
            operationProcess = nil
            state = .failed(error.localizedDescription)
        }
    }

    private func configuredProcess(
        for command: HivraLocalProcessCommand,
        environment additions: [String: String]
    ) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command.executableName] + command.arguments
        process.currentDirectoryURL = command.workingDirectory

        var environment = ProcessInfo.processInfo.environment
        let existingPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(existingPath)"
        for (key, value) in additions {
            environment[key] = value
        }
        process.environment = environment
        return process
    }

    private func attachOutput(_ pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                self?.consumeOutput(text)
            }
        }
    }

    private func detachOutput() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
    }

    private func consumeOutput(_ text: String) {
        output += text
        if output.count > 20_000 {
            output = String(output.suffix(20_000))
        }

        if !didSignalReady, text.contains("OPEN   http://127.0.0.1:3000") {
            didSignalReady = true
            state = .running
            readyGeneration += 1
        }
    }

    private static func detectBundledCheckout() -> URL? {
        var candidate = Bundle.main.bundleURL
        for _ in 0..<8 {
            candidate.deleteLastPathComponent()
            let installation = HivraLocalInstallation(checkoutURL: candidate)
            if installation.isValidCheckout {
                return candidate
            }
        }
        return nil
    }
}
