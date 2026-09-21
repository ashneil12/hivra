public enum HivraRecoveryAppearance {
    public typealias RGB = (red: Double, green: Double, blue: Double)

    // Recovery must stay readable even when WebKit's failed page is white.
    public static let backdrop: RGB = (0.035, 0.039, 0.043)
    public static let card: RGB = (0.095, 0.100, 0.110)
    public static let text: RGB = (0.940, 0.950, 0.960)
    public static let primaryAction: RGB = (0.800, 0.060, 0.090)
}
