import AppKit
import HivraMacCore
import SwiftUI

extension Color {
    init(recovery value: HivraRecoveryAppearance.RGB) {
        self.init(red: value.red, green: value.green, blue: value.blue)
    }
}

/// The opaque recovery card shown over a web view that failed or stopped.
struct HivraRecoveryCard<Actions: View>: View {
    let symbol: String
    let title: String
    let address: String?
    let detail: String
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Color(recovery: HivraRecoveryAppearance.error))

            VStack(spacing: 6) {
                Text(title)
                    .font(HivraDesign.display(19))
                    .tracking(HivraDesign.displayTracking(19))
                    .accessibilityAddTraits(.isHeader)
                if let address {
                    Text(address)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Color(recovery: HivraRecoveryAppearance.text).opacity(0.68))
                }
                Text(detail)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color(recovery: HivraRecoveryAppearance.text).opacity(0.68))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            }

            actions()
        }
        .padding(38)
        .foregroundStyle(Color(recovery: HivraRecoveryAppearance.text))
        .background(Color(recovery: HivraRecoveryAppearance.card), in: RoundedRectangle(cornerRadius: HivraDesign.Radius.dialog, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: HivraDesign.Radius.dialog, style: .continuous)
                .strokeBorder(Color.white.opacity(0.09), lineWidth: 1)
        }
        // The card is always dark so it reads over a blank white failed page;
        // its controls follow suit.
        .environment(\.colorScheme, .dark)
        .padding(32)
    }
}

enum HivraRecoveryCopy {
    static let stoppedTitle = "This page stopped unexpectedly"
    static let stoppedDetail = "Its web content process ended. Reload to continue."
}

/// Recovery for a popup window, which has no connection-specific actions.
struct HivraPopupRecovery: View {
    let failure: HivraBrowserFailure
    let address: String?
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(recovery: HivraRecoveryAppearance.backdrop).ignoresSafeArea()
            switch failure {
            case .contentProcessTerminated:
                HivraRecoveryCard(symbol: "exclamationmark.triangle", title: HivraRecoveryCopy.stoppedTitle,
                                  address: address, detail: HivraRecoveryCopy.stoppedDetail) { retryButton("Reload") }
            case .unreachable(let message):
                HivraRecoveryCard(symbol: "network.slash", title: "This page is not reachable",
                                  address: address, detail: message) { retryButton("Try again") }
            }
        }
    }

    private func retryButton(_ title: String) -> some View {
        Button(title, action: onRetry)
            .buttonStyle(HivraButtonStyle(.primary))
    }
}

/// A transient notice for the latest download from this web view.
struct HivraDownloadBanner: View {
    @ObservedObject var browser: HivraBrowserModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if let notice = browser.downloadNotice {
                banner(notice)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: browser.downloadNotice)
    }

    private func banner(_ notice: HivraDownloadNotice) -> some View {
        HStack(spacing: 10) {
            switch notice.outcome {
            case .finished(let file):
                Image(systemName: "arrow.down.circle")
                    .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                Text("Downloaded \(notice.filename)")
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([file])
                    browser.dismissDownloadNotice()
                }
                .buttonStyle(HivraButtonStyle())
            case .failed:
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(HivraDesign.bad(for: scheme))
                Text("Couldn’t download \(notice.filename)")
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
            }
            Button { browser.dismissDownloadNotice() } label: { Image(systemName: "xmark") }
                .buttonStyle(HivraChromeButtonStyle())
                .help("Dismiss")
                .accessibilityLabel("Dismiss download notice")
        }
        .font(.system(size: 12.5))
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(maxWidth: 520)
        .hivraGlass(cornerRadius: HivraDesign.Radius.panel, strong: true)
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("download-notice")
    }
}
