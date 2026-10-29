const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync(require.resolve("../webapp/views/dashboard.html"), "utf8");
const source = fs.readFileSync(require.resolve("../webapp/server"), "utf8");
const region = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const address = "https://example.closedhand.ai";
function page() {
  const elements = {};
  const el = id => elements[id] ||= { hidden: false, style: {}, textContent: "", focus() {} };
  let removed = false, selected = false, fallback = false;
  const state = vm.createContext({
    URL, navigator: { clipboard: { writeText: async text => { state.copied = text; } } },
    document: {
      getElementById: el,
      body: { appendChild() {} },
      createElement: () => ({ style: {}, select() { selected = true; }, remove() { removed = true; } }),
      execCommand: command => { assert.equal(command, "copy"); return fallback; },
    },
    escHtml: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    clearTimeout() {}, setTimeout: () => { state.polls++; }, askFirst: async () => ({ checked: false }),
    polls: 0,
  });
  vm.runInContext("var _phone, _phonePoll;\n" + region(html, "    async function loadPhoneAccess()", "    // === Usage tab"), state);
  return { state, el, fallback: value => { fallback = value; }, cleanup: () => ({ removed, selected }) };
}
const ready = { enabled: true, permanent: true, mode: "managed", state: "on", url: address, savedUrl: address };
test("a ready address is copyable without showing setup or expanded instructions", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  assert.equal(el("phone-live").hidden, false);
  assert.equal(el("phone-url").href, address + "/");
  assert.equal(el("phone-setup").hidden, true);
  assert.equal(el("phone-options").open, undefined);
  assert.equal(state.polls, 0);
  await state.copyDashboardLink();
  assert.equal(state.copied, address + "/");
  assert.equal(el("phone-copy").textContent, "Copied");
});
test("a paused or reconnecting permanent address stays copyable, without claiming it is ready", () => {
  for (const status of [{ enabled: false, state: "off" }, { enabled: true, state: "error" }]) {
    const { state, el } = page();
    state.renderPhone({ ...ready, ...status, url: null });
    assert.equal(el("phone-url").href, address + "/");
    assert.equal(el("phone-setup").hidden, true);
    assert.match(el("phone-desc").textContent, status.enabled ? /Reconnecting/ : /paused/);
    assert.equal(el("phone-qr-details").hidden, true);
    assert.equal(state.polls, status.enabled ? 1 : 0);
  }
});
test("first setup, pairing and temporary connections have distinct next steps", () => {
  const { state, el } = page();
  state.renderPhone({ enabled: false, state: "off" });
  assert.equal(el("phone-live").hidden, true);
  assert.equal(el("phone-setup").hidden, false);
  assert.equal(el("phone-options").hidden, true);
  state.renderPhone({ enabled: true, state: "pairing", permanent: true, pairingUrl: "https://closedhand.com/phone-access/pair#fixture" });
  assert.equal(el("phone-live").hidden, true);
  assert.equal(el("phone-setup-link").hidden, false);
  assert.equal(el("phone-setup-link").href, "https://closedhand.com/phone-access/pair#fixture");
  state.renderPhone({ enabled: true, state: "on", url: "https://test.trycloudflare.com" });
  assert.equal(el("phone-setup").hidden, false);
  assert.equal(el("phone-save").hidden, true);
  assert.match(el("phone-link-help").textContent, /temporary/);
});
test("an embedded-browser clipboard denial falls back to selection and cleans up", async () => {
  const p = page();
  p.state.renderPhone(ready);
  p.state.navigator.clipboard.writeText = async () => { throw Error("Denied"); };
  p.fallback(true);
  await p.state.copyDashboardLink();
  assert.equal(p.el("phone-copy").textContent, "Copied");
  assert.deepEqual(p.cleanup(), { removed: true, selected: true });
});
test("copy failure gives manual instructions instead of false success", async () => {
  const p = page();
  p.state.renderPhone(ready);
  p.state.navigator.clipboard = undefined;
  await p.state.copyDashboardLink();
  assert.equal(p.el("phone-copy").textContent, "Copy");
  assert.match(p.el("phone-copy-status").textContent, /Touch and hold/);
  assert.equal(p.cleanup().removed, true);
});
test("pausing and resuming preserve the address and managed mode; cancelled pause does nothing", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  let calls = 0;
  state.fetch = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.mode, "managed");
    return { ok: true, json: async () => ({ ...body, state: body.enabled ? "starting" : "off", permanent: true }) };
  };
  state.askFirst = async () => false;
  await state.togglePhoneAccess();
  assert.equal(calls, 0);
  state.askFirst = async () => ({ checked: false });
  await state.togglePhoneAccess();
  assert.equal(calls, 1);
  assert.equal(el("phone-btn").textContent, "Resume link");
  assert.equal(el("phone-url").href, address + "/");
  await state.togglePhoneAccess();
  assert.equal(calls, 2);
  assert.match(el("phone-desc").textContent, /Reconnecting/);
});
test("failed requests stay visible and do not silently change the connection", async () => {
  const { state, el } = page();
  state.renderPhone(ready);
  state.fetch = async () => ({ ok: false, json: async () => ({ error: "Try again later" }) });
  await state.togglePhoneAccess();
  assert.equal(el("phone-btn").disabled, false);
  assert.equal(el("phone-btn").textContent, "Pause link");
  assert.equal(el("phone-desc").textContent, "Try again later");
  await state.loadPhoneAccess();
  assert.match(el("phone-desc").innerHTML, /Try again/);
});
test("the dashboard status route authenticates before reading only public address details", async () => {
  let handler, allowed = false, reads = 0, output;
  const state = vm.createContext({
    app: { get: (_, fn) => { handler = fn; } },
    requireSetupAccess: async () => allowed,
    getRuntimeConf: async key => { reads++; assert.ok(["PHONE_PERMANENT_URL", "PHONE_ADDRESS_NAME"].includes(key)); return key === "PHONE_ADDRESS_NAME" ? "example" : address; },
    require: name => { assert.equal(name, "./phone-registration"); return { validAddress: url => url === address, serviceAvailable: async () => false }; },
    phoneAccess: { status: () => ({ enabled: false, state: "off", url: null }) },
  });
  vm.runInContext(region(source, 'app.get("/api/phone",', 'app.post("/api/phone",'), state);
  const response = { set(name, value) { assert.equal(name, "Cache-Control"); assert.equal(value, "no-store"); return this; }, json(data) { output = data; } };
  await handler({}, response);
  assert.equal(reads, 0);
  assert.equal(output, undefined);
  allowed = true;
  await handler({}, response);
  assert.equal(output.savedUrl, address);
  assert.equal(output.addressName, "example");
  assert.equal(reads, 2);
  assert.equal(output.enabled, false);
  assert.equal(output.serviceAvailable, false, "setup learns whether closedhand.com can give one out");
  state.getRuntimeConf = async () => "https://untrusted.example";
  await handler({}, response);
  assert.equal(output.savedUrl, null);
});
test("Settings offers a picked personal URL, and renames a lasting one with a tidied preview", async () => {
  const { state, el } = page();
  state.renderPhone({ enabled: false, state: "off" });
  assert.equal(el("phone-start").textContent, "Claim your personal URL");
  assert.equal(el("phone-change-line").hidden, true, "nothing to rename yet");
  assert.doesNotMatch(html, /id="phone-address-name"/, "no name to choose");
  const sent = [];
  state.fetch = async (url, options) => { sent.push([url, options && JSON.parse(options.body)]); return { ok: true, json: async () => ({ enabled: true, state: "pairing", pairingUrl: "https://closedhand.com/phone-access/pair#t" }) }; };
  await state.startDashboardLink();
  assert.deepEqual(sent[0], ["/api/phone", { enabled: true, mode: "managed" }]);
  state.renderPhone(ready);
  assert.equal(el("phone-change-line").hidden, false);
  el("phone-rename").hidden = true;
  state.toggleDashboardRename({ preventDefault() {} });
  assert.equal(el("phone-rename").hidden, false);
  el("phone-new-name").value = "  Lucy Smith! ";
  state.previewDashboardRename();
  assert.equal(el("phone-new-preview").textContent, "lucy-smith.closedhand.ai");
  sent.length = 0;
  state.fetch = async (url, options) => { sent.push([url, options && options.body && JSON.parse(options.body)]); return url === "/api/phone/rename" ? { ok: true, json: async () => ({ renamedTo: "https://lucy-smith.closedhand.ai", ...ready }) } : { ok: true, json: async () => ready }; };
  await state.renameDashboardLink();
  assert.deepEqual(sent[0], ["/api/phone/rename", { name: "  Lucy Smith! " }]);
  assert.match(el("phone-desc").textContent, /now at lucy-smith\.closedhand\.ai/);
  assert.equal(el("phone-rename").hidden, true);
  state.renderPhone({ enabled: true, state: "on", url: "https://test.trycloudflare.com" });
  assert.equal(el("phone-change-line").hidden, true, "a temporary address cannot be renamed");
  // A refusal stays readable.
  state.fetch = async () => ({ ok: false, json: async () => ({ error: "That name is taken. Try another." }) });
  el("phone-rename").hidden = false;
  await state.renameDashboardLink();
  assert.equal(el("phone-rename-status").textContent, "That name is taken. Try another.");
});
test("the optional dashboard QR encodes the same address as Copy while preserving the save-page QR", async () => {
  let handler, encoded;
  const state = vm.createContext({
    URL, app: { get: (_, fn) => { handler = fn; } },
    requireSetupAccess: async () => true,
    phoneAccess: { status: () => ({ url: address }) },
    require: name => name === "./config" ? { dashboardBase: async () => address }
      : { toString: async url => { encoded = url; return "<svg/>"; } },
  });
  vm.runInContext(region(source, 'app.get("/api/phone/qr.svg",', 'phoneAccess.boot();'), state);
  const response = { set() { return this; }, send() {} };
  await handler({ query: { destination: "dashboard" } }, response);
  assert.equal(encoded, address + "/");
  await handler({ query: { destination: "//untrusted.example" } }, response);
  assert.equal(encoded, address + "/keep");
});
test("the dashboard offers a personal URL to a Closedhand without one, and nothing more", async () => {
  const code = region(html, "    async function loadPersonalUrlPrompt()", "    async function loadScopeWarnings()");
  const els = {}, calls = [];
  const el = id => els[id] ||= { hidden: true, scrollIntoView() {} };
  let reply;
  const state = vm.createContext({
    document: { getElementById: el }, fetch: async () => ({ ok: true, json: async () => reply }),
    switchTab: tab => calls.push("tab:" + tab), startDashboardLink: () => calls.push("start"),
  });
  vm.runInContext(code, state);
  for (const [phone, shown, why] of [
    [{ enabled: false, state: "off" }, true, "skipped in setup"],
    [{ enabled: true, state: "on", url: "https://x.trycloudflare.com", permanent: false }, true, "only a temporary link"],
    [{ enabled: false, state: "off", savedUrl: address }, false, "has one, paused"],
    [ready, false, "has one"],
    [{ enabled: true, permanent: true, state: "pairing", pairingUrl: "https://closedhand.com/phone-access/pair#t" }, false, "on its way"],
    [{ enabled: false, state: "unavailable" }, false, "this version can't"],
  ]) {
    reply = phone; await state.loadPersonalUrlPrompt();
    assert.equal(el("personal-url-notice").hidden, !shown, why);
  }
  assert.doesNotMatch(html, /personal-url-notice-done|Not now/, "no dismiss: it goes once there is one");
  state.getPersonalUrlFromPrompt();
  assert.deepEqual(calls, ["tab:settings", "start"]);
  assert.equal(el("personal-url-notice").hidden, true);
  assert.doesNotMatch(source, /PHONE_ADDRESS_NOTICE|api\/phone\/notice/, "no start-up offer for existing installs");
});

// My Account: the Closedhand account, its plan and Closedhand+, and Delete account.
function accountPage(respond) {
  const elements = {};
  const el = id => elements[id] ||= { id, hidden: true, disabled: false, textContent: "", dataset: {}, style: {}, attrs: {}, classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...parts) { this.textContent += parts.map(p => typeof p === "string" ? p : p.textContent).join(""); } };
  const calls = [];
  const state = vm.createContext({
    URL, window: { location: {} },
    document: { getElementById: el, createElement: () => ({ textContent: "", append(...parts) { this.textContent += parts.map(p => typeof p === "string" ? p : p.textContent).join(""); } }), querySelector: () => null },
    fetch: async (url, options = {}) => { calls.push([options.method || "GET", url]); const r = respond(url, options); return { ok: !r.status || r.status < 400, json: async () => r.body }; },
    showToast: message => calls.push(["toast", message]),
    hostText: (computer) => computer,
  });
  vm.runInContext(region(html, "    function cancelAccountAction(action)", "    function switchTab(tabName)"), state);
  return { state, el, calls };
}
test("My Account shows the Closedhand account whole, and Delete account says exactly what goes", async () => {
  const day = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const withAccount = accountPage(() => ({ body: { account: { provider: "google", email: "a@example.com", url: "https://amber-fox-42.closedhand.ai",
    signIns: [{ provider: "google", email: "a@example.com" }, { provider: "microsoft", email: "b@example.com" }],
    plan: { name: "plus", renews_at: "2026-12-15T09:00:00.000Z" }, used: 0.42,
    plus: { available: true, active: true, nearly: false, extended: false, renews_at: "2026-12-15T09:00:00.000Z", prices: { plus: "$10", extend: "$8" },
      card: { brand: "visa", last4: "4242", expires: "08/29" } } } } }));
  await withAccount.state.loadMyAccount();
  assert.equal(withAccount.el("my-account-facts").textContent, "Personal URLamber-fox-42.closedhand.aiSign in withGoogle: a@example.com \u00b7 Microsoft: b@example.com");
  assert.equal(withAccount.el("my-plan").hidden, false);
  assert.equal(withAccount.el("my-plan-state").textContent, "Renews on 15 December.");
  assert.deepEqual([withAccount.el("my-plan-status").textContent, withAccount.el("my-plan-status").className], ["Active", "plan-status on"]);
  assert.equal(withAccount.el("my-plus-about").hidden, true, "a subscriber is not sold it again");
  assert.equal(withAccount.el("my-fair-use").hidden, false);
  assert.equal(withAccount.el("my-fair-use-fill").style.width, "42%", "one bar, never an amount");
  const barely = accountPage(() => ({ body: { account: { provider: "google", email: "a@example.com", url: "https://amber-fox-42.closedhand.ai", plan: { name: "first-month", ends_at: day(20) }, used: 0.003, plus: { available: false } } } }));
  await barely.state.loadMyAccount();
  assert.equal(barely.el("my-fair-use-fill").style.width, "1%", "a little use still shows, so the bar never looks broken");
  for (const [file, line] of [["webapp/views/dashboard.html", '$("my-fair-use-fill").style.width = Math.max(1, share) + "%";'], ["closedhand-com/public/account.js", "$('fair-use-fill').style.width = Math.max(1, share) + '%';"]])
    assert.ok(require("fs").readFileSync(require("path").join(__dirname, "..", file), "utf8").includes(line), file + " draws the same sliver");
  assert.match(html, /<p class="fair-use-label">Payment history<\/p>/);
  assert.deepEqual([withAccount.el("my-plus-get").hidden, withAccount.el("my-card-row").hidden, withAccount.el("action-plus-cancel").hidden, withAccount.el("action-plus-keep").hidden, withAccount.el("my-plus-extend").hidden], [true, false, false, true, true]);
  assert.equal(withAccount.el("my-card-desc").textContent, "Visa ending 4242, expires 08/29", "the card it is paid with, shown");
  assert.equal(withAccount.el("my-cancel-desc").textContent, "Closedhand+ stays on until 15 December, then ends.");
  assert.equal(withAccount.el("plus-cancel-text").textContent, "Closedhand+ ends on 15 December and is not charged again. Until then you can keep Closedhand+ after all.");
  assert.match(withAccount.el("delete-account-text").textContent, /^This deletes your Closedhand account: amber-fox-42\.closedhand\.ai stops working and closedhand\.com forgets your sign-in\. It also permanently deletes everything Closedhand keeps for you on your own computer/);
  const html2 = fs.readFileSync(require.resolve("../webapp/views/dashboard.html"), "utf8");
  for (const [id, call] of [["my-plus-get", "openPolar\\('checkout', 'plus'\\)"], ["my-plus-extend", "openPolar\\('checkout', 'extend'\\)"]]) {
    assert.match(html2, new RegExp(`id="${id}" hidden onclick="${call}"`), id);
  }
  // Rows like Your data's: Change, and Cancel with a word to type, as Delete account has.
  assert.match(html2, /<div class="account-action-title">Card<\/div>[\s\S]{0,160}<button type="button" class="account-action-btn" onclick="openPolar\('card'\)">Change<\/button>/);
  assert.match(html2, /<button type="button" class="account-action-btn account-action-btn-danger" onclick="startAccountAction\('plus-cancel'\)">Cancel<\/button>/);
  assert.match(html2, /<input class="confirm-type-input" id="input-plus-cancel" placeholder="Type CANCEL" oninput="checkConfirmInput\('plus-cancel','CANCEL'\)">/);
  assert.match(html2, /if \(cancel && !button\.classList\.contains\("enabled"\)\) return;/, "never cancelled without the word typed");
  const cancelled = accountPage(() => ({ body: { account: { provider: "google", url: "https://amber-fox-42.closedhand.ai", plan: { name: "plus", ends_at: "2026-12-15T09:00:00.000Z" }, used: 0.5,
    plus: { available: true, active: true, ends_at: "2026-12-15T09:00:00.000Z", prices: {} } } } }));
  await cancelled.state.loadMyAccount();
  assert.deepEqual([cancelled.el("action-plus-cancel").hidden, cancelled.el("action-plus-keep").hidden], [true, false], "cancelled: Closedhand+ can be kept until it ends");
  assert.equal(cancelled.el("my-card-desc").textContent, "The card Closedhand+ is paid with.", "no card known: said plainly");
  assert.equal(cancelled.el("my-keep-desc").textContent, "Closedhand+ will carry on past 15 December and renew every month.");
  assert.deepEqual([cancelled.el("my-plan-status").textContent, cancelled.el("my-plan-status").className, cancelled.el("my-plan-status").hidden], ["Cancelled", "plan-status cancelled", false], "cancelled: a status word, in red");
  assert.equal(cancelled.el("my-plan-state").textContent, "Closedhand+ stays on until 15 December, then ends.");

  const ended = accountPage(() => ({ body: { account: { provider: "google", url: "https://amber-fox-42.closedhand.ai", plan: { name: "ended", was: "plus", ended_at: "2026-12-15T09:00:00.000Z" },
    plus: { available: true, active: false, prices: { plus: "$10" } } } } }));
  await ended.state.loadMyAccount();
  assert.deepEqual([ended.el("my-plan-status").textContent, ended.el("my-plan-state").textContent, ended.el("my-plus-get").textContent],
    ["Ended", "Closedhand+ ended on 15 December.", "Renew Closedhand+ \u00b7 $10 a month"], "over: said when, and the way back");

  const own = accountPage(() => ({ body: { account: { provider: "google", email: "a@example.com", url: "https://amber-fox-42.closedhand.ai", plan: { name: "none" },
    plus: { available: true, active: false, prices: { plus: "$10" } } } } }));
  await own.state.loadMyAccount();
  assert.equal(own.el("my-plan-state").hidden, true, "nothing said about a plan they don't have");
  assert.equal(own.el("my-plus-about").textContent, "Closedhand Managed Models every month, so you need no LLM provider of your own. They run through OpenRouter, only on LLM providers that do not store or train on your data or conversations.");
  assert.equal(own.el("my-plus-fine").textContent, "Cancel any time.");
  assert.equal(own.el("my-fair-use").hidden, true);
  assert.equal(own.el("my-plus-get").textContent, "Get Closedhand+ \u00b7 $10 a month");
  assert.equal(own.el("my-plus-get").hidden, false);

  const first = accountPage(() => ({ body: { account: { provider: "google", url: "https://amber-fox-42.closedhand.ai", plan: { name: "first-month", ends_at: day(20) }, used: 0.1, plus: { available: false } } } }));
  await first.state.loadMyAccount();
  assert.equal(first.el("my-plan-state").textContent, "Your first month of Closedhand Managed Models is running.", "its end is said in its last week only");
  assert.equal(first.el("my-plus-get").hidden, true, "nothing on sale, nothing offered");

  const without = accountPage(() => ({ body: { account: null } }));
  await without.state.loadMyAccount();
  assert.match(without.el("my-account-facts").textContent, /^Signed in withNothing yet\. Claiming a personal URL creates your Closedhand account/);
  assert.equal(without.el("my-plan").hidden, true);
  assert.match(without.el("delete-account-text").textContent, /^This permanently deletes everything Closedhand keeps for you on your own computer/);
  const offline = accountPage(() => ({ body: { account: null, unreachable: true } }));
  await offline.state.loadMyAccount();
  assert.match(offline.el("my-account-facts").textContent, /closedhand\.com can't be reached/, "nothing claimed when closedhand.com can't say");
});

test("Settings ends with My Account, the account's one home, and Usage is part of it", () => {
  const settings = html.slice(html.indexOf('<div class="tab-content" id="tab-settings">'), html.indexOf('<div class="tab-content" id="tab-brain">'));
  assert.match(settings, /<div class="my-account-way"><a class="deep" href="#account" onclick="openMyAccount\(\); return false;">My Account<\/a><\/div>\s*<\/div>\s*<\/div>\s*$/, "at the foot of Settings");
  assert.doesNotMatch(settings, /id="always-on"|id="account-section"|account-facts|id="my-plan"|id="usage-/, "nothing of My Account repeated in Settings");
  const account = html.slice(html.indexOf('<div class="tab-content" id="tab-account">'), html.indexOf('<div id="toast"'));
  for (const id of ["my-account-card", "my-plan", "usage-tiles", "always-on", "account-section", "action-delete-account"]) assert.match(account, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /data-tab="usage"|id="tab-usage"/, "no Usage tab of its own");
  const menu = html.slice(html.indexOf('<details class="dashboard-help" id="dashboard-account">'), html.indexOf('</details>', html.indexOf('id="dashboard-account"')));
  assert.match(menu, /<a href="#account" onclick="this\.closest\('details'\)\.open = false; openMyAccount\(\); return false;">My Account<\/a>\s*<a href="\/logout" class="logout-link">Sign out<\/a>/, "top right on every tab, with Sign out");
  assert.ok(html.indexOf("classList.add('in-slideover')") < html.indexOf("<body"), "marked before anything is drawn");
  assert.doesNotMatch(html, /Welcome, <span|class="header-row"/, "no header that only the panel hid");
  assert.match(html, /\(window\.parent !== window \? window\.top : window\)\.location\.href = '\/';/, "signing out leaves the whole page");
  assert.match(html, /\} else if \(\/\^account\(\\\/\(welcome\|extended\)\)\?\$\/\.test\(resolved\)\) \{\n\s*if \(inAccountPopup\(\)\) setAccountMode\(true\); else switchTab\('account'\);\n\s*if \(resolved === 'account\/welcome'\) plusWelcome\(\); else myAccountSaid\(resolved\.split\('\/'\)\[1\]\);/, "closedhand.com/account opens it, back from Polar too");
});
test("Delete account stops when closedhand.com can't be reached, and deletes anyway only when asked", async () => {
  const page = accountPage((url) => url.includes("anyway=1") ? { body: { success: true, redirect: "/" } }
    : { status: 502, body: { accountUnreachable: true, error: "closedhand.com couldn’t be reached, so nothing was deleted." } });
  await page.state.executeAccountAction("delete-account");
  assert.deepEqual(page.calls, [["DELETE", "/api/account"]]);
  assert.equal(page.el("delete-account-offline").hidden, false);
  assert.match(page.el("delete-account-offline").textContent, /nothing was deleted/);
  assert.equal(page.el("go-delete-anyway").hidden, false);
  assert.equal(page.state.window.location.href, undefined, "still here");
  await page.state.executeAccountAction("delete-account", true);
  assert.deepEqual(page.calls.at(-1), ["DELETE", "/api/account?anyway=1"]);
  assert.equal(page.state.window.location.href, "/");
  // The route deletes the Closedhand account before anything on this computer.
  const route = region(source, 'app.delete("/api/account"', "// SUPABASE HELPERS");
  assert.ok(route.indexOf("deleteAccount()") > 0 && route.indexOf("deleteAccount()") < route.indexOf("WIPE_TABLES"));
  assert.match(route, /req\.query\.anyway !== "1"/);
  assert.ok(route.indexOf("phoneAccess.disable()") < route.indexOf("WIPE_TABLES"), "the personal URL connection stops too");
});

test("Closedhand's two addresses are two matching cards side by side: its personal URL and its email address", () => {
  assert.match(html, /<section class="dashboard-link-section" id="addresses" aria-labelledby="addresses-heading">\n\s*<h2 id="addresses-heading">Closedhand addresses<\/h2>\n\s*<div class="address-parts">\n\s*<div class="address-card" id="phone-block" style="display:none;">\n\s*<div class="address-head"><svg[^\n]*<h3 class="address-title" id="phone-heading">Personal URL<\/h3><\/div>/);
  assert.match(html, /<div class="address-card">\n\s*<div class="address-head"><svg[^\n]*<h3 class="address-title" id="assistant-email-heading">Closedhand’s email address<\/h3><\/div>\n\s*<div id="assistant-email"><\/div>/);
  assert.match(html, /<div class="address-foot">\n\s*<p id="phone-change-line" hidden>[\s\S]*?<details id="phone-options" hidden>/, "Change URL and Link options share the card's footer");
  assert.match(html, /getElementById\('phone-block'\)\.style\.display = '';/, "shown as a card, not forced to block");
  assert.doesNotMatch(html, /settings-group-header"><h2 id="assistant-email-heading"/, "no separate full-width card for email");
  const css = fs.readFileSync(require.resolve("../webapp/public/interface.css"), "utf8");
  assert.match(css, /\.address-parts \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 21.25rem\), 1fr\)\); gap: 1rem; align-items: stretch;/, "side by side and equal height, stacked on a phone");
  assert.match(css, /\.address-card \{ display: flex; flex-direction: column;[^}]*background: var\(--raised\); border: 1px solid rgba\(var\(--fg-rgb\),0\.1\); border-radius: 0.75rem; \}/, "each its own card");
  assert.match(css, /#addresses \.address-foot \{ margin-top: auto; padding-top: 0.75rem; border-top: 1px solid/, "footers sit at the bottom, divided");
  assert.match(css, /#addresses \.address-foot > p, #addresses \.address-foot summary \{ padding: 0; min-height: 2rem; font-size: 0.875rem; line-height: 2rem; \}/, "footer rows match across both cards");
  const email = fs.readFileSync(require.resolve("../webapp/public/assistant-email.js"), "utf8");
  // Its own address, never read as the person's own one to verify.
  assert.match(email, /heading\.textContent = 'Closedhand’s email address';/);
  assert.match(email, /'An email address of its own, like an assistant has\. Email it, forward things to it or CC it into a conversation\.'/);
  assert.match(email, /button\(state\.pending \? 'Finish creating the address' : 'Create the address',/);
  assert.doesNotMatch(email, /'(Confirm|Enable) email address'|'Email address'/);
  assert.match(email, /allowance\.classList\.add\('address-foot'\);/);
});

test("location is set where it shows, not in a Settings card", () => {
  assert.doesNotMatch(html, /id="location-section"|Locate me|location-manual-input/, "no Location card in Settings");
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /<button class="here" id="hereBtn"/, "the chat page sets it from the browser and shows the weather there");
  assert.match(chat, /if \(t\) \{ flipUnit\(t\); return; \}\n\s*if \(!e\.target\.closest\('\.wx-place'\)\) return;\n\s*wx\.hidden = true; btn\.hidden = false; btn\.click\(\);/, "the temperature flips the unit; the rest of the sentence sets the place again after a move");
  assert.match(chat, /' <button type="button" class="wx-place" data-tip="Moved\? Click to update your location\." aria-label="[^"]*">and ' \+ esc\(w\.label\) \+ where \+ '<\/button>/, "the whole rest of the sentence is the one control");
  const defs = fs.readFileSync(require.resolve("../lib/tools/definitions.js"), "utf8");
  assert.match(defs, /name: "save_location"/, "and Closedhand saves it when told in chat");
});

test("the weather line's tip shows at once, in the page's own quiet style", () => {
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /<span class="here-wx" id="hereWx" hidden><\/span>/);
  assert.match(chat, /class="wx-place" data-tip="Moved\? Click to update your location\."/);
  assert.doesNotMatch(chat, /\.wx-num small|<small>/, "the unit reads in the same tone as the number");
  assert.match(chat, /data-tip="Sets your local time from where you are and shows the weather here"/);
  assert.doesNotMatch(chat, /wx\.title = |id="hereBtn" type="button" hidden title=/, "no slow browser tooltip");
  assert.match(chat, /var info = e\.target\.closest\('\[data-tip\]'\);/, "drawn by the page's own instant tooltip");
  assert.doesNotMatch(chat, /\[data-tip\]::after/, "one tooltip, not two");
});

test("clicking the temperature flips it between Celsius and Fahrenheit, and the choice is kept everywhere", () => {
  const server = fs.readFileSync(require.resolve("../webapp/server.js"), "utf8");
  const a = server.indexOf("function weatherInUnit("), b = server.indexOf("\n}\n", a) + 3;
  const { weatherInUnit } = vm.runInNewContext(server.slice(a, b) + "\n({ weatherInUnit })");
  const w = { tempC: 26.4, defaultUnit: "C", label: "clear", kind: "clear", isDay: false, timezone: "Europe/Lisbon" };
  assert.deepEqual(JSON.parse(JSON.stringify(weatherInUnit(w, {}))), { label: "clear", kind: "clear", isDay: false, timezone: "Europe/Lisbon", temp: 26, unit: "C", other: { temp: 80, unit: "F" } }, "where they are, with the other unit ready");
  assert.equal(weatherInUnit(w, { temperature_unit: "F" }).temp, 80, "their choice wins");
  assert.equal(weatherInUnit({ ...w, defaultUnit: "F" }, { temperature_unit: "C" }).unit, "C");
  assert.match(server, /app\.post\("\/api\/here\/unit"/);
  assert.match(server, /await patchSettings\(supabase, userId, \{ set: \{ temperature_unit: unit \} \}\);/);
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /'<button type="button" class="wx-temp" data-tip="Click for \\u00b0' \+ other \+ '"/, "the number says what clicking it does");
  assert.match(chat, /fetch\('\/api\/here\/unit', \{ method: 'POST'/);
  assert.match(chat, /if \(still\) swap\(\); else \{ num\.classList\.add\('out'\); setTimeout\(swap, 160\); \}/, "no roll for people who turn motion off");
  const handlers = fs.readFileSync(require.resolve("../lib/tools/handlers.js"), "utf8");
  assert.match(handlers, /const chosenUnit = \(ctx\.activeUserStore \|\| ctx\.store\)\?\.profile\?\.settings\?\.temperature_unit;/, "Closedhand's weather answers use the same choice");
  assert.match(handlers, /temperature: deg\(current\.temperature_2m\)/);
});

test("a town's name comes from a second map service when the first can't be reached", async () => {
  const asked = [];
  const answers = { nominatim: null, photon: { features: [{ properties: { city: "Testville", county: "Sample County" } }] } };
  const box = { Map, AbortSignal, fetch: async (url) => {
    asked.push(url);
    const which = url.includes("nominatim") ? "nominatim" : "photon";
    if (!answers[which]) throw new Error("unreachable");
    return { ok: true, json: async () => answers[which] };
  } };
  vm.runInNewContext(region(source, "const OLD_STAND_IN", "\napp.get(\"/api/here\"") + "\nthis.placeNameAt = placeNameAt;", box);
  assert.equal(await box.placeNameAt(12.34, 56.78), "Testville", "Photon answers when Nominatim can't");
  assert.ok(asked.every((u) => u.includes("lat=12.34") && u.includes("lon=56.78")), "only the rounded position is sent");
  asked.length = 0;
  assert.equal(await box.placeNameAt(12.34, 56.78), "Testville");
  assert.equal(asked.length, 0, "a place already named is not asked again");
  answers.photon = null;
  assert.equal(await box.placeNameAt(1.5, 2.5), null, "no name when neither answers");
  assert.match(source, /if \(!name && Date\.now\(\) - \(_placeRetry\.get\(userId\) \|\| 0\) > 10 \* 60000\) \{\n\s*_placeRetry\.set\(userId, Date\.now\(\)\);\n\s*placeNameAt\(lat, lon\)\.then\(/, "a saved place with no name is looked up again on load, without waiting for it");
});

test("a place whose town couldn't be looked up has no name, never a stand-in", () => {
  // Some networks block OpenStreetMap, where the town's name comes from.
  const chat = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(chat, /var where = d\.location\.name \? ' in ' \+ esc\(d\.location\.name\) : ' here';/, "the line reads \"cloudy here\", not \"cloudy in where you are\"");
  assert.doesNotMatch(source, /name: name \|\| "where you are"/, "the stand-in is never saved as the name");
  assert.match(source, /if \(loc\.name === OLD_STAND_IN\) await patchSettings/, "a stand-in an older version saved is cleared");
  const box = {};
  vm.runInNewContext(region(source, "const OLD_STAND_IN", "\napp.get(\"/api/here\"") + "\nthis.placeName = placeName; this.kmApart = kmApart; this.SAME_TOWN_KM = SAME_TOWN_KM;", box);
  assert.equal(box.placeName({ name: "where you are" }), null);
  assert.equal(box.placeName({ name: "Porto" }), "Porto");
  assert.equal(box.placeName({ name: null }), null);
  const porto = { latitude: 41.15, longitude: -8.61 };
  assert.ok(box.kmApart(porto, { latitude: 41.13, longitude: -8.61 }) <= box.SAME_TOWN_KM, "across the river keeps the town's name");
  assert.ok(box.kmApart(porto, { latitude: 38.72, longitude: -9.14 }) > box.SAME_TOWN_KM, "another city does not");
  assert.match(source, /kmApart\(was, \{ latitude: lat, longitude: lon \}\) <= SAME_TOWN_KM\) name = placeName\(was\);/);
  assert.match(fs.readFileSync(require.resolve("../lib/location.js"), "utf8"), /const named = location\.name \? /, "the location line leaves out a missing name");
  for (const f of ["../lib/engine.js", "../lib/agents.js"]) {
    assert.match(fs.readFileSync(require.resolve(f), "utf8"), /require\("\.\/location"\)\.locationLine\((ctx\.store|userStore)\.location\)/, `${f} states the location with that line`);
  }
});

test("Polar's own forms open over the whole window in a frame, and only Polar's messages from that frame are heard", async () => {
  // The dashboard builds the form's address and asks the web chat to show it.
  const shown = [], asked = [], els = {};
  let said = null, reloaded = 0, celebrated = 0;
  const chat = { openMyAccount() {}, showPolarForm: (src, type, done) => shown.push({ src, type, done }) };
  const state = vm.createContext({
    URL, JSON,
    window: { location: { origin: "https://amber-fox-42.closedhand.ai", href: "https://amber-fox-42.closedhand.ai/dashboard#account" }, parent: chat },
    document: { documentElement: { getAttribute: () => "dark" }, getElementById: (id) => (els[id] ||= { hidden: true, textContent: "" }) },
    fetch: async (url, opts = {}) => { asked.push([opts.method || "GET", url]); return { ok: true, json: async () => url === "/api/plus/card" ? { token: "polar_cst_x", web: "https://polar.sh" } : url === "/api/plus/welcome" ? { inUse: true } : { url: "https://polar.sh/checkout/polar_c_x" } }; },
    showToast: () => {}, miniCelebration: () => { celebrated++; }, loadIncludedAi: () => {},
    myAccountSaid: (b) => { said = b; }, loadMyAccount: () => { reloaded++; },
  });
  vm.runInContext(region(html, "    var polarOpen = false;", "    // Back from Polar's page, through closedhand.com: what just happened."), state);
  await state.openPolar("checkout", "plus");
  const src = new URL(shown[0].src);
  assert.equal(src.origin + src.pathname, "https://polar.sh/checkout/polar_c_x");
  assert.deepEqual([src.searchParams.get("embed"), src.searchParams.get("embed_origin"), src.searchParams.get("theme"), shown[0].type], ["true", "https://amber-fox-42.closedhand.ai", "dark", "POLAR_CHECKOUT"]);
  await state.openPolar("card");
  assert.equal(shown.length, 1, "one form at a time");
  shown[0].done(null);
  assert.deepEqual([said, reloaded], [null, 0], "closed without paying: nothing changes");
  await state.openPolar("card");
  const card = new URL(shown[1].src);
  assert.deepEqual([card.origin + card.pathname, card.searchParams.get("session_token"), card.searchParams.get("mode"), shown[1].type], ["https://polar.sh/embed/payment-method", "polar_cst_x", "modal", "POLAR_PAYMENT_METHOD"]);
  shown[1].done("success");
  assert.deepEqual([said, reloaded], ["card", 1]);
  await state.openPolar("checkout", "plus");
  shown[2].done("success");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(celebrated, 1, "paying for Closedhand+ is celebrated");
  assert.deepEqual(asked.at(-1), ["POST", "/api/plus/welcome"], "and Closedhand moves onto it at once");
  assert.equal(els["plus-welcome"].hidden, false);
  assert.equal(els["plus-welcome-what"].textContent, "Closedhand Managed Models are yours every month, and Closedhand's own email has no monthly limit.");
  assert.equal(els["plus-welcome-state"].textContent, "Closedhand now runs on Closedhand Managed Models. Your own LLM provider stays in Settings, under Models.");
  assert.match(html, /<h3 id="llm-own-name">Your own LLM provider<\/h3>/, "and the way back to it is right there");

  // The frame itself (polar-form.js), the same in the web chat and the dashboard.
  const listeners = {}, added = [], frameWindow = {};
  const box = vm.createContext({
    window: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } },
    document: { body: { classList: { add() {}, remove() {} }, appendChild: (f) => added.push(f) }, createElement: () => ({ remove() { this.removed = true; }, contentWindow: frameWindow }) },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../webapp/public/polar-form.js"), "utf8"), box);
  const results = [];
  box.window.showPolarForm("https://polar.sh/checkout/polar_c_x?embed=true", "POLAR_CHECKOUT", (r) => results.push(r));
  const frame = added[0];
  assert.match(frame.allow, /^payment 'self' https:\/\/polar\.sh https:\/\/sandbox\.polar\.sh;/);
  const message = (origin, data, source = frameWindow) => listeners.message({ origin, data, source });
  message("https://evil.example.com", { type: "POLAR_CHECKOUT", event: "success" });
  message("https://polar.sh", { type: "POLAR_CHECKOUT", event: "success" }, {});
  message("https://polar.sh", { type: "POLAR_PAYMENT_METHOD", event: "success" });
  assert.deepEqual([results, !!frame.removed], [[], false], "nothing from anyone else, another frame or another form");
  message("https://polar.sh", { type: "POLAR_CHECKOUT", event: "confirmed" });
  message("https://polar.sh", { type: "POLAR_CHECKOUT", event: "close" });
  assert.equal(!!frame.removed, false, "never closed while paying");
  message("https://polar.sh", { type: "POLAR_CHECKOUT", event: "success" });
  assert.deepEqual([results, !!frame.removed, listeners.message], [["success"], true, undefined]);
  assert.doesNotMatch(html + fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8"), /<script[^>]+polar\.sh/i, "nothing of Polar's code in either page");
  assert.match(fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8"), /<script src="\/polar-form\.js"><\/script>/, "the web chat shows it over the whole window");
});

// The web chat's side of My Account (webapp/views/index.html), run as the page runs it.
function chatPage() {
  const page = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  const classes = new Set();
  const label = { textContent: "Dashboard" };
  const slide = { style: {}, offsetWidth: 1 };
  const overlay = { classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    querySelector: (q) => (q === ".dash-slide" ? slide : label) };
  const modes = [];
  const frame = { contentWindow: { setAccountMode: (on) => modes.push(on) } };
  const timers = [];
  const box = vm.createContext({
    document: { getElementById: (id) => (id === "dashOverlay" ? overlay : frame) },
    setTimeout: (f, ms) => timers.push([f, ms]), requestAnimationFrame: (f) => f(),
  });
  box.window = box;
  const piece = (from, to) => page.slice(page.indexOf(from), page.indexOf(to));
  vm.runInContext(piece("  // My Account: the panel slides away", "  // Dashboard slide-over (exposed globally for onclick handlers)"), box);
  vm.runInContext(piece("  window.closeDashSlide = function() {", "  // Click outside closes dashboard"), box);
  const flush = () => { while (timers.length) timers.shift()[0](); };
  return { w: box.window, classes, label, modes, timers, flush };
}

test("My Account from the dashboard: the panel slides away, the same frame comes back as a popup over the web chat, and closing it brings the panel back", () => {
  const chat = chatPage();
  chat.classes.add("active");
  chat.w.openMyAccount("dashboard");
  assert.deepEqual([...chat.classes], [], "the panel slides away first");
  assert.equal(chat.timers[0][1], 380);
  chat.flush();
  assert.deepEqual([...chat.classes].sort(), ["account", "active"]);
  assert.equal(chat.label.textContent, "My Account");
  assert.deepEqual(chat.modes, [true]);
  chat.w.closeDashSlide();
  assert.deepEqual([...chat.classes], ["account"], "the popup fades first");
  chat.flush();
  assert.deepEqual([...chat.classes], ["active"], "then the panel is back");
  assert.equal(chat.label.textContent, "Dashboard");
  assert.deepEqual(chat.modes, [true, false]);

  const direct = chatPage();
  direct.w.openMyAccount("chat");
  assert.deepEqual([...direct.classes].sort(), ["account", "active"], "from a link: the popup at once");
  direct.w.closeMyAccount();
  direct.flush();
  assert.deepEqual([...direct.classes], [], "and closing it leaves the web chat");
  const page = fs.readFileSync(require.resolve("../webapp/views/index.html"), "utf8");
  assert.match(page, /if \(\/\^#account\(\\\/\|\$\)\/\.test\(hash \|\| ''\)\) \{ openMyAccount\('chat'\); return; \}/, "a link to it opens the popup");
  assert.ok(page.indexOf("window.openMyAccount = function") < page.indexOf("(function openDashFromRedirect"), "defined before a link to it is opened as the page loads");
});

test("as the popup, the dashboard shows only My Account, and goes back to the same tab at the same place", () => {
  const classes = new Set(), tabs = ["connections", "settings", "account"].map((t) => ({ id: "tab-" + t, classList: new Set(t === "settings" ? ["active"] : []) }));
  const buttons = ["connections", "settings"].map((t) => ({ dataset: { tab: t }, classList: new Set(t === "settings" ? ["active"] : []) }));
  const wrap = (set) => ({ toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) });
  for (const x of [...tabs, ...buttons]) x.classList = Object.assign(wrap(x.classList), { has: x.classList.has.bind(x.classList) });
  const scroller = { scrollTop: 640 };
  let switched = null;
  const box = vm.createContext({
    window: {},
    document: { documentElement: { classList: wrap(classes) }, scrollingElement: scroller,
      querySelector: () => tabs.find((t) => t.classList.contains("active") && t.id !== "tab-account"),
      querySelectorAll: (q) => (q === ".tab" ? buttons : tabs) },
    switchTab: (name) => { switched = name; for (const t of tabs) t.classList.toggle("active", t.id === "tab-" + name); },
  });
  vm.runInContext(region(html, "    var accountLeft = null;", "    window.setAccountMode = setAccountMode;"), box);
  box.setAccountMode(true);
  assert.deepEqual([switched, classes.has("account-mode"), scroller.scrollTop], ["account", true, 0]);
  box.setAccountMode(true);
  box.setAccountMode(false);
  assert.deepEqual([classes.has("account-mode"), scroller.scrollTop, tabs[1].classList.contains("active"), tabs[2].classList.contains("active"), buttons[1].classList.contains("active")], [false, 640, true, false, true], "Settings again, scrolled where it was");
  assert.match(html, /\.account-mode \.dashboard-toolbar, \.account-mode #personal-url-notice, \.account-mode \.tab-content:not\(#tab-account\) \{ display: none !important; \}/);
  assert.match(html, /function openMyAccount\(\) \{\n\s*const chat = chatPage\(\);\n\s*if \(chat\) chat\.openMyAccount\('dashboard'\); else switchTab\('account'\);/);
});

test("an invoice downloads straight away, fetched by Closedhand from Polar's own places only", () => {
  const server = fs.readFileSync(require.resolve("../webapp/server.js"), "utf8");
  const route = server.slice(server.indexOf('app.get("/api/plus/invoice"'), server.indexOf('app.post("/api/plus/welcome"'));
  const host = new RegExp(route.match(/if \(!(\/\^\(polar.*?\$\/)\.test\(new URL\(url\)\.host\)\)/)[1].slice(1, -1));
  for (const ok of ["polar-customer-invoices.s3.amazonaws.com", "polar-receipts.s3.eu-west-1.amazonaws.com", "polar.sh", "sandbox.polar.sh"]) assert.ok(host.test(ok), ok);
  for (const no of ["evil.s3.amazonaws.com", "polar.sh.evil.example.com", "192.168.1.1", "files.example.com"]) assert.ok(!host.test(no), no);
  assert.match(route, /fetch\(url, \{ redirect: "error", signal: AbortSignal\.timeout\(20000\) \}\)/, "never sent on elsewhere");
  assert.match(route, /set\("Content-Disposition", `attachment; filename=/);
  assert.match(html, /save\.download = name;\n\s*document\.body\.append\(save\);\n\s*save\.click\(\);/, "saved, no tab opened");
  assert.doesNotMatch(html, /window\.open\("", "_blank"\)/);
});

test("a notice stays long enough to read, closes with its x, and several leave one after another", () => {
  const timers = [], added = [];
  const make = () => {
    const el = { className: "", attrs: {}, children: [], listeners: {}, classList: { add(c) { el.className += " " + c; } },
      setAttribute(k, v) { el.attrs[k] = v; }, appendChild(c) { el.children.push(c); }, addEventListener(t, f) { el.listeners[t] = f; }, remove() { el.removed = true; } };
    return el;
  };
  let now = 1000;
  const box = vm.createContext({ document: { getElementById: () => ({ appendChild: (t) => added.push(t) }), createElement: make, addEventListener() {} },
    setTimeout: (f, ms) => timers.push({ f, at: now + ms }), Date: { now: () => now } });
  box.window = box;
  vm.runInContext(fs.readFileSync(require.resolve("../webapp/public/delight.js"), "utf8"), box);
  box.window.Delight.toast("One");
  box.window.Delight.toast("Two");
  assert.deepEqual(timers.map((t) => t.at - now), [8000, 8700], "the second leaves after the first");
  const close = added[0].children.find((c) => c.className === "toast-close");
  assert.equal(close.attrs["aria-label"], "Dismiss");
  close.listeners.click();
  assert.match(added[0].className, /delight-toast-exit/, "the x closes it at once");
  assert.equal(added[1].attrs.role, "status");
});

test("Usage costs: what the provider reported, else its listed price, with tokens it had already seen at the cached rate", () => {
  const prices = { innerHTML: "" };
  const box = vm.createContext({ document: { getElementById: () => prices }, escHtml: (s) => String(s), jsq: (s) => String(s) });
  vm.runInContext(region(html, "    // What the person's own LLM provider charges: a price they set for a model", "    async function saveUsagePrice(model, id) {") + "\nthis.set = (p, l, m) => { usagePrices = p; usageListed = l; usageManaged = m; };", box);
  box.set({}, { "deepseek-flash": { in: 0.2, out: 0.6, cached: 0.02, listed: "~deepseek/deepseek-flash-latest" } }, false);
  const row = (o) => ({ model: "deepseek-flash", calls: 10, tokens_in: 1000000, tokens_out: 100000, tokens_cached: 0, cost_usd: 0, costed_calls: 0, cache_known: true, ...o });
  assert.equal(box.usageCost([row({})]).toFixed(4), "0.2600", "1M in at $0.20 and 100k out at $0.60");
  assert.equal(box.usageCost([row({ tokens_cached: 800000 })]).toFixed(4), "0.1160", "800k already seen at $0.02");
  assert.equal(box.usageCost([row({ cost_usd: 0.05, costed_calls: 10 })]).toFixed(4), "0.0500", "the provider's own figure, when it gives one");
  assert.equal(box.usageCost([row({ model: "managed" })]), null, "Managed Models are never money");
  assert.equal(box.usageCost([row({ model: "my-finetune" })]), null, "no price, no cost");
  box.set({ "deepseek-flash": { in: 1, out: 2 } }, {}, false);
  assert.equal(box.usageCost([row({})]).toFixed(4), "1.2000", "a price set by the person comes first");

  box.set({}, { "deepseek-flash": { in: 0.15, out: 0.6, cached: 0.003, listed: "deepseek/deepseek-v4.1-flash-1017", by: "DeepSeek" } }, false);
  box.renderUsagePrices([row({ cache_known: false }), row({ model: "my-finetune" })]);
  assert.match(prices.innerHTML, /<span class="m">deepseek-flash<\/span><label><span>In<\/span>\$<input type="number" min="0" step="any" id="price-deepseek-flash-in" value="0\.15"/, "boxes filled with the price found");
  assert.match(prices.innerHTML, /id="price-deepseek-flash-out" value="0\.60"/, "cents as cents");
  assert.match(prices.innerHTML, /id="price-deepseek-flash-cached" value="0\.003"/);
  assert.match(prices.innerHTML, /DeepSeek\u2019s price, from <a href="https:\/\/openrouter\.ai\/models" target="_blank" rel="noopener">OpenRouter\u2019s public list<\/a>\./, "and where it came from");
  assert.match(prices.innerHTML, /No public price found\. Add one to see what my-finetune costs\./);
  assert.doesNotMatch(prices.innerHTML, /Days before Closedhand counted/, "nothing a new person would never need");
  box.set({}, { "llama3.2": { in: 0, out: 0, cached: 0, listed: null, by: null, local: true } }, false);
  box.renderUsagePrices([row({ model: "llama3.2" })]);
  assert.match(prices.innerHTML, /Runs on your computer, so there\u2019s no charge per token\./);
  box.set({ "deepseek-flash": { in: 0.2, out: 0.7, cached: 0.004 } }, { "deepseek-flash": { in: 0.15, out: 0.6, cached: 0.003, by: "DeepSeek" } }, false);
  box.renderUsagePrices([row({})]);
  assert.match(prices.innerHTML, /Your price\. <button type="button" class="quiet-link" onclick="resetUsagePrice\('deepseek-flash'\)">Use DeepSeek\u2019s price<\/button>/, "changed, it is theirs, with the way back");
  assert.equal(box.usageCost([row({ tokens_cached: 800000 })]).toFixed(4), "0.1132", "their repeated price too");
  assert.doesNotMatch(html, /<h3>Prices<\/h3>|Add your provider's prices below/, "no form of prices to fill in");
  assert.match(html, /'About ' \+ \(cost < 0\.01 \? 'under \$0\.01' : '\$' \+ cost\.toFixed\(2\)\) \+ ' with your LLM provider over these ' \+ usageDays \+ ' days' \+ beside;/, "with any Managed Models use beside it (scripts/test-included-ai.js runs it)");
  assert.match(html, /const dayCost = usageManaged \? null : usageCost\(rows\.filter\(r => r\.day === day\)\);/, "each day's cost on the chart");
});

test("Models: a card for each way Closedhand can run, their own LLM provider first; one says In use, the other Not in use with the way to switch, and the plan is a row apart", () => {
  const els = {};
  const classes = () => { const on = new Set(); return { toggle: (c, yes) => { if (yes) on.add(c); else on.delete(c); }, contains: (c) => on.has(c) }; };
  const el = (id) => (els[id] ||= { id, hidden: false, textContent: "", className: "", style: {}, classList: classes(), querySelector: () => null,
    replaceChildren(...parts) { this.textContent = parts.map((p) => typeof p === "string" ? p : p.textContent).join(""); } });
  const box = vm.createContext({ Date, document: { getElementById: el, createElement: () => ({ style: {} }) } });
  vm.runInContext(region(html, "    function accountLink(words) {", "    // Back to the person's own LLM provider, as Closedhand kept it.") + "\nthis.state = (s) => { includedState = s; llmStep = null; renderLlmOptions(); };", box);
  const word = (id) => els[id].hidden ? "" : `${els[id].textContent} (${els[id].className.trim()})`;
  const look = () => ({ own: word("llm-own-status"), managed: word("llm-managed-status"), ownCard: els["llm-own"].classList.contains("in-use"), managedCard: els["llm-managed"].classList.contains("in-use") });

  // Their own in use, Closedhand+ cancelled: Managed Models not in use, their plan a row apart.
  box.state({ state: "available", plan: { name: "plus", ends_at: "2026-11-27T14:19:56.000Z" }, own: ["DeepSeek"] });
  assert.deepEqual(look(), { own: "In use (plan-status on)", managed: "Not in use (plan-status over)", ownCard: true, managedCard: false }, "which runs, said plainly on each card");
  assert.deepEqual([els["byok-panel"].style.display, els["own-ai-switch"].hidden, els["included-ai-use"].hidden, els["included-ai-confirm"].hidden], ["", true, false, true]);
  assert.equal(els["included-ai-plan-status"].textContent, "Cancelled", "the subscription's state is in its own row, not the models'");
  box.llmStepTo("managed");
  assert.deepEqual([els["included-ai-use"].hidden, els["included-ai-confirm"].hidden, look().own], [true, false, "In use (plan-status on)"], "looking is not switching");
  assert.equal(els["included-ai-confirm-text"].textContent, "Closedhand will run on Closedhand Managed Models from now on. Switch back before 27 November to keep Closedhand replying. DeepSeek stays saved here, so you can switch back in one click.");

  // Managed Models in use, their own kept: theirs not in use, back in one click, named.
  box.state({ state: "in-use", plan: { name: "plus" }, ownKept: true, own: ["DeepSeek", "OpenAI"] });
  assert.deepEqual(look(), { own: "Not in use (plan-status over)", managed: "In use (plan-status on)", ownCard: false, managedCard: true });
  assert.deepEqual([els["byok-panel"].style.display, els["own-ai-switch"].hidden, els["own-ai-go"].hidden, els["own-ai-go"].textContent, els["included-ai-use"].hidden],
    ["none", false, false, "Use DeepSeek and OpenAI", true], "their models out of sight while not in use");
  assert.equal(els["own-ai-line"].textContent, "DeepSeek and OpenAI are saved as you set them up.");
  assert.equal(els["own-ai-setup"].textContent, "Change your models");

  // None kept: set one up in the form, which starts empty; Managed Models run until it is saved.
  box.state({ state: "in-use", plan: { name: "plus" }, ownKept: false, own: [] });
  assert.deepEqual([els["own-ai-go"].hidden, els["own-ai-setup"].textContent, els["own-ai-setup"].className, els["byok-panel"].style.display], [true, "Set up your own LLM provider", "cta", "none"]);
  box.llmStepTo("own");
  assert.deepEqual([els["byok-panel"].style.display, els["byok-panel"].classList.contains("setting-up"), els["own-ai-setup"].hidden, els["own-ai-cancel"].hidden], ["", true, true, false]);
  assert.equal(els["own-ai-line"].textContent, "Closedhand stays on Closedhand Managed Models until you choose Use these models below.");

  // Managed Models not theirs: no cards, just their own models.
  box.state(null);
  assert.deepEqual([els["llm-options"].classList.contains("alone"), els["llm-managed"].hidden, els["byok-panel"].style.display], [true, true, ""]);
  assert.match(html, /var theirs = !!\(data && data\.plan\) && \(data\.plan\.name === 'first-month' \|\| data\.plan\.name === 'plus'\);/, "offered only while they are the person's");
  assert.ok(html.indexOf('id="llm-own"') < html.indexOf('id="llm-managed"'), "their own LLM provider first");
  assert.match(html, /<button type="button" class="cta" id="included-ai-go" onclick="useIncludedAi\(\)">Let's go<\/button>/);
  assert.match(html, /if \(includedState && includedState\.state === 'in-use'\) llmStepTo\('own'\);/, "a key pasted in Connections opens the form while Managed Models run too");
});

test("resuming Closedhand+ asks first, saying when it renews, for how much and on which card; nothing is sent until yes", async () => {
  const asked = [], sent = [];
  let answer = false;
  const button = { disabled: false, classList: { contains: () => true } };
  const box = vm.createContext({
    window: { _plusFacts: { until: "2026-11-27T14:19:56.000Z", price: "$10", card: "your Visa ending 4242" } },
    includedState: null, JSON, Date,
    document: { getElementById: () => button, querySelector: () => button },
    askFirst: async (where, opts) => { asked.push(opts); return answer; },
    fetch: async (url, opts) => { sent.push([url, opts.body]); return { ok: true, json: async () => ({}) }; },
    showToast: () => {}, loadMyAccount: async () => {}, loadIncludedAi: () => {},
  });
  vm.runInContext(region(html, "    async function setPlusCancel(cancel, pressed) {", "    // Polar's own form, to pay or change the card"), box);
  await box.setPlusCancel(false, button);
  assert.equal(asked[0].text, "Closedhand+ renews on 27 November, charging $10 to your Visa ending 4242, then every month until you cancel. Nothing is charged now.");
  assert.equal(asked[0].yes, "Resume Closedhand+");
  assert.deepEqual(sent, [], "Cancel: nothing changes");
  answer = { checked: false };
  await box.setPlusCancel(false, button);
  assert.deepEqual(sent, [["/api/plus/cancel", JSON.stringify({ cancel: false })]]);
  // From Settings, before My Account has been opened: the plan's day and price.
  box.window._plusFacts = undefined;
  box.includedState = { plan: { name: "plus", ends_at: "2026-11-27T14:19:56.000Z" }, price: "$10" };
  await box.setPlusCancel(false, button);
  assert.equal(asked[2].text, "Closedhand+ renews on 27 November, charging $10 to the card it's paid with, then every month until you cancel. Nothing is charged now.");
});
