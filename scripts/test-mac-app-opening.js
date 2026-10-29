// Opening Closedhand for Mac never looks like nothing happened: the person
// sees it starting and then the dashboard, while a start at login or after an
// update stays in the menu bar; and the download's disk image goes away by
// itself once the app runs from Applications.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("opened by the person it shows that it is starting and opens the dashboard; at login or after an update it stays quiet", () => {
  const app = read("desktop/Sources/ClosedHand/ClosedHandApp.swift");
  assert.match(app, /let quiet = launchedAtLogin\(\) \|\| Updater\.shared\.relaunchedAfterUpdate\(\)/);
  assert.match(app, /if !quiet \{\n\s+StartingWindow\.shared\.show\(\)\n\s+Supervisor\.shared\.openWhenReady\(\)\n\s+\}/);
  assert.match(app, /paramDescriptor\(forKeyword: keyAEPropData\)\?\.enumCodeValue == keyAELaunchedAsLogInItem/);
  // Opened again while it starts: the window comes back, and the dashboard follows.
  assert.match(app, /if Supervisor\.shared\.web != \.running \{ StartingWindow\.shared\.show\(\) \}\n\s+Supervisor\.shared\.openWhenReady\(\)/);
  const updater = read("desktop/Sources/ClosedHand/Updater.swift");
  assert.match(updater, /UserDefaults\.standard\.set\(true, forKey: Updater\.relaunchKey\)\n\s+go\(\)/, "flagged just before the update restarts the app");
  const supervisor = read("desktop/Sources/ClosedHand/Supervisor.swift");
  assert.match(supervisor, /publish \{ self\.wantsDashboard = true \}/, "a brand new install opens setup");
  assert.match(supervisor, /if self\.wantsDashboard \{ self\.wantsDashboard = false; self\.openDashboard\(\) \}/);
  assert.match(supervisor, /NSWorkspace\.shared\.open\(dashboardURL\)\n\s+StartingWindow\.shared\.close\(\)/);
  assert.match(read("desktop/Sources/ClosedHand/StartingWindow.swift"), /if case \.failed\(let why\) = stack\.database \{ return why \}/, "a failed start says why");
});

test("the disk image is ejected once the app runs from Applications, found without reading Downloads or the disk", () => {
  const installer = read("desktop/Sources/ClosedHand/Installer.swift");
  assert.match(installer, /guard here\.hasPrefix\("\/Applications\/"\) \|\| here\.hasPrefix\(NSHomeDirectory\(\) \+ "\/Applications\/"\) else \{ return \}/);
  assert.match(installer, /hdiutil\.arguments = \["info", "-plist"\]/);
  assert.match(installer, /file\.hasPrefix\("Closedhand-"\), file\.hasSuffix\("\.dmg"\)/);
  assert.match(read("desktop/dmg.sh"), /OUT="\$HERE\/dist\/Closedhand-\$VERSION-\$ARCH\.dmg"/, "the name the eject looks for");
  assert.doesNotMatch(installer.replace(/\/\/.*$/gm, ""), /Downloads|trashItem|removeItem/);
  assert.match(read("desktop/Sources/ClosedHand/ClosedHandApp.swift"), /Installer\.ejectDiskImage\(\)/);
});

test("setup on a Mac asks only what it needs: no Downloads, one plain calendar question, and the app is called Closedhand", () => {
  const installer = read("desktop/Sources/ClosedHand/Installer.swift");
  // A file URL looks on disk to see if the path is a folder, and the
  // downloaded image is in Downloads, so macOS asked about Downloads.
  assert.match(installer, /\.map\(\{ \(\$0 as NSString\)\.lastPathComponent \}\)/);
  assert.doesNotMatch(installer, /URL\(fileURLWithPath: \$0\)/);
  for (const f of ["desktop/ClosedHand.entitlements", "bridge-app/Sources/ClosedHandBridge.entitlements"]) {
    assert.match(read(f), /com\.apple\.security\.personal-information\.calendars<\/key>\s*<true\/>/, f + ": the calendar can be asked for at all");
    assert.match(read(f), /com\.apple\.security\.personal-information\.addressbook<\/key>\s*<true\/>/, f);
  }
  const cal = read("bridge-app/Sources/Bridges/CalendarBridge.swift");
  const list = cal.slice(cal.indexOf("static func listEvents"), cal.indexOf("private static func eventKitEvents"));
  assert.match(list, /if EKEventStore\.authorizationStatus\(for: \.event\) == \.notDetermined \{\n\s*_ = try\? await EKEventStore\(\)\.requestFullAccessToEvents\(\)/);
  assert.doesNotMatch(list, /shellScript|tell application "Calendar"/, "a no is never routed round by driving the Calendar app");
  const fs = require("node:fs"), path = require("node:path");
  for (const f of ["bridge-app/Sources/DataSync.swift", "desktop/Sources/ClosedHand/Bridge/DataSync.swift"]) assert.equal(fs.existsSync(path.join(__dirname, "..", f)), false, f + ": the old push read the calendar and never sent it");
  assert.match(read("desktop/dmg/settings.py"), /\nhide_extensions = \[os\.path\.basename\(app\)\]/);
});
