import Foundation
import EventKit

enum CalendarBridge {
    /// Run AppleScript via ShellBridge (proven TCC-compatible path)
    private static func shellScript(_ script: String, timeout: TimeInterval = 30) async -> String? {
        let tmpFile = NSTemporaryDirectory() + "closedhand_cal_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1000...9999)).scpt"
        do { try script.write(toFile: tmpFile, atomically: true, encoding: .utf8) }
        catch { return nil }
        defer { try? FileManager.default.removeItem(atPath: tmpFile) }

        let result = await ShellBridge.run(params: ["command": "osascript '\(tmpFile)'", "timeout": timeout])
        if let dict = result as? [String: Any] {
            let stdout = dict["stdout"] as? String ?? ""
            if !stdout.isEmpty {
                return stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    /// The calendar, read from the calendar store. macOS asks the person once,
    /// with the words in Info.plist, the first time it is needed; a no is
    /// respected. Reading by driving the Calendar app instead raised a second,
    /// stranger prompt ("wants to control Calendar") in the middle of setup.
    static func listEvents(params: [String: Any]) async -> Any {
        let daysBack = params["days_back"] as? Int ?? 0
        let daysAhead = params["days_ahead"] as? Int ?? 7
        if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
            _ = try? await EKEventStore().requestFullAccessToEvents()
        }
        return eventKitEvents(daysBack: daysBack, daysAhead: daysAhead) ?? ([] as [Any])
    }

    /// Events read straight from the calendar store: fast, no Calendar app
    /// launch, exact times with their offset. Nil when Calendar access isn't
    /// granted.
    private static func eventKitEvents(daysBack: Int, daysAhead: Int) -> [[String: Any]]? {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return nil }
        let store = EKEventStore()
        let now = Date()
        guard let from = Calendar.current.date(byAdding: .day, value: -daysBack, to: now),
              let to = Calendar.current.date(byAdding: .day, value: daysAhead, to: now) else { return nil }
        // Birthdays, suggestions and public holiday calendars are not the person's plans.
        let calendars = store.calendars(for: .event).filter { cal in
            cal.type != .birthday && !cal.title.localizedCaseInsensitiveContains("holiday")
                && !["Siri Suggestions", "Scheduled Reminders"].contains(cal.title)
        }
        if calendars.isEmpty { return [] }
        let iso = ISO8601DateFormatter()
        iso.timeZone = .current
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        return store.events(matching: predicate).map { e in
            var event: [String: Any] = [
                // Stable across syncs: the same event keeps the same id.
                "id": (e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? "") + "@" + iso.string(from: e.startDate),
                "title": e.title ?? "",
                "start": iso.string(from: e.startDate),
                "end": iso.string(from: e.endDate),
                "all_day": e.isAllDay,
                "location": e.location ?? "",
                "calendar": e.calendar.title,
                "notes": String((e.notes ?? "").prefix(2000)),
            ]
            if let attendees = e.attendees, !attendees.isEmpty {
                event["attendees"] = attendees.map { a in
                    a.name ?? a.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
                }
            }
            return event
        }
    }

    static func createEvent(params: [String: Any]) async -> Any {
        guard let title = params["title"] as? String,
              let startStr = params["start"] as? String,
              let endStr = params["end"] as? String else {
            return ["error": "title, start, end required"]
        }
        let location = (params["location"] as? String ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let notes = (params["notes"] as? String ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let escapedTitle = title.replacingOccurrences(of: "\"", with: "\\\"")

        let script = """
        tell application "Calendar"
            set newEvent to make new event at end of events of default calendar with properties {summary:"\(escapedTitle)", start date:date "\(startStr)", end date:date "\(endStr)", location:"\(location)", description:"\(notes)"}
            return summary of newEvent
        end tell
        """

        guard let result = await shellScript(script, timeout: 15) else {
            return ["error": "Could not create event"]
        }
        return ["success": true, "title": result]
    }
}
