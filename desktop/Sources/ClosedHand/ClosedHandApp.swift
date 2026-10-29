import SwiftUI
import AppKit

@main
struct ClosedHandApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var stack = Supervisor.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView()
        } label: {
            Image(nsImage: MenuIcon.image)
        }
        .menuBarExtraStyle(.window)

        // Bridge's permissions walkthrough, as it was: Accessibility, screen,
        // Automation, the apps. Opened from the menu, never forced.
        Window("Set up Mac access", id: "onboarding") {
            OnboardingHost()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 380, height: 480)
        .windowResizability(.contentSize)
    }
}

struct OnboardingHost: View {
    @State private var isComplete = UserDefaults.standard.bool(forKey: "onboardingComplete")
    var body: some View {
        if isComplete {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundColor(.green)
                Text("Mac access is set up").font(.title3)
                Text("Change what Closedhand may use from the menu bar.").font(.caption).foregroundColor(.secondary)
            }
            .padding()
            .frame(width: 380, height: 200)
        } else {
            OnboardingView(isComplete: $isComplete)
        }
    }
}

/// The logo, in the resource bundle build.sh puts in Contents/Resources
/// (beside the executable under `swift run`). Never SwiftPM's Bundle.module:
/// it looks only beside the .app and in the folder the app was built in, so
/// on any other Mac it stopped the app before anything showed. Bridge's
/// views, shared with this app, use it too.
enum Logo {
    static let url = Bundle.main.url(forResource: "ClosedHand_ClosedHand", withExtension: "bundle")
        .flatMap { Bundle(url: $0) }?.url(forResource: "logo", withExtension: "png")
}

/// The fist from the wordmark as a template image, so it takes the menu
/// bar's own colour in light and dark.
enum MenuIcon {
    static let image: NSImage = {
        if let url = Logo.url, let img = NSImage(contentsOf: url) {
            img.isTemplate = true
            img.size = NSSize(width: 18, height: 18)
            return img
        }
        return NSImage(systemSymbolName: "hand.raised.fill", accessibilityDescription: "Closedhand")!
    }()
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // This app shares its defaults with the Bridge app it replaces. A
        // pairing Bridge made with some other Closedhand must not be dialled
        // on launch; the Supervisor hands over the local one once it is up.
        UserDefaults.standard.set(false, forKey: "isPaired")
        let quiet = launchedAtLogin() || Updater.shared.relaunchedAfterUpdate()
        Supervisor.shared.start()
        Updater.shared.start()
        Installer.ejectDiskImage()
        // Opened by the person (Finder, Launchpad, Spotlight), it shows that
        // it is starting and opens the dashboard once it is up. Started at
        // login, or again after an update installed itself, it stays quietly
        // in the menu bar.
        if !quiet {
            StartingWindow.shared.show()
            Supervisor.shared.openWhenReady()
        }
    }

    /// macOS marks the launch it makes for the login item as such.
    private func launchedAtLogin() -> Bool {
        let event = NSAppleEventManager.shared().currentAppleEvent
        return event?.eventID == kAEOpenApplication && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    /// Opening the app again while it runs (a Finder double-click, or the
    /// Launchpad icon) means "show me Closedhand".
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if Supervisor.shared.web != .running { StartingWindow.shared.show() }
        Supervisor.shared.openWhenReady()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Quit means the whole stack goes down cleanly: the node processes
        // first, then Postgres with a fast shutdown so the data is consistent.
        Supervisor.shared.stop()
        return .terminateNow
    }
}
