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
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color(red: 1, green: 0.25, blue: 0.27))

            VStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                if let address {
                    Text(address)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            }

            actions()
        }
        .padding(38)
        .foregroundStyle(Color(recovery: HivraRecoveryAppearance.text))
        .background(Color(recovery: HivraRecoveryAppearance.card), in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        }
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
            .buttonStyle(.borderedProminent)
            .tint(Color(recovery: HivraRecoveryAppearance.primaryAction))
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
                    .foregroundStyle(HivraDesign.foreground(for: scheme))
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
                    .foregroundStyle(HivraDesign.crimson)
                Text("Couldn’t download \(notice.filename)")
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
            }
            Button { browser.dismissDownloadNotice() } label: { Image(systemName: "xmark") }
                .buttonStyle(HivraChromeButtonStyle())
                .help("Dismiss")
                .accessibilityLabel("Dismiss download notice")
        }
        .font(.system(size: 12))
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(maxWidth: 520)
        .background(HivraDesign.surface(for: scheme))
        .overlay { Rectangle().stroke(HivraDesign.border(for: scheme), lineWidth: 1) }
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("download-notice")
    }
}
