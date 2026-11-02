// What the person pays for again and again (lib/paying-for.js): gathered from
// every source, read into one picture, laid out on a page once, and given to
// Pulse (lib/pulse.js, lib/pulse-triage.js) so it can say when acting before
// a date saves money. The database and LLM are stand-ins; invented services
// and people only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../lib/paying-for");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// A small stand-in for the database: tables in memory, the chain the module uses.
function fakeDb(tables = {}, rpc = {}) {
  const writes = [];
  const from = (name) => {
    let rows = (tables[name] ||= []);
    const filters = [];
    let patch = null, upserting = null, inserting = null;
    const q = {
      select() { return q; },
      eq(col, v) { filters.push((r) => r[col] === v); return q; },
      gt(col, v) { filters.push((r) => String(r[col]) > String(v)); return q; },
      not() { return q; }, order() { return q; }, or() { return q; },
      limit(n) { q._limit = n; return q; },
      range(a, b) { q._range = [a, b]; return q; },
      update(p) { patch = p; return q; },
      upsert(p) { upserting = p; return q; },
      insert(p) { inserting = p; return q; },
      single() { q._single = true; return q; },
      maybeSingle() { q._single = true; return q; },
      then(resolve) {
        if (upserting) {
          const at = rows.findIndex((r) => r.user_id === upserting.user_id);
          if (at >= 0) rows[at] = { ...rows[at], ...upserting }; else rows.push({ ...upserting });
          writes.push({ name, upsert: upserting });
          return resolve({ data: null, error: null });
        }
        if (inserting) { const row = { id: "page-" + (rows.length + 1), ...inserting }; rows.push(row); writes.push({ name, insert: row }); return resolve({ data: { id: row.id }, error: null }); }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) { hit.forEach((r) => Object.assign(r, patch)); writes.push({ name, update: patch }); return resolve({ data: hit, error: null }); }
        if (q._range) hit = hit.slice(q._range[0], q._range[1] + 1);
        if (q._limit) hit = hit.slice(0, q._limit);
        return resolve({ data: q._single ? hit[0] || null : hit, error: null });
      },
    };
    return q;
  };
  return { from, writes, tables, rpc: async (name, args) => ({ data: rpc[name] ? rpc[name](args) : [], error: null }) };
}

test("a payee charged at a steady interval is a commitment; one paid now and then is not", () => {
  const monthly = ["2026-06-03", "2026-07-03", "2026-08-04", "2026-09-03", "2026-10-03"].map((date) => ({ date, amount: 9.99, currency: "GBP" }));
  assert.deepEqual(P.cadence(monthly), { every: "month", days: 30, count: 5, amounts: [9.99, 9.99, 9.99], first: "2026-06-03", last: "2026-10-03", next: "2026-11-02", currency: "GBP" });
  assert.equal(P.cadence([{ date: "2026-10-03", amount: 5 }]), null, "once is not a habit");
  assert.equal(P.cadence(["2026-01-05", "2026-01-09", "2026-03-30", "2026-04-02"].map((date) => ({ date, amount: 12 }))), null, "a corner shop now and then");
  assert.equal(P.cadence(["2025-11-01", "2026-11-01"].map((date) => ({ date, amount: 40 }))).every, "year");
  assert.equal(P.payeeKey("STREAMFLIX.COM 0423"), P.payeeKey("Streamflix.com 0523"), "the same payee month to month");
});

test("everything that looks like paying, from every source, grouped by who it is from", async () => {
  const email = (id, from, subject, labels = ["INBOX"], extra = {}) => ({ source: "gmail", type: "email", external_id: id, received_at: "2026-10-0" + id.slice(-1) + "T09:00:00Z", data: { from, subject, labels, body: "Your plan renews on 3 November.", ...extra } });
  const db = fakeDb({
    data_cache: [
      ...["2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03"].map((d, i) => ({ source: "lunchflow", type: "bank_transaction", external_id: "t" + i, received_at: d + "T00:00:00Z", user_id: "u1", data: { date: d, amount: -11.5, currency: "GBP", payee: "FERNWOOD GYM " + i } })),
      { source: "lunchflow", type: "bank_transaction", external_id: "c1", received_at: "2026-09-12T00:00:00Z", user_id: "u1", data: { date: "2026-09-12", amount: -4.2, currency: "GBP", payee: "CORNER SHOP" } },
      { source: "lunchflow", type: "bank_transaction", external_id: "s1", received_at: "2026-09-12T00:00:00Z", user_id: "u1", data: { date: "2026-09-12", amount: 2400, currency: "GBP", payee: "SALARY" } },
    ],
  }, {
    paying_candidates: ({ p_offset }) => (p_offset ? [] : [
      email("e1", "Streamflix <billing@streamflix.example>", "Your Streamflix receipt"),
      email("e2", "Streamflix <billing@streamflix.example>", "Your plan is changing"),
      email("e3", "Deals <offers@shopmore.example>", "Upgrade your plan", ["CATEGORY_PROMOTIONS"]),
      email("e4", "Kestrel Cloud <invoices@kestrel.example>", "Invoice for October", ["INBOX"], { is_draft: "true" }),
      { source: "whatsapp", type: "message", external_id: "m1", received_at: "2026-10-02T10:00:00Z", data: { chat_name: "Flat chat", sender: "me", text: "my plan is to go out tonight" } },
      { source: "whatsapp", type: "message", external_id: "m2", received_at: "2026-10-02T11:00:00Z", data: { chat_name: "Flat chat", sender: "me", text: "I set up the standing order for rent, it goes out on the 1st" } },
    ]),
  });
  const groups = await P.gather("u1", { db });
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ["bank:FERNWOOD GYM", "mail:streamflix <billing@streamflix.example>", "message:Flat chat"]);
  const gym = groups.find((g) => g.key === "bank:FERNWOOD GYM");
  assert.equal(gym.steady.every, "month", "a bank payee by its steady interval");
  assert.equal(groups.find((g) => g.key.startsWith("mail:")).count, 2, "one sender's mail read together");
  assert.equal(groups.find((g) => g.key.startsWith("message:")).count, 1, "their own chat message only when it says money will leave again");
  assert.match(P.groupText(gym, 0), /Bank payments: every month \(about 31 days\), 4 payments from 2026-07-03 to 2026-10-03/);
});

test("an entry says only what the items say: a past trial or deadline is history, a past next charge moves on, said as an estimate", () => {
  const today = "2026-11-02";
  const e = P.cleanEntry({ name: "Streamflix", what: "Standard plan", amount: 10.99, currency: "gbp", every: "month", next: "2026-10-03", trial_ends: "2026-02-01", cancel_by: "2026-11-20",
    status: "active", last_used: { date: "nope" }, groups: ["G1"] }, [{ key: "mail:streamflix", latest: "2026-10-03T09:00:00Z" }], today);
  assert.equal(e.key, "streamflix");
  assert.equal(e.currency, "GBP");
  assert.deepEqual([e.next, e.next_estimate], ["2026-11-03", true]);
  assert.equal(e.trial_ends, null, "a trial that ended in February is not coming");
  assert.equal(e.cancel_by, "2026-11-20");
  assert.equal(e.last_used, null);
  assert.deepEqual(e.sources, ["mail"]);
  assert.equal(P.cleanEntry({ name: "" }, [], today), null);
  const merged = P.merge([{ key: "a", name: "A", amount: null, sources: ["mail"], seen_last: "2026-10-01" }, { key: "a", name: "A plus", amount: 5, sources: ["bank"], seen_last: "2026-10-05" }]);
  assert.deepEqual(merged.map((m) => [m.name, m.amount, m.sources.sort().join("+")]), [["A plus", 5, "bank+mail"]], "the same thing found twice is one entry");
});

test("the last pass merges the same thing found twice and says what looks like paying twice, never hiding it", async () => {
  const stub = (rel, exports) => { const p = require.resolve("../lib/" + rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const asked = [];
  stub("llm", { getInternalClient: () => ({ client: {}, model: "stand-in" }) });
  stub("task-model", { modelCall: async (c, params) => { asked.push(params); return '{"same": [[1, 2]], "overlap": [{"pair": [3, 4], "why": "Two gym memberships while both are running."}]}'; } });
  stub("model-wire", { responseText: (r) => r });
  stub("verification", { parseObject: (t) => JSON.parse(t) });
  const e = (key, name, extra = {}) => ({ key, name, status: "active", every: "month", sources: ["mail"], seen_last: "2026-10-01", ...extra });
  const out = await P.consolidate("u1", {}, [e("brightline", "Brightline"), e("brightline-mobile", "Brightline Mobile", { amount: 6 }), e("fernwood-gym", "Fernwood Gym", { amount: 11.5 }), e("oakfield-leisure", "Oakfield Leisure", { amount: 30 })]);
  assert.match(asked[0].system, /^These entries of what a person pays for were read/);
  assert.deepEqual(out.map((x) => x.key).sort(), ["brightline", "fernwood-gym", "oakfield-leisure"], "one Brightline");
  assert.equal(out.find((x) => x.key === "brightline").amount, 6, "with what either reading found");
  assert.deepEqual(out.find((x) => x.key === "fernwood-gym").overlap, { with: "oakfield-leisure", why: "Two gym memberships while both are running." });
});

test("the page: what is worth a look, everything found, what it costs a month, and a quiet line to connect a bank", () => {
  const today = "2026-11-02";
  const picture = [
    { key: "streamflix", name: "Streamflix", what: "Standard plan", amount: 12.99, currency: "GBP", every: "month", next: "2026-11-03", status: "active", price_change: "from £10.99 to £12.99 in October", sources: ["mail"] },
    { key: "kestrel", name: "Kestrel Cloud", amount: 60, currency: "GBP", every: "year", next: "2027-01-10", cancel_by: "2026-11-20", notice: "30 days' notice", status: "active", sources: ["mail"] },
    { key: "trialy", name: "Trialy Pro", amount: 8, currency: "USD", every: "month", trial_ends: "2026-11-09", status: "active", sources: ["mail"] },
    { key: "oldmag", name: "Old Magazine", status: "cancelled", sources: ["mail"], seen_last: "2026-09-01T00:00:00Z" },
  ];
  const md = P.pageMarkdown({ picture, sources: ["mail", "chats"], today, bankLink: "https://amber-fox-42.closedhand.ai/dashboard#bank" });
  assert.match(md, /^Everything Closedhand found that you pay for again and again, across everything you've connected\. It keeps this page up to date\./);
  assert.doesNotMatch(md.split("\n")[0], /mail|chats|calendar/, "never a short list of sources, as if they were all it reads");
  assert.match(md, /\*\*Worth a look\*\*\n- Streamflix: from £10\.99 to £12\.99 in October\.\n- Kestrel Cloud: cancel by 20 Nov to avoid the next charge\.\n- Trialy Pro: the trial ends on 9 Nov, then US\$8 monthly\./);
  assert.match(md, /\| Streamflix \(Standard plan\) \| £12\.99 \| Monthly \| 3 Nov \|  \|/);
  assert.match(md, /\| Kestrel Cloud \| £60 \| Yearly \| 10 Jan 2027 \| By 20 Nov\. 30 days' notice \|/);
  assert.match(md, /In all, about £18 and US\$8 a month, with a yearly payment counted as a twelfth\./);
  assert.match(md, /- Old Magazine: cancelled, last seen 1 Sept\./);
  assert.match(md, /Payments that send no email are only in your bank\. \[Connect your bank\]\(https:\/\/amber-fox-42\.closedhand\.ai\/dashboard#bank\) for a fuller picture\.$/);
  assert.doesNotMatch(P.pageMarkdown({ picture, sources: ["mail", "bank"], today, bankLink: "x" }), /Connect your bank/, "with a bank connected, no line");
  assert.match(read("webapp/views/dashboard.html"), /\} else if \(resolved === 'bank'\) \{[\s\S]{0,200}switchTab\('connections'\);\n\s*setTimeout\(function \(\) \{ window\.openConnectionCatalogue\('bank'\); \}, 150\);/, "the link opens Connections showing the banks");
});

test("Pulse is given only what has something coming or has changed, and each is said once", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const db = fakeDb({ paying_for: [{ user_id: "u1", told: {}, picture: [
    { key: "trialy", name: "Trialy Pro", amount: 8, currency: "USD", every: "month", trial_ends: soon, status: "active", sources: ["mail"] },
    { key: "quiet", name: "Quiet Plan", amount: 5, currency: "GBP", every: "month", next: soon, status: "active", sources: ["bank"] },
    { key: "gone", name: "Gone Club", status: "ended", sources: ["mail"] },
  ] }] });
  const first = await P.forPulse("u1", "UTC", db);
  assert.equal(first.lines.length, 1, "a monthly charge with nothing to act on is not news");
  assert.match(first.lines[0], /^Paid for: Trialy Pro; US\$8 monthly; trial ends .+; found in their mail$/);
  await P.markTold("u1", first.entries, db);
  const again = await P.forPulse("u1", "UTC", db);
  assert.match(again.lines[0], /\[already told them on .+\]$/);
  db.tables.paying_for[0].picture[0].price_change = "from $8 to $10";
  assert.doesNotMatch((await P.forPulse("u1", "UTC", db)).lines[0], /already told/, "a change is news again");
  assert.ok(today);
});

test("Pulse's noticing counts a renewal when acting before it saves money, and sees the picture", async () => {
  const triage = read("lib/pulse-triage.js");
  assert.doesNotMatch(triage, /codes they asked for, renewals, newsletters/, "renewals were never worth a word");
  assert.match(triage, /A renewal or charge is worth it when acting before its date would save them money: a trial about to turn into a charge, a cancellation deadline or notice period about to pass, a price that rose, something they seem not to use, or paying twice for one thing\./);
  let seen = "";
  await require("../lib/pulse-triage").notice({ paying: ["[9] Paid for: Trialy Pro; trial ends 9 Nov"], ask: async (system, content) => { seen = content; return '{"pulse": false, "flagged": []}'; } });
  assert.match(seen, /WHAT THEY PAY FOR \(Closedhand's list from everything they have connected[^\n]*\):\n\[9\] Paid for: Trialy Pro/);
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /payingFor\.keepUp\(userId\)\.catch\(/, "kept up in the background, never holding up the check");
  assert.match(pulse, /const payingItems = cite\(paying\.lines\);/);
  assert.match(pulse, /\.\.\.worldLines\.map\(\(\) => null\), \.\.\.paying\.lines\.map\(\(\) => null\)\];/);
  assert.match(pulse, /if \(toldPaying\.length\) await payingFor\.markTold\(userId, toldPaying\)/);
});

test("the first look waits for the first reading of their mail, and the picture has its own table", async () => {
  assert.equal(await P.ready("u1", fakeDb({ mail_coverage: [{ user_id: "u1", done: true }, { user_id: "u1", done: false }] })), false);
  assert.equal(await P.ready("u1", fakeDb({ mail_coverage: [{ user_id: "u1", done: true }] })), true);
  assert.equal(await P.ready("u1", fakeDb({ data_cache: [{ user_id: "u1", type: "email", id: "x" }] })), false, "mail not started reading yet");
  assert.equal(await P.ready("u1", fakeDb({ data_cache: [{ user_id: "u1", type: "event", id: "x" }] })), true, "no mail: anything indexed");
  const sql = read("migrations/084_paying_for.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS paying_for \(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.paying_candidates\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.paying_activity\(/);
});

test("the page opens with an interactive piece: what it costs a month, what is coming up, and what if", async () => {
  const piece = require("../lib/paying-for-piece");
  const today = "2026-11-02";
  const money = (n, c) => (typeof n === "number" ? new Intl.NumberFormat("en-GB", { style: "currency", currency: c || "GBP", minimumFractionDigits: n % 1 ? 2 : 0 }).format(n) : null);
  const dayText = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const PER = { month: 1, year: 1 / 12 };
  const picture = [
    { key: "a", name: "Streamflix", amount: 12.99, currency: "GBP", every: "month", next: "2026-11-03", status: "active", price_change: "from £10.99" },
    { key: "b", name: "Fernwood Gym", amount: 34, currency: "GBP", every: "month", next: "2026-12-01", status: "active" },
    { key: "c", name: "Trialy Pro", amount: 8, currency: "USD", every: "month", trial_ends: "2026-11-09", status: "active" },
    { key: "d", name: "Gone Club", status: "ended" },
  ];
  const data = piece.pieceData({ picture, today, money, dayText, monthlyOf: (e) => (typeof e.amount === "number" && PER[e.every] ? e.amount * PER[e.every] : null), everyWords: { month: "Monthly", year: "Yearly" } });
  assert.equal(data.main, "GBP");
  assert.equal(data.monthly, 47);
  assert.deepEqual(data.others, ["US$8"]);
  assert.equal(data.count, 3, "what has ended is not counted");
  assert.deepEqual(data.soon.map((x) => [x.when, x.name, x.what]), [["3 Nov", "Streamflix", "Charge of £12.99"], ["9 Nov", "Trialy Pro", "Trial ends, then US$8"], ["1 Dec", "Fernwood Gym", "Charge of £34"]]);
  assert.equal(data.items[0].name, "Streamflix", "what is worth a look comes first in What if");
  const html = piece.pieceHtml({ ...data, items: [...data.items, { name: "</script><b>x", what: "", currency: "GBP", monthly: 1, cost: "£1", tags: [] }] });
  assert.match(html, /<button role="tab" id="t-all" aria-controls="all" aria-selected="true">Overview<\/button>/);
  assert.match(html, />Coming up<\/button>/);
  assert.match(html, />What if<\/button>/);
  assert.doesNotMatch(html.split("const D = ")[1].split(";\n")[0], /<\/script>/, "data can never close the script");
  assert.match(html, /mask: url\("data:image\/svg\+xml;base64,/, "the brush stroke travels inside the piece");
  assert.match(html, /prefers-reduced-motion: reduce/);
  const md = P.pageMarkdown({ picture, sources: ["mail"], today, bankLink: null });
  assert.match(md, /It keeps this page up to date\.\n\n!\[\]\(what-you-pay-for\.html\)\n/, "the piece opens the page");
  assert.match(md, /\*\*Everything, in full\*\*\n\n\| What \| Cost \|/, "and the full table stays below it");
  assert.match(read(".dockerignore"), /!webapp\/public\/brush-underline\.svg/, "the bot image carries the brush stroke");
  // The first look makes the page and keeps the piece beside it.
  const uploads = [];
  const db = fakeDb({ paying_for: [{ user_id: "u1", picture, sources: ["mail"], told: {} }], chat_links: [] });
  db.storage = { from: (bucket) => ({ upload: async (key, body, opts) => { uploads.push({ bucket, key, type: opts.contentType, html: String(body) }); return { error: null }; } }) };
  const stub = (rel, exports) => { const p = require.resolve("../lib/" + rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub("proactive", { deliverUnprompted: async () => false });
  stub("config", { dashboardBase: async () => "https://amber-fox-42.closedhand.ai" });
  const pageId = await P.firstLook("u1", db.tables.paying_for[0], { db, store: { profile: { settings: {} } } });
  assert.equal(pageId, "page-1");
  assert.deepEqual(uploads.map((u) => [u.bucket, u.key, u.type]), [["attachments", "u1/pages/page-1/what-you-pay-for.html", "text/html"]]);
  assert.match(db.tables.reports[0].content, /\[Connect your bank\]\(https:\/\/amber-fox-42\.closedhand\.ai\/dashboard#bank\)/);
  assert.ok(db.tables.paying_for[0].first_look_at, "said once");
});
