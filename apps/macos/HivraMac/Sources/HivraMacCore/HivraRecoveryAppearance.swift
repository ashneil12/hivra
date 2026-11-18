public enum HivraRecoveryAppearance {
    public typealias RGB = (red: Double, green: Double, blue: Double)

    // Recovery must stay readable even when WebKit's failed page is white, so
    // it is always Hivra Glass dark: the dark base, a raised card and the ink.
    public static let backdrop: RGB = (0.09, 0.09, 0.09)
    public static let card: RGB = (0.13, 0.13, 0.13)
    public static let text: RGB = (0.92, 0.92, 0.92)
    /// The primary action is a solid ink fill with base-coloured text.
    public static let primaryAction: RGB = (0.92, 0.92, 0.92)
    public static let onPrimaryAction: RGB = (0.09, 0.09, 0.09)
    /// The error mark (Hivra Glass dark `--hg-bad`).
    public static let error: RGB = (0.973, 0.443, 0.443)
}
