// The Mac app and Bridge find their pictures inside their own bundle. SwiftPM's
// Bundle.module looks only beside the .app and in the folder the app was built
// in, so an app using it works on the Mac that built it and stops before
// anything shows on every other one (Closedhand for Mac 2.0.42 to 2.0.45).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function swiftFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return swiftFiles(rel);
    return rel.endsWith(".swift") ? [rel] : [];
  });
}

test("no Swift source asks for Bundle.module", () => {
  for (const f of [...swiftFiles("desktop/Sources"), ...swiftFiles("bridge-app/Sources")]) {
    assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ""), /Bundle\.module/, f);
  }
});

test("each app looks for the bundle its build puts in Contents/Resources", () => {
  for (const [app, entry, target] of [["desktop", "desktop/Sources/ClosedHand/ClosedHandApp.swift", "ClosedHand"], ["bridge-app", "bridge-app/Sources/ClosedHandBridgeApp.swift", "ClosedHandBridge"]]) {
    const bundle = target + "_" + target;
    assert.match(read(app + "/Package.swift"), new RegExp('name: "' + target + '"'), app);
    assert.match(read(app + "/build.sh"), new RegExp('BUNDLE_RES="\\$\\(dirname "\\$BIN"\\)/' + bundle + '\\.bundle"'), app);
    assert.match(read(app + "/build.sh"), /cp -R "\$BUNDLE_RES" "\$APP\/Contents\/Resources\/"/, app);
    assert.ok(read(entry).includes('Bundle.main.url(forResource: "' + bundle + '", withExtension: "bundle")'), entry);
  }
});
