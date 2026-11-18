import SwiftUI

/// Hivra's activity mark: a dotted, slowly turning globe with a scanning
/// meridian, drawn in the page ink. It replaces spinners for anything loading or
/// waiting. A port of the "searching" globe of the thinking-orbs library the
/// website uses (MIT, Jakub Antalik; `dashboard/src/components/ui/ThinkingOrb.tsx`).
/// Sizes 20, 32 and 64 use the library's tuned presets; other sizes draw from
/// the 64 preset. Reduce Motion shows one still frame.
struct HivraThinkingOrb: View {
    var size: CGFloat = 32
    var label: String = "Loading"
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let preset = HivraOrbPreset.globe(for: size)
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion)) { context in
            Canvas { canvas, canvasSize in
                let t = reduceMotion ? 0.6 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3600) * preset.speed
                for dot in HivraOrbGlobe.frame(size: Double(canvasSize.width), t: t, preset: preset) {
                    let white = min(1, max(0, dot.white))
                    let gray = scheme == .dark ? 1 - white : white
                    let rect = CGRect(x: dot.x - dot.r, y: dot.y - dot.r, width: dot.r * 2, height: dot.r * 2)
                    canvas.fill(Path(ellipseIn: rect), with: .color(Color(white: gray).opacity(dot.alpha)))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct HivraOrbPreset {
    var latRings: Int
    var lonDensity: Int
    var rBase: Double
    var rDepth: Double
    var rBoost: Double = 1
    var inkFar: Double = 0.62
    var inkSpan: Double = 0.54
    var rMin: Double = 0.3
    var scanMul: Double
    var dimBase: Double
    var speed: Double

    /// The library's globe presets: counts scale by the square root of `count`,
    /// radii by `size`, as `resolvePreset` does.
    static func globe(for size: CGFloat) -> HivraOrbPreset {
        let (speed, count, scale, scanMul): (Double, Double, Double, Double) = switch size {
        case ..<26: (2.665, 0.105, 1.75, 4.335)
        case ..<48: (2.3803, 0.1839, 1.4769, 4.2301)
        default: (2.015, 0.42, 1.15, 4.08)
        }
        let root = count.squareRoot()
        return HivraOrbPreset(
            latRings: max(2, Int((17 * root).rounded())),
            lonDensity: max(2, Int((44 * root).rounded())),
            rBase: 0.6 * scale,
            rDepth: 1.7 * scale,
            scanMul: scanMul,
            dimBase: 0.45,
            speed: speed
        )
    }
}

enum HivraOrbGlobe {
    struct Dot { var x, y, z, r, white, alpha: Double }

    static func frame(size: Double, t: Double, preset o: HivraOrbPreset) -> [Dot] {
        let spin = 0.5
        let center = size / 2
        let radius = size / 2 * 0.82
        let tilt = 0.4 + 0.06 * sin(t * 0.35)
        let yaw = t * spin
        let scan = t * (spin + (1.7 - spin) * o.scanMul)
        let radiusScale = pow(size / 300, 0.6)
        let (st, ct, sy, cy) = (sin(tilt), cos(tilt), sin(yaw), cos(yaw))
        var dots: [Dot] = []
        for li in 0...o.latRings {
            let lat = -Double.pi / 2 + Double(li) / Double(o.latRings) * .pi
            let cosLat = cos(lat), sinLat = sin(lat)
            let lonCount = max(1, Int((abs(cosLat) * Double(o.lonDensity)).rounded()))
            for lj in 0..<lonCount {
                let lon = Double(lj) / Double(lonCount) * 2 * .pi
                let x = cosLat * cos(lon), y = sinLat, z = cosLat * sin(lon)
                let x1 = x * cy + z * sy
                let z1 = -x * sy + z * cy
                let y1 = y * ct - z1 * st
                let z2 = y * st + z1 * ct
                let depth = (z2 + 1) / 2
                let delta = atan2(sin(lon + yaw - scan), cos(lon + yaw - scan))
                let boost = exp(-(delta * delta) / 0.18) * max(0, z2)
                let alpha = o.dimBase + (1 - o.dimBase) * min(1, boost)
                guard alpha >= 0.02 else { continue }
                dots.append(Dot(
                    x: center + x1 * radius,
                    y: center - y1 * radius,
                    z: z2,
                    r: max(o.rMin, (o.rBase + o.rDepth * depth + o.rBoost * boost) * radiusScale),
                    white: o.inkFar - o.inkSpan * depth,
                    alpha: alpha
                ))
            }
        }
        return dots.sorted { $0.z < $1.z }
    }
}
