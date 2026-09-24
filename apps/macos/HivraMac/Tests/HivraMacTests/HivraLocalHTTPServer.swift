import Foundation
import Network

/// Serves canned responses on 127.0.0.1 so a page can load a cross-origin frame
/// without the network. Every request path is recorded.
final class HivraLocalHTTPServer: @unchecked Sendable {
    struct Response: Sendable {
        var contentType: String
        var headers: [String: String] = [:]
        var body: Data
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "cloud.hivra.mac.tests.http")
    private let lock = NSLock()
    private var recorded: [String] = []
    private let respond: @Sendable (String) -> Response
    private(set) var port: UInt16 = 0

    var origin: URL { URL(string: "http://127.0.0.1:\(port)")! }

    var requests: [String] { lock.withLock { recorded } }

    init(respond: @escaping @Sendable (String) -> Response) async throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        self.respond = respond
        let queue = queue
        let port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            // Handlers run on the serial queue; the first ready or failed state resumes once.
            listener.stateUpdateHandler = { [listener] state in
                let result: Result<UInt16, Error>
                switch state {
                case .ready: result = listener.port.map { .success($0.rawValue) } ?? .failure(URLError(.cannotConnectToHost))
                case .failed(let error): result = .failure(error)
                default: return
                }
                listener.stateUpdateHandler = nil
                continuation.resume(with: result)
            }
            listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
            listener.start(queue: queue)
        }
        self.port = port
    }

    func stop() {
        listener.cancel()
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return connection.cancel() }
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let head = String(data: buffer, encoding: .utf8), head.contains("\r\n\r\n") else {
                if isComplete || error != nil { connection.cancel() } else { receive(on: connection, buffer: buffer) }
                return
            }
            let target = head.split(separator: "\r\n").first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            lock.withLock { recorded.append(target) }
            let response = respond(target)
            var lines = ["HTTP/1.1 200 OK", "Content-Type: \(response.contentType)",
                         "Content-Length: \(response.body.count)", "Connection: close"]
            lines += response.headers.map { "\($0.key): \($0.value)" }
            var payload = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
            payload.append(response.body)
            connection.send(content: payload, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}
