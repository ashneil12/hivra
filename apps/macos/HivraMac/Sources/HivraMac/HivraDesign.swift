import AppKit
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

/// Hivra Glass (docs/brand/HIVRA-GLASS.md): one ink over one base, frosted
/// panels over a soft haze. Every neutral is the ink at some strength, so a view
/// built on these works in both themes. Hivra red is for the mark and for
/// destructive actions and errors only; green, amber and red are status.
enum HivraDesign {
    // MARK: Theme inputs

    /// The base: hsl(240 0% 97%) light, hsl(240 0% 9%) dark.
    static func background(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.09) : Color(white: 0.97)
    }

    /// The ink: hsl(240 0% 14%) light, hsl(240 0% 92%) dark.
    static func foreground(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.92) : Color(white: 0.14)
    }

    // MARK: Text

    static func text(for scheme: ColorScheme) -> Color { foreground(for: scheme) }
    static func secondaryText(for scheme: ColorScheme) -> Color { foreground(for: scheme).opacity(0.68) }
    static func mutedText(for scheme: ColorScheme) -> Color { foreground(for: scheme).opacity(0.46) }

    // MARK: Strokes and fills (ink at a strength)

    enum Stroke { case subtle, regular, strong }
    static func stroke(_ weight: Stroke = .regular, for scheme: ColorScheme) -> Color {
        let ink = foreground(for: scheme)
        switch weight {
        case .subtle: return ink.opacity(0.06)
        case .regular: return ink.opacity(0.09)
        case .strong: return ink.opacity(0.16)
        }
    }

    /// The regular hairline.
    static func border(for scheme: ColorScheme) -> Color { stroke(.regular, for: scheme) }

    enum Fill { case one, two, three, hover }
    static func fill(_ weight: Fill, for scheme: ColorScheme) -> Color {
        let ink = foreground(for: scheme)
        switch weight {
        case .one: return ink.opacity(0.04)
        case .two: return ink.opacity(0.07)
        case .three: return ink.opacity(0.11)
        case .hover: return ink.opacity(0.09)
        }
    }

    /// An opaque surface (ink at 3% over the base) for when nothing may show through.
    static func surface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.09 + (0.92 - 0.09) * 0.03) : Color(white: 0.97 - (0.97 - 0.14) * 0.03)
    }

    /// The translucent tint laid over a frosted panel (the base at 62%, 58% dark).
    static func glassTint(for scheme: ColorScheme, strong: Bool = false) -> Color {
        background(for: scheme).opacity(strong ? (scheme == .dark ? 0.84 : 0.82) : (scheme == .dark ? 0.58 : 0.62))
    }

    // MARK: Meaningful colour

    /// Hivra red: the mark, destructive actions and errors. Never selection or tint.
    static func brand(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 1, green: 0.227, blue: 0.231) : Color(red: 1, green: 0.173, blue: 0.176)
    }

    static func ok(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.204, green: 0.827, blue: 0.6) : Color(red: 0.086, green: 0.639, blue: 0.29)
    }

    static func warn(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.984, green: 0.749, blue: 0.141) : Color(red: 0.718, green: 0.475, blue: 0.122)
    }

    /// Errors and destructive actions.
    static func bad(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.973, green: 0.443, blue: 0.443) : Color(red: 0.863, green: 0.149, blue: 0.149)
    }

    // MARK: Shape and motion

    enum Radius {
        static let xs: CGFloat = 4
        static let control: CGFloat = 7
        static let card: CGFloat = 10
        static let panel: CGFloat = 14
        static let dialog: CGFloat = 20
    }

    enum Motion {
        static let fast = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.12)
        static let medium = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.2)
    }

    // MARK: Type

    /// Display headings: the system face, semibold, tracked slightly tight.
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }
    static func displayTracking(_ size: CGFloat) -> CGFloat { -0.025 * size }
}

// MARK: - Window background: real translucency plus the ambient haze

/// AppKit's behind-window blur, so the window's own glass shows the desktop.
struct HivraVisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .underWindowBackground
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.state = .followsWindowActiveState
        view.material = material
        view.blendingMode = blending
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blending
    }
}

/// The soft pale blue, rose and lavender haze painted behind the glass.
struct HivraHaze: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let span = max(size.width, size.height)
            ZStack {
                blob(scheme == .dark ? (215, 0.45, 0.55, 0.16) : (220, 0.30, 0.70, 0.22),
                     diameter: span * 0.62, at: CGPoint(x: size.width * 0.14, y: size.height * 0.08))
                blob(scheme == .dark ? (352, 0.55, 0.55, 0.09) : (350, 0.40, 0.72, 0.14),
                     diameter: span * 0.48, at: CGPoint(x: size.width * 0.86, y: size.height * 0.18))
                blob(scheme == .dark ? (265, 0.30, 0.60, 0.10) : (260, 0.20, 0.75, 0.16),
                     diameter: span * 0.6, at: CGPoint(x: size.width * 0.60, y: size.height * 0.96))
            }
            .blur(radius: 60)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// hsl(h s l) at an alpha, as a radial blob.
    private func blob(_ hsla: (Double, Double, Double, Double), diameter: CGFloat, at center: CGPoint) -> some View {
        let color = Color(hsl: hsla.0, hsla.1, hsla.2).opacity(hsla.3)
        return Circle()
            .fill(RadialGradient(colors: [color, color.opacity(0)], center: .center, startRadius: 0, endRadius: diameter / 2))
            .frame(width: diameter, height: diameter)
            .position(center)
    }
}

/// The window's floor: AppKit translucency, the base tint and the haze.
struct HivraWindowBackground: View {
    @Environment(\.colorScheme) private var scheme
    var tintStrength: Double = 0.78

    var body: some View {
        ZStack {
            HivraVisualEffect()
            HivraDesign.background(for: scheme).opacity(tintStrength)
            HivraHaze()
        }
        .ignoresSafeArea()
    }
}

extension Color {
    /// A colour from CSS-style hsl(h s% l%).
    init(hsl hue: Double, _ saturation: Double, _ lightness: Double) {
        let brightness = lightness + saturation * min(lightness, 1 - lightness)
        let hsbSaturation = brightness == 0 ? 0 : 2 * (1 - lightness / brightness)
        self.init(hue: hue / 360, saturation: hsbSaturation, brightness: brightness)
    }
}

// MARK: - Glass panels and cards

private struct HivraGlassModifier: ViewModifier {
    let cornerRadius: CGFloat
    let strong: Bool
    let shadow: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background { frosted(shape) }
            .overlay { shape.strokeBorder(HivraDesign.stroke(.regular, for: scheme), lineWidth: 1).allowsHitTesting(false) }
            .overlay {
                // The top highlight that catches the light on a glass edge.
                shape.strokeBorder(
                    LinearGradient(colors: [Color.white.opacity(scheme == .dark ? 0.07 : 0.55), .clear],
                                   startPoint: .top, endPoint: .center),
                    lineWidth: 1
                )
                .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(shadow ? (scheme == .dark ? 0.45 : 0.10) : 0), radius: shadow ? 18 : 0, y: shadow ? 8 : 0)
    }

    @ViewBuilder private func frosted(_ shape: RoundedRectangle) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26, *) {
            shape.fill(HivraDesign.glassTint(for: scheme, strong: strong).opacity(0.55))
                .glassEffect(.regular, in: shape)
        } else {
            materialFallback(shape)
        }
        #else
        materialFallback(shape)
        #endif
    }

    private func materialFallback(_ shape: RoundedRectangle) -> some View {
        ZStack {
            shape.fill(strong ? Material.regularMaterial : Material.ultraThinMaterial)
            shape.fill(HivraDesign.glassTint(for: scheme, strong: strong))
        }
    }
}

private struct HivraCardModifier: ViewModifier {
    let cornerRadius: CGFloat
    let fill: HivraDesign.Fill
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(HivraDesign.fill(fill, for: scheme), in: shape)
            .overlay { shape.strokeBorder(HivraDesign.stroke(.regular, for: scheme), lineWidth: 1).allowsHitTesting(false) }
    }
}

extension View {
    /// A frosted glass panel: system Liquid Glass on macOS 26, materials before.
    func hivraGlass(cornerRadius: CGFloat = HivraDesign.Radius.panel, strong: Bool = false, shadow: Bool = true) -> some View {
        modifier(HivraGlassModifier(cornerRadius: cornerRadius, strong: strong, shadow: shadow))
    }

    /// A quiet card: an ink fill with a hairline edge.
    func hivraCard(cornerRadius: CGFloat = HivraDesign.Radius.panel, fill: HivraDesign.Fill = .one) -> some View {
        modifier(HivraCardModifier(cornerRadius: cornerRadius, fill: fill))
    }

    /// A search-style field: rounded, a faint fill and a hairline.
    func hivraField() -> some View {
        modifier(HivraCardModifier(cornerRadius: HivraDesign.Radius.card, fill: .one))
    }
}

// MARK: - Brand and headings

/// The approved Hivra mark (the app icon) beside the name.
struct HivraWordmark: View {
    var markSize: CGFloat = 22

    var body: some View {
        HStack(spacing: 9) {
            HivraMark(size: markSize)
            Text("Hivra")
                .font(.system(size: 15, weight: .semibold))
                .tracking(-0.3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Hivra")
    }
}

/// The app icon, which carries the approved mark; never redrawn here.
struct HivraMark: View {
    var size: CGFloat = 22

    var body: some View {
        Image(nsImage: NSApplication.shared.applicationIconImage ?? NSImage())
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A small uppercase section label: the sans face, never monospace.
struct HivraLabel: View {
    let text: String
    @Environment(\.colorScheme) private var scheme

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10.5, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(HivraDesign.mutedText(for: scheme))
    }
}

struct HivraSheetHeader: View {
    let eyebrow: String
    let title: String
    let detail: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HivraLabel(eyebrow)
            Text(title)
                .font(HivraDesign.display(22))
                .tracking(HivraDesign.displayTracking(22))
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(.system(size: 13))
                .foregroundStyle(HivraDesign.secondaryText(for: scheme))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Buttons

struct HivraButtonStyle: ButtonStyle {
    enum Emphasis { case primary, secondary, destructive }
    var emphasis: Emphasis = .secondary

    init(_ emphasis: Emphasis = .secondary) {
        self.emphasis = emphasis
    }

    func makeBody(configuration: Configuration) -> some View {
        HivraButtonBody(configuration: configuration, emphasis: emphasis)
    }
}

private struct HivraButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let emphasis: HivraButtonStyle.Emphasis
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: HivraDesign.Radius.control, style: .continuous)
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .padding(.horizontal, 13)
            .frame(minHeight: 32)
            .foregroundStyle(foreground)
            .background(background, in: shape)
            .overlay { shape.strokeBorder(stroke, lineWidth: 1) }
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .contentShape(shape)
            .onHover { hovering = $0 }
            .animation(HivraDesign.Motion.fast, value: hovering)
            .animation(HivraDesign.Motion.fast, value: configuration.isPressed)
    }

    private var foreground: Color {
        switch emphasis {
        case .primary: HivraDesign.background(for: scheme)
        case .secondary: HivraDesign.foreground(for: scheme)
        case .destructive: HivraDesign.bad(for: scheme)
        }
    }

    private var background: Color {
        switch emphasis {
        case .primary:
            HivraDesign.foreground(for: scheme).opacity(hovering && isEnabled ? 0.86 : 1)
        case .secondary, .destructive:
            HivraDesign.fill(hovering && isEnabled ? .hover : .two, for: scheme)
        }
    }

    private var stroke: Color {
        switch emphasis {
        case .primary: .clear
        case .secondary: HivraDesign.stroke(.regular, for: scheme)
        case .destructive: HivraDesign.bad(for: scheme).opacity(0.35)
        }
    }
}

/// Square icon buttons in the window chrome.
struct HivraChromeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HivraChromeButtonBody(configuration: configuration)
    }
}

private struct HivraChromeButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: HivraDesign.Radius.control, style: .continuous)
        configuration.label
            .font(.system(size: 13))
            .foregroundStyle(hovering ? HivraDesign.foreground(for: scheme) : HivraDesign.secondaryText(for: scheme))
            .frame(width: 28, height: 28)
            .background(configuration.isPressed ? HivraDesign.fill(.three, for: scheme)
                            : hovering ? HivraDesign.fill(.hover, for: scheme) : .clear, in: shape)
            .contentShape(shape)
            .onHover { hovering = $0 }
            .animation(HivraDesign.Motion.fast, value: hovering)
    }
}

/// A row in a list or the sidebar: a rounded fill when selected or hovered.
struct HivraRowStyle: ButtonStyle {
    var selected = false
    var height: CGFloat = 30

    func makeBody(configuration: Configuration) -> some View {
        HivraRowBody(configuration: configuration, selected: selected, height: height)
    }
}

private struct HivraRowBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let height: CGFloat
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: HivraDesign.Radius.control, style: .continuous)
        configuration.label
            .foregroundStyle(selected || hovering ? HivraDesign.foreground(for: scheme) : HivraDesign.secondaryText(for: scheme))
            .frame(minHeight: height)
            .background(fill, in: shape)
            .contentShape(shape)
            .onHover { hovering = $0 }
            .animation(HivraDesign.Motion.fast, value: hovering)
    }

    private var fill: Color {
        if configuration.isPressed || selected { return HivraDesign.fill(.three, for: scheme) }
        return hovering ? HivraDesign.fill(.one, for: scheme) : .clear
    }
}
