// The computer at the top of the web chat: whether Closedhand can reach the
// person's Mac and, while it can, what it may use there, as the Mac app or
// Closedhand Bridge reports it when it connects and whenever a choice in its
// menu changes. Shown only once there is a Mac. Invented names only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const access = require("../webapp/bridge-access");

test("what a Mac reports is kept to its name and the nine choices, as true or false", () => {
  assert.deepEqual(access.clean({ device: "  Mira’s MacBook Air\n", allowed: { calendar: true, files: false, terminal: "yes", rootkit: true } }),
    { device: "Mira’s MacBook Air", allowed: { calendar: true, files: false } });
  assert.deepEqual(access.clean({ device: "x".repeat(100) }).device.length, 64);
  assert.deepEqual(access.clean({}), { device: null, allowed: null });
  assert.deepEqual(access.clean(null), { device: null, allowed: null });
});

test("the dashboard server keeps it with the Mac's connection and hands it to the web chat", () => {
  const server = read("webapp/server.js");
  assert.match(server, /if \(msg\.type === "access" && ws\.bridgeUserId\) \{\n\s*\/\/[^\n]*\n\s*ws\.bridgeAccess = require\("\.\/bridge-access"\)\.clean\(msg\);/, "only from a Mac that has signed in");
  assert.match(server, /const access = actuallyConnected \? ws\.bridgeAccess : null;/, "what it allows, only while it is connected");
  assert.match(server, /device: \(access && access\.device\) \|\| bridgeDevices\.get\(userId\) \|\| null/, "its name, also while it is away");
});

test("the Mac app and Bridge report the same nine choices, when they connect and whenever one changes", () => {
  const mac = read("bridge-app/Sources/BridgeManager.swift");
  assert.equal(fs.realpathSync(path.join(root, "desktop/Sources/ClosedHand/Bridge/BridgeManager.swift")), fs.realpathSync(path.join(root, "bridge-app/Sources/BridgeManager.swift")), "one file for both apps");
  const sent = mac.slice(mac.indexOf("func reportAccess"), mac.indexOf("let message: [String: Any] = [\"type\": \"access\""));
  assert.deepEqual([...sent.matchAll(/"([a-zA-Z]+)": /g)].map((m) => m[1]).sort(), [...access.KEYS].sort());
  assert.match(mac, /case "authenticated":[\s\S]{0,160}reportAccess\(force: true\)/);
  assert.match(mac, /saveSettings\(\)\n\s*reportAccess\(force: true\)/, "and once paired");
  assert.match(mac, /Timer\.scheduledTimer\(withTimeInterval: 5, repeats: true\)[\s\S]{0,80}reportAccess\(\)/, "a changed choice or permission goes on its own");
  assert.match(mac, /if !force && text == lastAccess \{ return \}/, "nothing sent when nothing changed");
});

// The page's own code, run with a stand-in for the few elements it touches.
function page() {
  const html = read("webapp/views/index.html");
  const code = html.slice(html.indexOf("var DEVICE_ALLOWS = "), html.indexOf("// Under the computer on a wide screen"));
  const els = {};
  const el = (id) => (els[id] = els[id] || { hidden: true, textContent: "", title: "", innerHTML: "", attrs: {}, classes: new Set(),
    classList: { toggle(c, on) { on ? this.owner.classes.add(c) : this.owner.classes.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => ({ innerHTML: "<svg/>" }) });
  const ctx = vm.createContext({ document: { getElementById: (id) => { const e = el(id); e.classList.owner = e; return e; } }, closeDeviceSheet: () => { el("deviceSheet").hidden = true; } });
  vm.runInContext(code + "\nthis.deviceWords = deviceWords; this.showDevice = showDevice;", ctx);
  return { ...ctx, els: (id) => el(id) };
}

test("connected, it says what Closedhand may use there and where to change it, in the menu's own names", () => {
  const { deviceWords } = page();
  const words = deviceWords({ status: "connected", device: "Mira’s MacBook Air", allowed: { calendar: true, notes: true, files: true, contacts: false, terminal: false } });
  assert.equal(words.state, "Connected");
  assert.equal(words.note, "Closedhand can use Calendar, Notes and Files. Not allowed: Contacts and Terminal.");
  assert.equal(words.where, "Change this in Closedhand Bridge’s menu in the menu bar on Mira’s MacBook Air.");
  assert.equal(deviceWords({ status: "connected", desktop: true, allowed: { calendar: false } }).note, "Closedhand can’t use anything on it right now. Not allowed: Calendar.");
  const older = deviceWords({ status: "connected", desktop: true });
  assert.equal(older.note, "Closedhand can use the files and apps you allow on it.", "a Mac that reports nothing yet");
  assert.equal(older.where, "Change this in Closedhand’s menu in the menu bar on your Mac.");
  assert.equal(older.name, "Your Mac");
});

test("away, it says so plainly and how it comes back", () => {
  const { deviceWords } = page();
  const away = deviceWords({ status: "reconnecting", device: "Mira’s MacBook Air" });
  assert.equal(away.state, "Not connected");
  assert.equal(away.note, "The files and apps on Mira’s MacBook Air aren’t available to Closedhand right now. You can still chat.");
  assert.equal(away.where, "Open Closedhand Bridge on Mira’s MacBook Air and it reconnects by itself.");
  assert.match(deviceWords({ status: "reconnecting", desktop: true }).where, /^Closedhand for Mac connects to its Mac by itself/);
});

test("the icon shows only once there is a Mac, and wears a slash when it can't be reached", () => {
  const p = page();
  p.showDevice({ status: "not_paired", desktop: false });
  assert.equal(p.els("deviceToggle").hidden, true, "no Mac paired: nothing to show");
  p.showDevice({ status: "unavailable", desktop: true });
  assert.equal(p.els("deviceToggle").hidden, true);
  p.showDevice({ status: "reconnecting", device: "Mira’s MacBook Air" });
  assert.equal(p.els("deviceToggle").hidden, false);
  assert.ok(p.els("deviceToggle").classes.has("is-off"));
  assert.equal(p.els("deviceToggle").title, "Mira’s MacBook Air: Not connected");
  p.showDevice({ status: "connected", desktop: true });
  assert.ok(!p.els("deviceToggle").classes.has("is-off"));
  const html = read("webapp/views/index.html");
  assert.match(html, /<div class="header-right">\s*<button type="button" class="theme-toggle"[\s\S]{0,8000}?<\/button>\s*<button type="button" class="device-toggle" id="deviceToggle" hidden/, "beside the sun and moon, which stay first as on closedhand.com");
  assert.match(html, /<svg data-icon="computer" [\s\S]*?<svg data-icon="computeroff" /, "drawn with the brush (brand/icons)");
  assert.match(html, /function checkBridgeStatus\(\) \{\n\s*readMacAccessStatus\(\)\.then\(function\(data\) \{\n\s*showDevice\(data\);/, "kept up with the check every 15 seconds");
  assert.match(html, /<div class="mon-context-menu device-sheet"/, "the files menu's sheet, so a phone gets it along the bottom");
  assert.doesNotMatch(html.slice(html.indexOf(".device-toggle {"), html.indexOf("/* Right-click context menu */")), /--warn|yellow|#f[0-9a-f]{2}0/i, "never yellow: that is for the account");
});
