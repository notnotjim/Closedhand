// Closedhand for Mac keeps itself up to date with Sparkle: the newest
// release's feed, signed with the update key, installed once Closedhand is
// between replies. These hold the pieces together; a missing one leaves
// every Mac on the version it was installed with.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("the app knows where to look and which signature to trust", () => {
  const plist = read("desktop/Info.plist");
  assert.match(plist, /<key>SUFeedURL<\/key><string>https:\/\/github\.com\/notnotjim\/Closedhand\/releases\/latest\/download\/appcast\.xml<\/string>/);
  const key = (plist.match(/<key>SUPublicEDKey<\/key><string>([^<]*)<\/string>/) || [])[1] || "";
  assert.equal(Buffer.from(key, "base64").length, 32, "an Ed25519 public key, not a placeholder");
  assert.match(plist, /<key>SUEnableAutomaticChecks<\/key><true\/>/);
  assert.match(plist, /<key>SUAutomaticallyUpdate<\/key><true\/>/);
  assert.match(plist, /<key>CFBundleVersion<\/key><string>__VERSION__<\/string>/, "each release's own version, which Sparkle compares");
});

test("Sparkle is built in, shipped inside the app and signed with it", () => {
  assert.match(read("desktop/Package.swift"), /\.package\(url: "https:\/\/github\.com\/sparkle-project\/Sparkle", exact: "2\.10\.0"\)/);
  assert.match(read("desktop/Package.swift"), /"-rpath", "-Xlinker", "@executable_path\/\.\.\/Frameworks"/);
  const build = read("desktop/build.sh");
  assert.match(build, /cp -R "\$\(dirname "\$BIN"\)\/Sparkle\.framework" "\$APP\/Contents\/Frameworks\/"/);
  const order = ["XPCServices/Installer.xpc", "XPCServices/Downloader.xpc", "$SPARKLE/Autoupdate", "$SPARKLE/Updater.app", 'Frameworks/Sparkle.framework"\n', 'ClosedHand.entitlements" "$APP"'].map((s) => build.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "inside out, the app last");
});

test("an update installs only between replies, without asking", () => {
  const updater = read("desktop/Sources/ClosedHand/Updater.swift");
  assert.match(updater, /c\.updater\.automaticallyDownloadsUpdates = true/);
  assert.match(updater, /willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock/);
  assert.match(updater, /Supervisor\.shared\.isIdle \{ idle in\n\s*guard idle,/);
  assert.match(read("desktop/Sources/ClosedHand/ClosedHandApp.swift"), /Updater\.shared\.start\(\)/);
  assert.match(read("desktop/Sources/ClosedHand/Supervisor.swift"), /let busy = \(health\?\["busy"\] as\? Bool\) \?\? false/);
  assert.match(read("index.js"), /const busy = Object\.values\(ctx\.currentAsk \|\| \{\}\)\.some\(Boolean\) \|\| Object\.values\(ctx\.pendingIncoming \|\| \{\}\)\.some\(\(n\) => n > 0\);\n\s*res\.json\(\{ status: "ok", platform: "closedhand-bot", uptime: process\.uptime\(\), busy \}\);/);
});

test("each release carries its signed feed and the small difference from the last one", () => {
  const wf = read(".github/workflows/build-desktop.yml");
  assert.match(wf, /HAS_SPARKLE: \$\{\{ secrets\.SPARKLE_PRIVATE_KEY != '' \}\}/);
  assert.match(wf, /echo "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c  \$RUNNER_TEMP\/sparkle\.tar\.xz" \| shasum -a 256 -c -/, "the tools are the ones checked");
  assert.match(wf, /printf '%s' "\$SPARKLE_PRIVATE_KEY" \| "\$RUNNER_TEMP\/sparkle\/bin\/generate_appcast" --ed-key-file -/, "the private key never touches the disk");
  assert.match(wf, /--maximum-versions 1 --maximum-deltas 3/);
  assert.match(wf, /ASSETS\+=\("\$RUNNER_TEMP\/updates\/appcast\.xml"\)/);
  assert.match(wf, /gh release create "\$TAG" "\$\{ASSETS\[@\]\}"[^\n]*--latest/, "on the latest release, where SUFeedURL points");
});

test("a release whose feed does not verify with the app's key is not published", () => {
  const crypto = require("node:crypto");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  fs.writeFileSync(path.join(dir, "Info.plist"), `<key>SUPublicEDKey</key><string>${pub}</string>`);
  fs.writeFileSync(path.join(dir, "Closedhand-9.9.9-arm64.dmg"), "the app");
  fs.writeFileSync(path.join(dir, "Closedhand9.9.9-9.9.8.delta"), "the difference");
  const sig = (key, f) => crypto.sign(null, fs.readFileSync(path.join(dir, f)), key).toString("base64");
  const feed = (k1, k2) => `<rss><channel><item><enclosure url="https://example.test/v9.9.9/Closedhand-9.9.9-arm64.dmg" sparkle:edSignature="${sig(k1, "Closedhand-9.9.9-arm64.dmg")}"/><sparkle:deltas><enclosure url="https://example.test/v9.9.9/Closedhand9.9.9-9.9.8.delta" sparkle:edSignature="${sig(k2, "Closedhand9.9.9-9.9.8.delta")}"/></sparkle:deltas></item></channel></rss>`;
  const { verifyFeed } = require("./verify-update-feed");
  fs.writeFileSync(path.join(dir, "good.xml"), feed(privateKey, privateKey));
  assert.deepEqual(verifyFeed(path.join(dir, "good.xml"), dir, path.join(dir, "Info.plist")).map((r) => r.ok), [true, true], "the app and its difference file");
  fs.writeFileSync(path.join(dir, "bad.xml"), feed(privateKey, other));
  assert.deepEqual(verifyFeed(path.join(dir, "bad.xml"), dir, path.join(dir, "Info.plist")).map((r) => r.ok), [true, false], "one file signed with another key is caught");
  fs.rmSync(dir, { recursive: true, force: true });
  const wf = read(".github/workflows/build-desktop.yml");
  const made = wf.indexOf('cat "$U/appcast.xml"'), checked = wf.indexOf('node scripts/verify-update-feed.js "$U/appcast.xml" "$U" desktop/Info.plist'), released = wf.indexOf("- name: Release");
  assert.ok(made > 0 && checked > made && released > checked, "checked after it is made and before the release");
});
