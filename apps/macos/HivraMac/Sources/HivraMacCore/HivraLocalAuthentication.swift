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

        public var errorDescription: String? {
            switch self {
            case .unsupportedOrigin:
                "Automatic local sign-in is available only for a loopback Hivra installation."
            }
        }
    }

    public static let sessionCookieName = "hivra_operator_session"
    public static let managedDashboardOrigin = URL(string: "http://127.0.0.1:3000")!

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

    public static func loginRequest(
        dashboardURL: URL,
        credentials: HivraLocalOperatorCredentials
    ) throws -> URLRequest {
        guard supportsAutomaticSignIn(to: dashboardURL),
              var components = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false) else {
            throw RequestError.unsupportedOrigin
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
