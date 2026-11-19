import CryptoKit
import Foundation
import Security

/// Signing in through the person's own browser.
///
/// Google and some other sign-in providers refuse to run inside an app's web
/// view, so the app opens `/desktop/sign-in` in the default browser with the
/// SHA-256 of a random verifier, and the website sends the browser back to
/// `hivra://auth/callback?code=…&state=…`. The app trades the code plus the
/// verifier (which never leaves this process) for a one-time ticket at
/// `/api/desktop/session`, then opens `/desktop/finish?ticket=…` in its own web
/// view. The server side is `dashboard/src/lib/desktop/browser-sign-in.ts`.
public enum HivraBrowserSignIn {
    public static let callbackScheme = "hivra"

    public enum Intent: String, Sendable {
        case signIn = "sign-in"
        case signUp = "sign-up"
    }

    public struct Request: Sendable, Equatable {
        public let verifier: String
        public let state: String
        public var challenge: String { HivraBrowserSignIn.challenge(for: verifier) }

        public init(verifier: String, state: String) {
            self.verifier = verifier
            self.state = state
        }

        /// A fresh verifier (32 random bytes) and state (24 random bytes).
        public static func make() -> Request {
            Request(verifier: randomBase64URL(byteCount: 32), state: randomBase64URL(byteCount: 24))
        }

        /// The page to open in the person's browser, on the connection's origin.
        public func browserURL(connection: URL, intent: Intent) -> URL? {
            guard var components = HivraBrowserSignIn.originComponents(of: connection) else { return nil }
            components.path = "/desktop/sign-in"
            components.queryItems = [
                URLQueryItem(name: "challenge", value: challenge),
                URLQueryItem(name: "state", value: state),
                URLQueryItem(name: "intent", value: intent.rawValue),
            ]
            return components.url
        }
    }

    public struct Callback: Sendable, Equatable {
        public let code: String
        public let state: String
    }

    /// `hivra://auth/callback?code=…&state=…`, or nil for any other address.
    public static func callback(from url: URL) -> Callback? {
        guard url.scheme?.lowercased() == callbackScheme,
              url.host?.lowercased() == "auth",
              url.path == "/callback",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
              let state = items.first(where: { $0.name == "state" })?.value, !state.isEmpty else {
            return nil
        }
        return Callback(code: code, state: state)
    }

    public static func exchangeURL(connection: URL) -> URL? {
        guard var components = originComponents(of: connection) else { return nil }
        components.path = "/api/desktop/session"
        return components.url
    }

    public static func finishURL(connection: URL, ticket: String) -> URL? {
        guard var components = originComponents(of: connection) else { return nil }
        components.path = "/desktop/finish"
        // "+" would read as a space on the server, so only unreserved characters stay as they are.
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        guard let encoded = ticket.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
        components.percentEncodedQuery = "ticket=\(encoded)"
        return components.url
    }

    /// The JSON body the app posts to `exchangeURL`.
    public static func exchangeBody(code: String, verifier: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])) ?? Data()
    }

    /// `{"success":true,"data":{"ticket":"…"}}` → the ticket.
    public static func ticket(fromResponse data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = object["data"] as? [String: Any],
              let ticket = payload["ticket"] as? String, !ticket.isEmpty else {
            return nil
        }
        return ticket
    }

    /// The website's own sign-in or sign-up page on this connection.
    public static func isSignInPage(_ url: URL, connection: URL) -> Bool {
        guard url.scheme?.lowercased() == connection.scheme?.lowercased(),
              url.host?.lowercased() == connection.host?.lowercased(),
              url.port == connection.port else { return false }
        let path = url.path.lowercased()
        return ["/sign-in", "/sign-up"].contains { path == $0 || path.hasPrefix("\($0)/") }
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func originComponents(of url: URL) -> URLComponents? {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components
    }

    static func randomBase64URL(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        precondition(status == errSecSuccess, "No secure random bytes")
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
