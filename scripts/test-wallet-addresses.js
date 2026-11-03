// Addresses in the Wallet: each card is billed to the one chosen for it, and
// one may be home, where orders go unless a purchase names another; a card is
// never kept without a billing address, and nothing is made home, labelled or
// billed by guesswork. The card fill types the card's billing address,
// fill_address types a delivery address, and the question before paying says
// where the order is going.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const HOME = { id: "a-home", label: "Home", name: "Ada Fixture", line1: "1 Example Road", line2: "Flat 2", city: "Testford", region: null, postcode: "TE1 1ST", country: "GB", phone: "07000 000000", is_home: true };
const WORK = { id: "a-work", label: "Work", name: "Ada Fixture", line1: "9 Sample Street", line2: null, city: "Sampleton", region: null, postcode: "SA9 9MP", country: "GB", phone: null, is_home: false };

function wallet(addresses) {
  const q = { select: () => q, eq: () => q, order: () => q, then: (resolve) => resolve({ data: addresses, error: null }) };
  const context = { module: { exports: {} }, console, require: (n) => (n === "./db" ? { supabase: { from: () => q } } : { decryptString: (s) => s }) };
  vm.runInNewContext(read("lib/wallet.js"), context);
  return context.module.exports;
}

test("addresses are a table of their own, added safely to any database", () => {
  const sql = read("migrations/070_wallet_addresses.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wallet_addresses \(/);
  assert.match(sql, /REFERENCES profiles\(id\) ON DELETE CASCADE/, "deleting the account deletes them");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_wallet_addresses_user/);
});

test("home is used unless another is named, and a card is billed where it says, else its old postcode, never a guess", async () => {
  const w = wallet([HOME, WORK]);
  assert.equal((await w.findAddress("u", undefined)).address.id, "a-home");
  assert.equal((await w.findAddress("u", "home")).address.id, "a-home");
  assert.equal((await w.findAddress("u", "work")).address.id, "a-work");
  const miss = await w.findAddress("u", "the cottage");
  assert.equal(miss.address, null);
  assert.deepEqual(Array.from(miss.all, (a) => a.label), ["Home", "Work"], "a miss can say what there is");
  assert.equal((await w.billingFor("u", { billing: { address_id: "a-work" } })).id, "a-work");
  assert.equal(await w.billingFor("u", { billing: null }), null, "no billing address is none, not home");
  assert.equal(await w.billingFor("u", { billing: { address_id: "gone" } }), null, "nor is an address since removed");
  assert.equal((await wallet([{ ...WORK }]).findAddress("u", "home")).address, null, "home is only an address marked home");
  assert.equal((await w.findAddress("u", "sample street")).address.id, "a-work", "an address without a label is found by its words");
  const none = wallet([]);
  assert.deepEqual({ ...(await none.billingFor("u", { billing: { postcode: "TE9 9ZZ" } })) }, { postcode: "TE9 9ZZ" }, "a card from before addresses keeps its postcode");
  assert.equal(await none.billingFor("u", { billing: null }), null);
  assert.equal(w.oneLine(HOME), "1 Example Road, Flat 2, Testford, TE1 1ST, United Kingdom");
});

test("the card fill carries its billing address and the address fill a delivery one, each to its own kind of form", () => {
  const w = wallet([]);
  const card = w.fillScript({ number: "4242424242424242", exp_month: 4, exp_year: 2030, cvc: "123", holder: "Ada Fixture" }, "visible", HOME);
  assert.equal(JSON.parse(JSON.parse(card.match(/^B = json\.loads\((.*)\)$/m)[1])).line1, "1 Example Road");
  assert.match(card, /billing = fill_address\(page, B, "billing", True\) if B else None/);
  assert.doesNotMatch(card, /\("postcode", \['input\[autocomplete="postal-code"\]'/, "the postcode is the billing address's, not the first postcode field on the page");
  const delivery = w.addressScript(WORK);
  assert.match(delivery, /out = fill_address\(page, A, "shipping", False\)/);
  const values = JSON.parse(JSON.parse(delivery.match(/^A = json\.loads\((.*)\)$/m)[1]));
  assert.deepEqual(values.country_names, ["United Kingdom", "UK", "Great Britain"], "a dropdown may list the country by any of these");
  assert.equal(values.first, "Ada"); assert.equal(values.last, "Fixture");
  assert.match(delivery, /if not part or sec == other:/, "a field marked for the other kind of address is left alone");
  assert.match(delivery, /if sec == "" and only_empty_plain and info\["value"\]\.strip\(\):/, "the billing pass leaves a filled delivery address alone");
  const py = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: card + "\n" + delivery, encoding: "utf8" });
  if (!py.error) assert.equal(py.status, 0, py.stderr);
});

test("the question before paying says where the order is going, and a finished purchase forgets the address", async () => {
  let cleared = 0;
  const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q,
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: "l1" }, error: null }) }) }),
    update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { user_id: "u" }, error: null }) }) }) }),
    then: (resolve) => resolve({ data: [], error: null }) };
  const stubs = {
    "./db": { supabase: { from: () => q } },
    "./wallet": { lastCardFill: () => null, listCards: async () => [], clearFills: () => { cleared++; },
      lastAddressFill: () => ({ label: "Work", line: "9 Sample Street, Sampleton, SA9 9MP, United Kingdom" }) },
    "./fx": { convert: async (v) => v },
  };
  const context = { module: { exports: {} }, URL, console, Date, Map, Promise, Number, String, Math, require: (n) => stubs[n] || {} };
  vm.runInNewContext(read("lib/spend-guard.js"), context);
  const g = context.module.exports;
  const verdict = await g.assess({ userId: "u", userStore: {}, toolName: "sandbox_browse", source: "chat", intent: { kind: "click", why: "the button says it pays" },
    page: { host: "shop.example.com", url: "https://shop.example.com/checkout", title: "Checkout", total: { value: 20, currency: "GBP", text: "£20.00" } } });
  assert.equal(verdict.action, "ask");
  assert.match(verdict.card, /\nDelivering to: Work, 9 Sample Street, Sampleton, SA9 9MP, United Kingdom\n/);
  await g.ledgerUpdate("l1", { status: "completed" });
  assert.equal(cleared, 1);
});

test("fill_address types a saved address, says which are saved when the name is wrong, and asks when there is none", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const \{ address, all \} = await wallet\.findAddress\(userId, toolInput\.address\);/);
  assert.match(handlers, /There is no saved address matching "\$\{toolInput\.address\}"\. Saved: \$\{saved\}\./);
  assert.match(handlers, /The user has no default address\. Saved: \$\{saved\}\. Ask them which one, or where it should go\./);
  assert.match(handlers, /if \(action === "fill_card" && !billing\) parsed\.billing_address = "This card has no billing address in the Wallet\. If the page asks for one, ask the user for it and type it with fill/, "a card with no billing address asks, never goes without");
  assert.match(handlers, /The user has no address saved\. Ask them where it should go and type it with fill; they can save it under Wallet in Settings so it is filled in next time\./);
  assert.match(handlers, /wallet\.noteAddressFill\(userId, address\);/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /fill_address types one of the user's saved addresses into the delivery form on the page already open: their default \('home'\) unless the user asked for another saved one by its label/);
  assert.match(defs, /A site that already has a card or delivery address chosen \(a signed-in account with one saved\) keeps its own: use fill_card or fill_address only where the page asks for one, or the user asked for a particular one from their Wallet\./, "the site's own card and address first");
  assert.match(defs, /address: \{\n\s*type: "string",\n\s*description: "For fill_address: which saved address, as 'home' or its label, e\.g\. 'work'\.",/);
});

test("Settings adds, changes and removes addresses behind the dashboard's own checks, and a card is billed to one of them", () => {
  const server = read("webapp/server.js");
  for (const route of ['app.post("/api/wallet/addresses"', 'app.patch("/api/wallet/addresses/:id"', 'app.delete("/api/wallet/addresses/:id"']) {
    const body = server.slice(server.indexOf(route), server.indexOf("\n});", server.indexOf(route)));
    assert.ok(body.length > 50, route);
    assert.match(body, /if \(!\(await requireSetupAccess\(req, res\)\)\) return;/, route);
  }
  const fn = server.slice(server.indexOf("function cleanAddress("), server.indexOf("// A card's billing address"));
  const ctx = {}; vm.runInNewContext(fn + "; this.cleanAddress = cleanAddress;", ctx);
  assert.equal(ctx.cleanAddress({ line1: "1 Example Road", city: "Testford", country: "GB" }).error, "Enter the name.");
  assert.equal(ctx.cleanAddress({ name: "Ada Fixture", line1: "", city: "Testford", country: "GB" }).error, "Enter the first line of the address.");
  assert.equal(ctx.cleanAddress({ name: "Ada Fixture", line1: "1 Example Road", country: "GB" }).error, "Enter the town or the postcode.");
  assert.equal(ctx.cleanAddress({ name: "Ada Fixture", line1: "1 Example Road", city: "Testford", country: "" }).error, "Choose the country.");
  assert.equal(ctx.cleanAddress({ name: "Ada Fixture", line1: " 1 Example Road ", postcode: "TE1 1ST", country: "gb" }).address.country, "GB");
  assert.equal(ctx.cleanAddress({ name: "Ada Fixture", line1: "1 Example Road", postcode: "TE1 1ST", country: "GB" }).address.label, "", "a label is optional");
  assert.doesNotMatch(server, /Give it a short name|address\.label = "Home"/, "and never made up");
  assert.match(server, /const home = \(req\.body \|\| \{\}\)\.is_home === true;/, "home is only the address the person says is home");
  assert.match(server, /const \{ data \} = await supabase\.from\("wallet_addresses"\)\.select\("id"\)\.eq\("user_id", userId\)\.eq\("id", id\)\.limit\(1\);/, "a card is only billed to the person's own address");
  assert.match(server, /if \(c\.billing && c\.billing\.address_id === id\) \{/, "removing an address leaves its cards without one");
  assert.doesNotMatch(server, /if \(gone\.is_home\) \{/, "and makes nothing home in its place");
  const add = server.slice(server.indexOf('app.post("/api/wallet", async'), server.indexOf('app.patch("/api/wallet/:id"'));
  assert.match(add, /if \(!billing\) return res\.status\(400\)\.json\(\{ error: "Choose the card's billing address\." \}\);/, "a card is never kept without a billing address");
  assert.match(add, /if \(!holder\) return res\.status\(400\)\.json\(\{ error: "Enter the name on the card\." \}\);/);
  assert.match(add, /if \(!\/\^\\d\{3,4\}\$\/\.test\(cvc\)\) return res\.status\(400\)/, "nor without its security code");
  const patch = server.slice(server.indexOf('app.patch("/api/wallet/:id"'), server.indexOf('app.delete("/api/wallet/:id"'));
  assert.match(patch, /if \(!patch\.billing\) return res\.status\(400\)\.json\(\{ error: "Choose the card's billing address\." \}\);/, "nor changed to none");
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<div style="font-size:0.8125rem;font-weight:600;color:var\(--fg\);margin-bottom:0.625rem;">Addresses<\/div>/);
  // A site that already has the person's address keeps its own; the default
  // is filled in only when a site asks (2026-11-03).
  assert.doesNotMatch(dash, /Orders go to/);
  assert.match(dash, /var delivery = 'Sites that already have your address keep their own\. ' \+ \(home \? 'When one asks, Closedhand fills in ' \+ escHtml\(addressName\(home\)\) \+ '\.' : 'None is the default yet, so when one asks, Closedhand asks you which\.'\);/);
  assert.match(dash, /> Use this address when a site asks<\/label>/);
  assert.match(dash, /addCard\('Add a card', 'openCardForm\(\)'\);/, "both lists end with the same add tile");
  assert.match(dash, /addCard\('Add an address', 'openAddressForm\(\)'\);/);
  // Always chosen in the card form, among the saved addresses or a new one
  // typed in there; never "your home address" before there is one.
  assert.match(dash, /<label class="wallet-field" style="grid-column:1\/-1;"><span>Billing address<\/span><select id="wc-billing" onchange="billingChoice\(\)"><\/select><\/label>/);
  assert.match(dash, /'<option value="new"' \+ \(pick === 'new' \? ' selected' : ''\) \+ '>New address<\/option>'/);
  assert.match(dash, /if \(intoCard\) box\.appendChild\(fields\);/, "one set of address fields, moved into the card form");
  assert.doesNotMatch(dash, /Billed to your home address|Name for it|Who it's for/);
  // A saved card opens to change its label and billing address, and its row
  // says where it is billed. Limits are the spending rules', one set for
  // every card.
  assert.match(dash, /'<button class="conn-btn conn-btn-manage" onclick="openCardForm\(\\'' \+ c\.id \+ '\\'\)">Edit<\/button>'/);
  assert.match(dash, /\(billedTo \? 'billed to ' \+ escHtml\(addressName\(billedTo\)\) : 'no billing address'\)/);
  assert.doesNotMatch(dash, /id="wc-limits"|wc-per-purchase|wc-per-month|c\.limits/, "no limits of a card's own");
  assert.doesNotMatch(read("lib/spend-guard.js"), /fill\.limits/);
  assert.doesNotMatch(read("webapp/server.js"), /patch\.limits|limits: cleanLimits\(b\.limits\)/);
  // What may be left empty says so.
  for (const label of ["Label (optional)", "Flat, floor or building (optional)", "County or state (optional)", "Phone (optional)"]) assert.ok(dash.includes(`<span>${label}</span>`), label);
  assert.match(dash, /<label class="wallet-field" style="grid-column:1\/-1;"><span>Name<\/span><input type="text" id="wa-name"/);
  // The password asked before spending more freely is a password's width, in neutral colours.
  assert.match(dash, /\.wallet-confirm \{ margin:0 0 1rem; padding:0\.875rem 1rem; border:1px solid rgba\(var\(--fg-rgb\),0\.16\);/);
  assert.match(dash, /\.wallet-confirm-row input \{ flex:0 1 13\.75rem;/);
  assert.match(dash, /<label class="wallet-field wc-new" style="grid-column:1\/-1;"><span>Name on card<\/span>/, "a name has room");
  // Cards come first; the optional spending rules come after the addresses, folded.
  const at = (t) => dash.indexOf(t);
  assert.ok(at('margin-bottom:0.625rem;">Cards</div>') < at('margin-bottom:0.625rem;">Addresses</div>') && at('margin-bottom:0.625rem;">Addresses</div>') < at('id="spend-handle"') && at('id="spend-handle"') < at('>Purchases</div>'));
  assert.match(dash, /<div id="spend-body" style="margin-top:0.75rem;" hidden>/);
  assert.match(dash, /document\.getElementById\('spend-summary'\)\.textContent = spendSummary\(l\);/);
  assert.doesNotMatch(dash, /wc-postcode|Billing postcode/);
});

test("the default address and the default card say so where the others offer to be made so, and removing one asks in place of its buttons", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /\(a\.is_home \? '<span class="plan-status on wallet-status">Default<\/span>' : ''\) \+\n\s*'<span class="wallet-row-actions">' \+\n\s*\(a\.is_home \? '' : '<button class="conn-btn conn-btn-manage" onclick="makeDefaultAddress\(\\'' \+ a\.id \+ '\\'\)">Make default<\/button>/);
  assert.match(dash, /\(c\.is_default \? '<span class="plan-status on wallet-status">Default<\/span>' : ''\) \+\n\s*'<span class="wallet-row-actions">' \+\n\s*\(c\.is_default \? '' : '<button class="conn-btn conn-btn-manage" onclick="setDefaultCard/);
  assert.doesNotMatch(dash, /' · home'|' · default'/, "no longer a faint word at the end of the line");
  assert.match(dash, /\.wallet-card-row \.wallet-status \{ margin-left:auto; font-size:0\.8125rem; \}/);
  // The question takes the place of the whole row of buttons, so Edit and the
  // rest never sit beside it; the same for every list of that shape.
  assert.equal((dash.match(/askFirst\(btn\.closest\('\.wallet-row-actions'\) \|\| btn, /g) || []).length, 2, "a card and an address");
  assert.match(dash, /askFirst\(btn\.closest\('#brain-panel-ways'\) \|\| btn, \{ text: 'Delete the Context Note/);
  assert.equal((dash.match(/askFirst\(btn\.closest\('\.conn-drawer-actions'\) \|\| btn, /g) || []).length, 2, "an MCP server and a connection");
  assert.match(dash, /askFirst\(btn\.closest\('\.auto-card-actions'\) \|\| btn, \{ text: 'Delete this ' \+ what \+ ' for good\?'/, "a routine or a team");
});

test("the folded spending rules say what they are now, in one line", () => {
  const dash = read("webapp/views/dashboard.html");
  const grab = (name) => dash.slice(dash.indexOf("function " + name + "("), dash.indexOf("\n    }\n", dash.indexOf("function " + name + "(")) + 6);
  const ctx = { document: { getElementById: () => ({ value: "GBP" }) } };
  require("node:vm").runInNewContext(dash.match(/function money\(v, cur\) \{[^\n]*\}/)[0] + "\n" + grab("spendSummary") + "\nthis.spendSummary = spendSummary;", ctx);
  assert.equal(ctx.spendSummary({}), "Asks before every purchase. No limits.", "nothing saved yet: the defaults");
  assert.equal(ctx.spendSummary({ currency: "GBP", always_ask: true, per_purchase: 50, per_month: "200" }), "Asks before every purchase. Up to GBP 50.00 a purchase, GBP 200.00 a month.");
  assert.equal(ctx.spendSummary({ currency: "EUR", always_ask: false, auto_under: 20, per_day: 100 }), "Goes ahead without asking under EUR 20.00. Up to EUR 100.00 a day.");
  assert.equal(ctx.spendSummary({ currency: "USD", always_ask: false, auto_under: "" }), "Asks before every purchase. No limits.", "without an amount it still asks (spend-guard.js)");
});
