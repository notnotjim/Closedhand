// Moved to Railway with Go always-on, Closedhand lives in the person's own
// Railway account, so nothing it shows there may say their data is "on your
// computer". Each such sentence carries its Railway wording (data-railway in
// pages, hostText or a host check in scripts), put in place as it is served.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { forHost } = require("../webapp/assets");

const views = fs.readdirSync(path.join(__dirname, "..", "webapp", "views")).filter((f) => f.endsWith(".html"));
// Text a person reads, without scripts, styles or tags.
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");

test("on Railway no served page says Closedhand's data is on your computer", () => {
  for (const view of views) {
    const html = read("webapp/views/" + view);
    const served = forHost(html, true);
    assert.doesNotMatch(served, /data-railway=/, view + ": every Railway wording is put in place");
    // The privacy policy says once what "your computer" means on Railway.
    if (view === "privacy.html") continue;
    assert.doesNotMatch(visible(served), /\byour (own )?computer\b/i, view);
  }
});

test("on a person's own computer the pages are served as written", () => {
  const setup = read("webapp/views/setup.html");
  assert.equal(forHost(setup, false), setup);
  const served = forHost(setup, true);
  assert.match(served, /<html data-host="railway"/);
  assert.match(served, /<p>Welcome\. Closedhand is an AI assistant that lives in your own Railway account and gives you total sovereignty over your own data\.<\/p>/);
  assert.match(setup, /<p data-railway="Welcome\. Closedhand is an AI assistant that lives in your own Railway account and gives you total sovereignty over your own data\.">Welcome\. Closedhand is an AI assistant that lives on your own computer and gives you total sovereignty over your own data\.<\/p>/);
  assert.match(setup, /<p class="note hint" id="mac-calendar-note" hidden>Click Allow when your Mac asks to give Closedhand permission to use your calendar\. Nothing goes to closedhand\.com\.<\/p>/);
  assert.match(setup, /\$\("#mac-calendar-note"\)\.hidden = !state\.desktop;/, "only on the Mac app, where macOS asks");
  assert.match(setup, />Google's sign-in shows Closedhand's name, but your mail goes straight between Google and your computer, with no company in between\.<\/p>/);
  assert.match(setup, />Microsoft's sign-in shows Closedhand's name, but your mail goes straight between Microsoft and your computer, with no company in between\.<\/p>/);
  for (const f of ["desktop/Info.plist", "bridge-app/Info.plist"]) assert.match(read(f), /Closedhand reads your calendar to answer questions about your schedule and adds events when you ask\. Your calendar stays on this Mac\./, f);
});

test("what scripts write follows the host too", () => {
  const dash = read("webapp/views/dashboard.html");
  const script = dash.slice(dash.indexOf("function hostText("));
  assert.doesNotMatch(script.replace(/hostText\([^)]*\)/g, ""), /(Stays on your own computer|never leaves your computer|keeps for you on your own computer)/);
  assert.match(read("webapp/public/connection-catalogue.js"), /const HOME=typeof document!=='undefined'&&document\.documentElement&&document\.documentElement\.dataset\.host==='railway'\?'in your Railway account':'on your computer';/);
  for (const f of ["lib/automations.js", "lib/platforms/line.js"]) {
    assert.doesNotMatch(read(f).replace(/\$\{process\.env\.RAILWAY_ENVIRONMENT_ID \? [^}]+\}/g, ""), /your own computer/, f);
  }
  for (const page of ["webapp/views/privacy.html", "closedhand-com/views/privacy.html"]) {
    assert.match(read(page), /If you move Closedhand to Railway from My Account, it runs in your own Railway account instead, and “your computer” in this policy means that Railway account\./, page);
  }
});

test("the setup code is found where the host keeps it, and only Railway is named on Railway", () => {
  const lede = (html) => visible(html.match(/<p class="lede">[\s\S]*?<\/p>/)[0]).replace(/\s+/g, " ").trim();
  const page = read("webapp/views/setup-code.html");
  assert.match(lede(forHost(page, false)), /from where you created it\. It's saved there as SETUP_CODE\.$/);
  assert.doesNotMatch(lede(forHost(page, false)), /Railway/, "another host is not told to look on Railway");
  assert.match(lede(forHost(page, true)), /On Railway it's in your project, under the webapp service's Variables, as SETUP_CODE\.$/);
  assert.match(read("webapp/views/login.html"), /document\.documentElement\.dataset\.host === "railway"\n\s+\? "On Railway it's under the webapp service's Variables, as SETUP_CODE\."\n\s+: "It's saved as SETUP_CODE where you created this Closedhand\."/);
});
