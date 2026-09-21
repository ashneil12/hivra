import Foundation
import Testing

@testable import HivraMacCore

struct HivraRecoveryAppearanceTests {
    @Test("recovery text and actions remain readable over their opaque surfaces")
    func recoveryContrast() {
        let text = HivraRecoveryAppearance.text
        let card = HivraRecoveryAppearance.card
        #expect(contrast(text, card) >= 7)
        #expect(contrast(text, HivraRecoveryAppearance.primaryAction) >= 4.5)

        // A conservative dimmed-label approximation guards supporting copy too.
        let secondary: HivraRecoveryAppearance.RGB = (
            card.red + 0.6 * (text.red - card.red),
            card.green + 0.6 * (text.green - card.green),
            card.blue + 0.6 * (text.blue - card.blue)
        )
        #expect(contrast(secondary, card) >= 4.5)
    }

    private func contrast(_ a: HivraRecoveryAppearance.RGB, _ b: HivraRecoveryAppearance.RGB) -> Double {
        func luminance(_ value: HivraRecoveryAppearance.RGB) -> Double {
            func linear(_ component: Double) -> Double {
                component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(value.red) + 0.7152 * linear(value.green) + 0.0722 * linear(value.blue)
        }
        let first = luminance(a), second = luminance(b)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }
}
