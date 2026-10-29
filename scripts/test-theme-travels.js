// Light or dark is one choice across closedhand.com and the person's own
// Closedhand: each link between them carries the pick and when it was made
// (#theme=<pick>.<when>, after the # so no server is sent it), the newer pick
// wins and is kept on the other side, and the address is cleaned at once.
// Runs both sites' real theme.js against a stand-in page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function page(file, { href, attrs = {}, stored = {}, dark = true, answer = null } = {}) {
  const url = new URL(href);
  const root = {
    attrs: { ...attrs }, style: { setProperty() {} },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    dispatchEvent() {},
  };
  const clicks = [], taps = [], posted = [], seen = [], asked = [];
  // The sun and moon button, as many as a page has.
  const button = { title: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getBoundingClientRect: () => ({ left: 360, top: 20, width: 32, height: 32 }) };
  const document = {
    documentElement: root, body: { appendChild() {} },
    addEventListener(type, fn, capture) { if (type === "click") (capture ? clicks : taps).push(fn); },
    querySelectorAll: (sel) => (sel === ".theme-toggle" ? [button] : []), getElementById: () => null,
  };
  const storage = { ...stored };
  const window = {
    document, location: { hash: url.hash, pathname: url.pathname, search: url.search },
    history: { state: null, replaceState(state, title, to) { window.cleaned = to; } },
    // Reduced motion, so a tap changes the page at once, with no drawing.
    matchMedia: (q) => (/reduce/.test(q) ? { matches: true } : { get matches() { return !dark; }, addEventListener(type, fn) { seen.push(fn); } }),
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
    // The person's Closedhand answering closedhand.com's question (/api/theme-pick), or a save.
    fetch: async (u, opts) => {
      if (String(u).endsWith("/api/theme-pick")) { asked.push({ u, opts }); return { ok: !!answer, json: async () => answer }; }
      posted.push(JSON.parse(opts.body)); return { ok: true };
    },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    innerWidth: 400, innerHeight: 800,
  };
  window.parent = window;
  vm.runInNewContext(read(file), { window, document, location: window.location, history: window.history, localStorage: window.localStorage, fetch: window.fetch, CustomEvent: window.CustomEvent, URL, Date, Number, String, Math, innerWidth: 400, innerHeight: 800 });
  // A tap on a link: each capturing listener sees it, then the browser follows a.href.
  const follow = (to) => { const a = { href: to }; const target = { closest: (sel) => (sel === "a[href]" ? a : null) }; clicks.forEach((fn) => fn({ target })); return a.href; };
  // A tap on the sun, moon or the two in one: what is shown after it, and what the button says.
  const tap = () => { const target = { closest: (sel) => (sel === ".theme-toggle" ? button : null) }; taps.forEach((fn) => fn({ target })); return [root.attrs["data-theme-pick"] || "device", root.attrs["data-theme"]]; };
  const turnDevice = (toDark) => { dark = toDark; seen.forEach((fn) => fn()); };
  return { root, storage, posted, asked, follow, tap, button, turnDevice, cleaned: () => window.cleaned };
}

const APP = "webapp/public/theme.js", SITE = "closedhand-com/public/theme.js";

test("a newer pick brought from closedhand.com is shown, kept in the person's settings, and taken off the address", () => {
  const p = page(APP, { href: "https://alex.closedhand.ai/#theme=dark.1761400000000", attrs: { "data-theme-pick": "light", "data-theme-at": "1761300000000" } });
  assert.equal(p.root.attrs["data-theme"], "dark");
  assert.deepEqual(p.posted, [{ pick: "dark", at: 1761400000000 }]);
  assert.equal(p.cleaned(), "/", "nothing left in the address");
  const older = page(APP, { href: "https://alex.closedhand.ai/#theme=dark.1761200000000", attrs: { "data-theme-pick": "light", "data-theme-at": "1761300000000" } });
  assert.equal(older.root.attrs["data-theme"], "light", "an older pick from there gives way to the newer one here");
  assert.deepEqual(older.posted, []);
  const kept = page(APP, { href: "https://alex.closedhand.ai/#c=42&theme=light.1761400000000", attrs: {} });
  assert.equal(kept.cleaned(), "/#c=42", "anything else after the # stays");
});

test("a pick made here goes to closedhand.com's own pages, and never with a link that passes on", () => {
  const p = page(APP, { href: "https://alex.closedhand.ai/", attrs: { "data-theme-pick": "light", "data-theme-at": "1761300000000" } });
  assert.equal(p.follow("https://closedhand.com/account"), "https://closedhand.com/account#theme=light.1761300000000");
  assert.equal(p.follow("https://closedhand.com/"), "https://closedhand.com/#theme=light.1761300000000");
  assert.equal(p.follow("https://closedhand.com/claim?code=1"), "https://closedhand.com/claim?code=1", "a claim passes on to a sign-in");
  assert.equal(p.follow("https://example.test/"), "https://example.test/");
  assert.equal(p.follow("https://closedhand.com/privacy#where"), "https://closedhand.com/privacy#where", "a link already going somewhere on the page is left");
  const never = page(APP, { href: "https://alex.closedhand.ai/", attrs: {} });
  assert.equal(never.follow("https://closedhand.com/account"), "https://closedhand.com/account", "nothing picked, nothing carried");
});

test("closedhand.com keeps a newer pick from the person's Closedhand, and carries its own to it", () => {
  const p = page(SITE, { href: "https://closedhand.com/account#theme=light.1761400000000", dark: true });
  assert.equal(p.root.attrs["data-theme"], "light", "the device is dark, the newer pick is light");
  assert.deepEqual([p.storage["closedhand-theme"], p.storage["closedhand-theme-at"]], ["light", "1761400000000"]);
  assert.equal(p.cleaned(), "/account");
  const own = page(SITE, { href: "https://closedhand.com/", stored: { "closedhand-theme": "dark", "closedhand-theme-at": "1761500000000" } });
  assert.equal(own.follow("https://alex.closedhand.ai/"), "https://alex.closedhand.ai/#theme=dark.1761500000000");
  assert.equal(own.follow("http://localhost:3000/"), "http://localhost:3000/#theme=dark.1761500000000", "the Closedhand on this computer too");
  assert.equal(own.follow("https://alex.closedhand.ai/setup?x=1"), "https://alex.closedhand.ai/setup?x=1");
  const back = page(SITE, { href: "https://closedhand.com/#theme=device.1761600000000", stored: { "closedhand-theme": "dark", "closedhand-theme-at": "1761500000000" } });
  assert.equal(back.storage["closedhand-theme"], undefined, "matching the device, brought back, follows the device again");
});

test("the person's Closedhand keeps when it was picked, and a pick only takes over if newer", () => {
  const assets = require("../webapp/assets");
  const html = '<!DOCTYPE html>\n<html lang="en"><head></head></html>';
  assets.setAppearance("dark", 1761300000000);
  assert.match(assets.withAppearance(html), /<html data-theme-pick="dark" data-theme-at="1761300000000" lang="en">/);
  assets.setAppearance("device", 1761300000000);
  assert.match(assets.withAppearance(html), /<html data-theme-at="1761300000000" lang="en">/, "matching the device was a pick too");
  assets.setAppearance(undefined);
  assert.equal(assets.withAppearance(html), html);
  const server = read("webapp/server.js");
  assert.match(server, /if \(Number\(kept\.appearance_at\) >= at\) return res\.json/);
  assert.match(server, /patchSettings\(supabase, userId, \{ set: \{ appearance: pick, appearance_at: at \} \}\);/);
  assert.match(read(APP), /body: JSON\.stringify\(\{ pick: next, at: at \}\)/, "a tap of the sun or moon is stamped");
});

// Matching the device is a pick of its own, the sun and moon in one: each tap
// goes from matching the device to the other theme, to the device's own, and
// back to matching it, so the first two taps always change the page.
for (const [name, file, href] of [["closedhand.com", SITE, "https://closedhand.com/"], ["the person's Closedhand", APP, "https://alex.closedhand.ai/"]]) {
  test(`${name}: a tap moves to the next of the three, shown and said on the button`, () => {
    const p = page(file, { href, dark: true });
    assert.deepEqual([p.root.attrs["data-theme-pick"] || "device", p.root.attrs["data-theme"]], ["device", "dark"]);
    assert.deepEqual(p.tap(), ["light", "light"]);
    assert.equal(p.button.title, "Light. Switch to dark.");
    assert.deepEqual(p.tap(), ["dark", "dark"]);
    assert.equal(p.button.attrs["aria-label"], "Dark. Switch to match this device.");
    assert.deepEqual(p.tap(), ["device", "dark"], "back to matching the device, which is dark");
    assert.equal(p.button.title, "Matches this device. Switch to light.");
    p.turnDevice(false);
    assert.equal(p.root.attrs["data-theme"], "light", "matching the device follows it");
    assert.equal(p.button.title, "Matches this device. Switch to dark.", "and the next tap goes the other way");
    if (file === SITE) {
      assert.equal(p.storage["closedhand-theme"], undefined, "matching the device keeps no light or dark");
      assert.ok(Number(p.storage["closedhand-theme-at"]) > 1761000000000, "but is stamped, so it travels like any pick");
    } else {
      assert.deepEqual(p.posted.map((x) => x.pick), ["light", "dark", "device"], "each pick kept in the person's settings");
    }
  });
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("going straight to closedhand.com, it asks the person's own Closedhand for its pick, and the newer pick wins", async () => {
  const known = { "closedhand-personal-url": "https://alex.closedhand.ai", "closedhand-theme": "dark", "closedhand-theme-at": "1761500000000" };
  const newer = page(SITE, { href: "https://closedhand.com/", stored: { ...known }, answer: { pick: "light", at: 1761600000000 } });
  await settle();
  assert.deepEqual(newer.asked.map((a) => [a.u, a.opts.credentials]), [["https://alex.closedhand.ai/api/theme-pick", "omit"]], "no cookie goes with it");
  assert.equal(newer.root.attrs["data-theme"], "light");
  assert.deepEqual([newer.storage["closedhand-theme"], newer.storage["closedhand-theme-at"]], ["light", "1761600000000"]);
  const older = page(SITE, { href: "https://closedhand.com/", stored: { ...known }, answer: { pick: "light", at: 1761400000000 } });
  await settle();
  assert.equal(older.root.attrs["data-theme"], "dark", "a pick made here since stays");
  const device = page(SITE, { href: "https://closedhand.com/", stored: { ...known }, answer: { pick: "device", at: 1761600000000 }, dark: false });
  await settle();
  assert.equal(device.storage["closedhand-theme"], undefined, "matching the device, from there, follows the device here");
  assert.equal(device.root.attrs["data-theme"], "light");
  const off = page(SITE, { href: "https://closedhand.com/", stored: { ...known }, answer: null });
  await settle();
  assert.equal(off.root.attrs["data-theme"], "dark", "its computer off: nothing changes");
  const stranger = page(SITE, { href: "https://closedhand.com/", stored: { "closedhand-personal-url": "https://evil.example.com" } });
  await settle();
  assert.deepEqual(stranger.asked, [], "only a personal URL is ever asked");
});

test("the person's Closedhand tells closedhand.com only its pick and when, without a sign-in", () => {
  const server = read("webapp/server.js");
  const route = server.slice(server.indexOf('app.get("/api/theme-pick"'), server.indexOf("const SIGNED_BY_BRIDGE"));
  assert.ok(server.indexOf('app.get("/api/theme-pick"') > 0 && server.indexOf('app.get("/api/theme-pick"') < server.indexOf("app.use(async (req, res, next) => {\n  try {\n    if (!(await passwordConfigured()))"), "before the sign-in gate");
  assert.match(route, /"Access-Control-Allow-Origin": "https:\/\/closedhand\.com"/);
  assert.match(route, /res\.json\(\{ pick, at: Number\(kept\.appearance_at\) \|\| 0 \}\);/, "the pick and when, nothing else");
});
