// Light or dark for every page the app serves: colours by name, the person's
// pick (Settings, Appearance) put on each page as it is served, and theme.js
// setting the theme before anything is drawn. Invented values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// The app's pages. Telegram's and LINE's mini apps follow their own app's
// theme (Telegram's and LINE's colours), so they are not among them.
const PAGES = ["dashboard", "index", "setup", "login", "setup-code", "keep", "privacy", "terms"].map((p) => `webapp/views/${p}.html`);

test("the app names its colours: no page, style or script holds a palette value", () => {
  const css = fs.readdirSync(path.join(root, "webapp/public")).filter((f) => f.endsWith(".css")).map((f) => `webapp/public/${f}`);
  // theme.js keeps the browser bar's two colours, which take values.
  const js = fs.readdirSync(path.join(root, "webapp/public")).filter((f) => f.endsWith(".js") && f !== "theme.js").map((f) => `webapp/public/${f}`);
  const iface = read("webapp/public/interface.css");
  const darkHex = [...iface.slice(0, iface.indexOf(':root[data-theme="light"]')).matchAll(/--[\w-]+:\s*#([0-9A-Fa-f]{6});/g)].map((m) => m[1]);
  assert.ok(darkHex.length >= 30, "the names are defined");
  const triples = darkHex.map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join("\\s*,\\s*"));
  const palette = new RegExp(`(?<![&\\w%])#(?:${darkHex.join("|")})\\b|rgba?\\(\\s*(?:${triples.join("|")})\\s*[,)]`, "i");
  for (const file of [...PAGES, ...css, ...js]) {
    let text = read(file).replace(/<meta name="theme-color"[^>]*>/g, "");
    // Only the names' own definitions hold values.
    if (file === "webapp/public/interface.css") text = text.replace(/:root(?:\[data-theme="light"\])? \{[^}]*--fg:[^}]*\}/g, "");
    const hit = text.match(palette);
    assert.equal(hit, null, `${file} uses a colour's value (${hit && hit[0]}), not its name`);
  }
  assert.match(iface, /:root\[data-theme="light"\] \{\n  color-scheme: light;\n  --fg: #1A1817; --fg-rgb: 26,24,23;/, "with a light value for each");
});

test("every page sets its theme before anything is drawn", () => {
  for (const page of PAGES) {
    assert.match(read(page), /<meta name="viewport"[^>]*>\s*<script src="\/theme\.js"><\/script>/, `${page} loads theme.js first`);
  }
  const theme = read("webapp/public/theme.js");
  assert.match(theme, /return p === 'device' \? \(device\.matches \? 'light' : 'dark'\) : p;/, "Match this device follows the device");
  assert.match(theme, /device\.addEventListener\('change', function \(\) \{ if \(pick\(\) === 'device'\) apply\(current\(\)\); else label\(\); \}\);/, "and its changes");
  assert.match(theme, /document\.startViewTransition/, "switching plays the transition");
  assert.match(read("webapp/public/interface.css"), /\.theme-ring \{[^}]*view-transition-name: theme-ring;/, "with closedhand.com's ember ring");
});

test("the pick is put on every page as it is served, and only a real pick", () => {
  const assets = require("../webapp/assets");
  const html = '<!DOCTYPE html>\n<html lang="en"><head></head></html>';
  assets.setAppearance("light");
  assert.match(assets.withAppearance(html), /<html data-theme-pick="light" lang="en">/);
  assets.setAppearance("dark");
  assert.match(assets.withAppearance(html), /<html data-theme-pick="dark" lang="en">/);
  for (const other of ["device", undefined, "sepia", '"><script>']) {
    assets.setAppearance(other);
    assert.equal(assets.withAppearance(html), html, `${other} leaves it to the device`);
  }
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/settings\/appearance"[\s\S]{0,400}\["device", "light", "dark"\]\.includes\(pick\)[\s\S]{0,700}patchSettings\(supabase, userId, \{ set: \{ appearance: pick, appearance_at: at \} \}\);\n    assets\.setAppearance\(pick, at\);/, "saved in the person's settings");
  assert.match(server, /assets\.setAppearance\(data\?\.settings\?\.appearance, data\?\.settings\?\.appearance_at\);/, "and read back when the app starts");
  assert.match(server, /res\.type\("html"\)\.send\(assets\.withAppearance\(assets\.forHost\(html\)\)\);/, "Privacy and Terms carry it");
  assert.match(server, /res\.send\(assets\.withAppearance\(require\("\.\/report-page"\)\.pageHtml\(report\)\)\);/, "Pages carry it");
  assert.match(read("webapp/report-page.js"), /:root\[data-theme-pick="dark"\] \{/, "and follow it");
});

test("light or dark is the sun, moon and the two in one at the top, as on closedhand.com, not a card in Settings", () => {
  const chat = read("webapp/views/index.html");
  const site = read("closedhand-com/views/home.html");
  const button = site.slice(site.indexOf('<button type="button" class="theme-toggle"'), site.indexOf("</button>", site.indexOf('class="theme-toggle"')) + 9);
  assert.equal(chat.split(button).length - 1, 1, "the site's own button, in the web chat's top bar only: the dashboard and My Account follow it");
  assert.doesNotMatch(chat.slice(chat.indexOf('<div class="dash-slide-header">'), chat.indexOf('<iframe id="dashIframe"')), /theme-toggle/, "none in the dashboard's own header");
  assert.match(chat, /<div class="header-right">\s*<button type="button" class="theme-toggle"/, "first at the top, as on the site");
  assert.match(chat, /<div class="dash-slide-actions">\s*<button class="dash-slide-close"/, "the dashboard's header holds only its close button");
  const dash = read("webapp/views/dashboard.html");
  assert.doesNotMatch(dash, /<h2>Appearance<\/h2>|id="appearance"|Match this device/);
  const theme = read("webapp/public/theme.js");
  assert.match(theme, /var was = pick\(\), next = nextPick\(\), before = current\(\);/, "it moves to the next pick (scripts/test-theme-travels.js taps through them)");
  assert.match(theme, /frame\.contentWindow\.closedhandTheme\.follow\(to\)/, "the dashboard follows at once");
  assert.match(theme, /fetch\('\/api\/settings\/appearance', \{ method: 'POST'/, "kept in settings, for every device");
  const css = read("webapp/public/interface.css");
  for (const rule of [":root:not([data-theme-pick=\"light\"]) .theme-toggle .sun { translate: 80% 0; opacity: 0; }", ":root:not([data-theme-pick=\"dark\"]) .theme-toggle .moon { translate: -80% 0; opacity: 0; }", ":root:is([data-theme-pick=\"light\"], [data-theme-pick=\"dark\"]) .theme-toggle .device svg { translate: 0 170%; rotate: -150deg; }", ".theme-toggle:active > span { scale: .85; }"])
    assert.ok(css.includes(rule) && read("closedhand-com/public/interface.css").includes(rule), "the same look as the site: " + rule);
});

test("Settings is the last tab", () => {
  const tabs = [...read("webapp/views/dashboard.html").matchAll(/<button class="tab[^"]*" data-tab="([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(tabs[tabs.length - 1], "settings");
  assert.deepEqual(tabs.slice(-3), ["pages", "brain", "settings"], "Usage is part of My Account, from the foot of Settings");
});

// Density, as closedhand.com's: every size in rem (px / 16), so one root size
// sets it. 1rem is 16px on phones and tablets; computers show everything at
// 90%, the density a laptop suits, never through CSS zoom or transforms.
test("every page the app serves sizes in rem, so computers get their density from one root size", () => {
  const files = [
    ...fs.readdirSync(path.join(root, "webapp/views")).filter((f) => f.endsWith(".html")).map((f) => "webapp/views/" + f),
    ...fs.readdirSync(path.join(root, "webapp/public")).filter((f) => f.endsWith(".css")).map((f) => "webapp/public/" + f),
    "webapp/projects.js", "webapp/report-page.js",
  ];
  const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  for (const file of files) {
    // Pixels stay for hairlines (2px or less), media and container query
    // conditions, url(), comments, and positions measured at runtime.
    const text = read(file)
      .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, "")
      .replace(/(^|[\s;{}(])\/\/[^\n]*/gm, "$1")
      .replace(/@(?:media|container|supports)[^{]*\{|url\([^)]*\)|matchMedia\(\s*(['"`])[\s\S]*?\1/g, "")
      .replace(new RegExp(String.raw`\(\s*(?:min|max)-(?:width|height|device-width)\s*:\s*` + NUM + String.raw`px\s*\)`, "g"), "");
    const sizes = (text.match(new RegExp(String.raw`(?<![\w.#$-])` + NUM + String.raw`px\b`, "g")) || []).filter((v) => Math.abs(parseFloat(v)) > 2);
    assert.deepEqual(sizes, [], `${file} sizes in rem (px / 16)`);
    // An icon's size follows the root size too; its strokes stay in its own units.
    assert.doesNotMatch(read(file), /<svg\b[^>]*\swidth=\\?["']\d+(?:\.\d+)?\\?["']/, `${file} sizes its icons in rem`);
  }
  const rootSize = /html \{ font-size: 100%; \}\n@media screen and \(hover: hover\) and \(pointer: fine\) \{ html \{ font-size: 90%; \} \}/;
  assert.match(read("webapp/public/interface.css"), rootSize, "the one root size, which every view loads");
  for (const view of fs.readdirSync(path.join(root, "webapp/views")).filter((f) => f.endsWith(".html"))) {
    assert.match(read("webapp/views/" + view), /href="\/interface\.css"/, `${view} loads the root size`);
  }
  assert.match(read("webapp/projects.js"), rootSize, "a project's page");
  assert.match(read("webapp/report-page.js"), rootSize, "a page Closedhand made, at full size when printed");
  assert.doesNotMatch(files.map(read).join("\n"), /(?:^|[\s}])(?:html|body|:root)\s*\{[^}]*\b(?:zoom|transform)\s*:/, "never zoom or a transform on the page for density");
});
