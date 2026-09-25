import Foundation

/// File names for downloads: one safe path component, never replacing an existing file.
public enum HivraDownloadNaming {
    public static let fallbackName = "Download"
    static let maximumNameBytes = 255
    /// Compound extensions keep their counter before the whole extension: "logs (1).tar.gz".
    static let compoundExtensions = ["tar.gz", "tar.bz2", "tar.xz", "tar.zst"]

    public static func sanitizedFilename(_ suggested: String) -> String {
        let replaced = suggested.unicodeScalars.map { scalar -> String in
            if CharacterSet.controlCharacters.contains(scalar) { return "" }
            // "/" separates paths and ":" is shown as "/" by Finder.
            return scalar == "/" || scalar == ":" || scalar == "\\" ? "_" : String(scalar)
        }.joined()
        var name = replaced.trimmingCharacters(in: .whitespacesAndNewlines)
        // No hidden files and no "." or ".." components.
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return fallbackName }
        return bounded(name)
    }

    /// The first name in `directory` that is neither on disk nor reserved by another
    /// download in progress: "report.pdf", then "report (1).pdf", "report (2).pdf"…
    public static func availableURL(
        for suggested: String,
        in directory: URL,
        isTaken: (URL) -> Bool
    ) -> URL {
        let name = sanitizedFilename(suggested)
        let (stem, pathExtension) = split(name)
        var candidate = directory.appendingPathComponent(name, isDirectory: false)
        var counter = 1
        let suffix = pathExtension.isEmpty ? "" : ".\(pathExtension)"
        while isTaken(candidate) {
            let marker = " (\(counter))"
            candidate = directory.appendingPathComponent(
                bounded(stem, reserving: marker + suffix) + marker + suffix,
                isDirectory: false
            )
            counter += 1
        }
        return candidate
    }

    static func split(_ name: String) -> (stem: String, pathExtension: String) {
        let lowercased = name.lowercased()
        if let compound = compoundExtensions.first(where: { lowercased.hasSuffix(".\($0)") && lowercased.count > $0.count + 1 }) {
            return (String(name.dropLast(compound.count + 1)), String(name.suffix(compound.count)))
        }
        let pathExtension = (name as NSString).pathExtension
        guard !pathExtension.isEmpty else { return (name, "") }
        return ((name as NSString).deletingPathExtension, pathExtension)
    }

    /// Keeps the extension while trimming the stem so the name fits in one path component.
    private static func bounded(_ name: String) -> String {
        guard name.utf8.count > maximumNameBytes else { return name }
        let (stem, pathExtension) = split(name)
        let suffix = pathExtension.isEmpty ? "" : ".\(pathExtension)"
        return bounded(stem, reserving: suffix) + suffix
    }

    private static func bounded(_ stem: String, reserving suffix: String) -> String {
        var stem = stem
        while !stem.isEmpty && stem.utf8.count + suffix.utf8.count > maximumNameBytes { stem.removeLast() }
        return stem.isEmpty ? fallbackName : stem
    }
}
