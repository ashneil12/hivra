import Foundation

public enum HivraNavigationErrorPolicy {
    private static let legacyWebKitErrorDomain = "WebKitErrorDomain"
    private static let frameLoadInterruptedByPolicyChange = 102

    public static func shouldPresent(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
            return false
        }

        // WebKit reports navigation actions deliberately cancelled by a policy
        // decision through this legacy NSError rather than WKError.Code.
        if error.domain == legacyWebKitErrorDomain &&
            error.code == frameLoadInterruptedByPolicyChange {
            return false
        }

        return true
    }
}
