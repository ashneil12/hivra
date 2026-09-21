import SwiftUI

enum HivraAppearance: String, CaseIterable, Identifiable {
    case system, dark, light

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .dark: .dark
        case .light: .light
        }
    }
}

enum HivraDesign {
    static let crimson = Color(red: 1, green: 0.227, blue: 0.231)
    static let cream = Color(red: 0.992, green: 0.988, blue: 0.976)
    static let graphite = Color(red: 0.051, green: 0.051, blue: 0.051)

    static func background(for scheme: ColorScheme) -> Color {
        scheme == .dark ? graphite : cream
    }

    static func surface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.078) : Color(red: 0.965, green: 0.957, blue: 0.937)
    }

    static func foreground(for scheme: ColorScheme) -> Color {
        scheme == .dark ? cream : Color(white: 0.102)
    }

    static func border(for scheme: ColorScheme) -> Color {
        foreground(for: scheme).opacity(0.15)
    }
}

struct HivraWordmark: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text("H.")
                .font(.system(size: 25, weight: .medium, design: .serif))
                .italic()
            Text("HIVRA")
                .font(.system(size: 11, weight: .semibold))
                .tracking(3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Hivra")
    }
}

struct HivraSheetHeader: View {
    let eyebrow: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(eyebrow.uppercased())
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(HivraDesign.crimson)
            Text(title)
                .font(.system(size: 29, weight: .regular, design: .serif))
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct HivraButtonStyle: ButtonStyle {
    enum Emphasis { case primary, secondary, destructive }
    var emphasis: Emphasis = .secondary
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    init(_ emphasis: Emphasis = .secondary) {
        self.emphasis = emphasis
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .foregroundStyle(foreground)
            .background(emphasis == .primary ? HivraDesign.foreground(for: colorScheme) : HivraDesign.surface(for: colorScheme))
            .overlay { Rectangle().stroke(emphasis == .destructive ? HivraDesign.crimson.opacity(0.55) : HivraDesign.border(for: colorScheme), lineWidth: 1) }
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.45)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch emphasis {
        case .primary: HivraDesign.background(for: colorScheme)
        case .secondary: HivraDesign.foreground(for: colorScheme)
        case .destructive: HivraDesign.crimson
        }
    }
}
