import SwiftUI
import AppKit

/// What shows while Closedhand starts after the person opened it, so opening
/// it never looks like nothing happened: the icon, "Starting Closedhand…" and
/// where to find it afterwards. It closes when the dashboard opens in the
/// browser, and says what went wrong if Closedhand could not start.
final class StartingWindow {
    static let shared = StartingWindow()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 240),
                             styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: StartingView())
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func close() { window?.close() }
}

struct StartingView: View {
    @ObservedObject private var stack = Supervisor.shared

    private var problem: String? {
        if case .failed(let why) = stack.database { return why }
        return nil
    }

    var body: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72)
            if let problem = problem {
                Text("Closedhand could not start").font(.headline)
                Text(problem).font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center).lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Show logs") { NSWorkspace.shared.open(stack.logsDir) }
            } else {
                Text("Starting Closedhand…").font(.headline)
                ProgressView().controlSize(.small)
                Text("It opens in your browser in a moment. After that, you'll find it in the menu bar at the top of your screen.")
                    .font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 28).padding(.vertical, 24)
        .frame(width: 340)
    }
}
