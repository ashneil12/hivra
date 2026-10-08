import Testing

@testable import HivraMacCore

@Suite("Page activation")
struct HivraPageActivationTests {
    private let page = "canary.hermesos.cloud"

    private func refused(_ decision: HivraPageActivation.Decision) -> Bool {
        if case .refuse = decision { return true }
        return false
    }

    @Test("a page downloads once on its own and once per input, then asks once per origin")
    func downloadAllowance() {
        var activation = HivraPageActivation()
        activation.documentCommitted(input: 0)
        func download(_ requester: String = "canary.hermesos.cloud", input: UInt64) -> HivraPageActivation.Decision {
            activation.download(requester: requester, fromMainFrame: true, fromConnectionOrigin: true, input: input)
        }
        #expect(download(input: 0) == .allow)
        #expect(download(input: 0) == .ask)
        activation.recordDownloadAnswer(false, requester: page, document: activation.document)
        #expect(refused(download(input: 0)), "a declined page downloaded again")
        // Each answer belongs to the origin that was asked about.
        #expect(download("docs.example.com", input: 0) == .ask)
        // The user's input is a new allowance, spent by one download.
        #expect(download(input: 1) == .allow)
        #expect(refused(download(input: 1)), "one input allowed two downloads")
        activation.recordDownloadAnswer(true, requester: page, document: activation.document)
        #expect(download(input: 1) == .allow)
    }

    @Test("a new document starts afresh and ignores answers asked for the last one")
    func documentsStartAfresh() {
        var activation = HivraPageActivation()
        activation.documentCommitted(input: 0)
        _ = activation.download(requester: page, fromMainFrame: true, fromConnectionOrigin: true, input: 0)
        #expect(activation.download(requester: page, fromMainFrame: true, fromConnectionOrigin: true, input: 0) == .ask)
        let earlier = activation.document
        // The click that navigated is spent by the navigation.
        activation.documentCommitted(input: 3)
        activation.recordDownloadAnswer(false, requester: page, document: earlier)
        #expect(activation.download(requester: page, fromMainFrame: true, fromConnectionOrigin: true, input: 3) == .allow)
        #expect(activation.download(requester: page, fromMainFrame: true, fromConnectionOrigin: true, input: 3) == .ask)
    }

    @Test("frames from another origin download only right after input, and are never asked about")
    func crossOriginFrames() {
        var activation = HivraPageActivation()
        activation.documentCommitted(input: 0)
        func frame(input: UInt64) -> HivraPageActivation.Decision {
            activation.download(requester: "ads.example", fromMainFrame: false, fromConnectionOrigin: false, input: input)
        }
        #expect(refused(frame(input: 0)), "a cross-origin frame downloaded without input")
        #expect(frame(input: 1) == .allow)
        #expect(refused(frame(input: 1)), "one input allowed two frame downloads")
        // A frame on the connection's origin is the page's own: allowed once without input, then asked about.
        var own = HivraPageActivation()
        own.documentCommitted(input: 0)
        #expect(own.download(requester: page, fromMainFrame: false, fromConnectionOrigin: true, input: 0) == .allow)
        #expect(own.download(requester: page, fromMainFrame: false, fromConnectionOrigin: true, input: 0) == .ask)
    }

    @Test("the connection opens apps on the user's input; anything else asks, one question at a time")
    func appOpens() {
        var activation = HivraPageActivation()
        activation.documentCommitted(input: 0)
        #expect(activation.openApp(fromConnectionOrigin: true, input: 1) == .allow)
        // The same input cannot open another app silently.
        #expect(activation.openApp(fromConnectionOrigin: true, input: 1) == .ask)
        #expect(refused(activation.openApp(fromConnectionOrigin: true, input: 2)), "a second question stacked on the first")
        activation.appOpenAnswered(blockingFurther: false, document: activation.document)
        // Another site asks even right after input, and spends it.
        #expect(activation.openApp(fromConnectionOrigin: false, input: 3) == .ask)
        activation.appOpenAnswered(blockingFurther: true, document: activation.document)
        #expect(refused(activation.openApp(fromConnectionOrigin: true, input: 4)), "a blocked page opened an app")
        activation.documentCommitted(input: 4)
        #expect(activation.openApp(fromConnectionOrigin: true, input: 5) == .allow)
    }
}
