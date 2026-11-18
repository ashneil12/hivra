import Foundation
import Testing

@testable import HivraMacCore

@Suite("Browser sign-in")
struct HivraBrowserSignInTests {
    let connection = URL(string: "https://hivra.cloud/dashboard")!

    @Test("the challenge matches the website's (RFC 7636 example)")
    func challengeMatchesRFC() {
        #expect(HivraBrowserSignIn.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test("a fresh request has a long verifier and state")
    func freshRequest() {
        let request = HivraBrowserSignIn.Request.make()
        #expect(request.verifier.count == 43)
        #expect(request.state.count == 32)
        #expect(request.challenge.count == 43)
        #expect(HivraBrowserSignIn.Request.make() != request)
    }

    @Test("opens the browser page on the connection's origin")
    func browserURL() throws {
        let request = HivraBrowserSignIn.Request(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "state_value_123456")
        let url = try #require(request.browserURL(connection: connection, intent: .signUp))
        #expect(url.absoluteString == "https://hivra.cloud/desktop/sign-in?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=state_value_123456&intent=sign-up")
        #expect(request.browserURL(connection: URL(string: "file:///tmp/x")!, intent: .signIn) == nil)
    }

    @Test("reads only hivra://auth/callback")
    func callback() {
        let ok = HivraBrowserSignIn.callback(from: URL(string: "hivra://auth/callback?code=abc&state=xyz")!)
        #expect(ok == HivraBrowserSignIn.Callback(code: "abc", state: "xyz"))
        #expect(HivraBrowserSignIn.callback(from: URL(string: "hivra://auth/callback?code=abc")!) == nil)
        #expect(HivraBrowserSignIn.callback(from: URL(string: "hivra://other/callback?code=abc&state=xyz")!) == nil)
        #expect(HivraBrowserSignIn.callback(from: URL(string: "https://auth/callback?code=abc&state=xyz")!) == nil)
    }

    @Test("builds the exchange and finish addresses")
    func addresses() {
        #expect(HivraBrowserSignIn.exchangeURL(connection: connection)?.absoluteString == "https://hivra.cloud/api/desktop/session")
        #expect(HivraBrowserSignIn.finishURL(connection: connection, ticket: "t+1")?.absoluteString == "https://hivra.cloud/desktop/finish?ticket=t%2B1")
    }

    @Test("reads the ticket from the server's answer")
    func ticket() {
        #expect(HivraBrowserSignIn.ticket(fromResponse: Data(#"{"success":true,"data":{"ticket":"abc"}}"#.utf8)) == "abc")
        #expect(HivraBrowserSignIn.ticket(fromResponse: Data(#"{"success":false,"error":"x"}"#.utf8)) == nil)
    }

    @Test("spots the website's sign-in pages on the same origin only")
    func signInPages() {
        #expect(HivraBrowserSignIn.isSignInPage(URL(string: "https://hivra.cloud/sign-in?redirect_url=%2Fdashboard")!, connection: connection))
        #expect(HivraBrowserSignIn.isSignInPage(URL(string: "https://hivra.cloud/sign-up/verify")!, connection: connection))
        #expect(!HivraBrowserSignIn.isSignInPage(URL(string: "https://hivra.cloud/dashboard")!, connection: connection))
        #expect(!HivraBrowserSignIn.isSignInPage(URL(string: "https://evil.example/sign-in")!, connection: connection))
    }
}
