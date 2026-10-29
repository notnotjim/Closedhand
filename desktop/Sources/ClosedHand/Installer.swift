import AppKit

/// The download's disk image is done with once Closedhand runs from
/// Applications, so it is ejected: its window and the disk on the desktop go
/// away by themselves. hdiutil lists the mounted images by file without
/// opening them, and the downloaded .dmg stays in Downloads, since reading
/// either would make macOS ask the person's permission first.
enum Installer {
    static func ejectDiskImage() {
        let here = Bundle.main.bundlePath
        guard here.hasPrefix("/Applications/") || here.hasPrefix(NSHomeDirectory() + "/Applications/") else { return }
        DispatchQueue.global(qos: .utility).async {
            let hdiutil = Process(), out = Pipe()
            hdiutil.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            hdiutil.arguments = ["info", "-plist"]
            hdiutil.standardOutput = out
            hdiutil.standardError = FileHandle.nullDevice
            guard (try? hdiutil.run()) != nil else { return }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            hdiutil.waitUntilExit()
            guard let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let images = info["images"] as? [[String: Any]] else { return }
            for image in images {
                // Closedhand-<version>-<arch>.dmg, as dmg.sh names it (a browser
                // may add " (1)" to a second download).
                // Its name as a string: a file URL would look on disk, in
                // Downloads, and macOS would ask the person about Downloads.
                guard let file = (image["image-path"] as? String).map({ ($0 as NSString).lastPathComponent }),
                      file.hasPrefix("Closedhand-"), file.hasSuffix(".dmg") else { continue }
                for entity in image["system-entities"] as? [[String: Any]] ?? [] {
                    guard let mount = entity["mount-point"] as? String else { continue }
                    try? NSWorkspace.shared.unmountAndEjectDevice(at: URL(fileURLWithPath: mount))
                }
            }
        }
    }
}
