// Reply drafts Closedhand makes on its own (lib/prepared-drafts.js): only
// for mail from a person when everything the reply needs is known, from the
// address the mail was sent to, in its thread, never sent, removed after 24
// hours if untouched unless kept, and kept for good once the person edits it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// A stand-in database holding prepared_drafts.
const rows = [];
const table = () => {
  const filters = [];
  const api = {
    select: () => api, order: () => api, limit: () => api,
    eq: (k, v) => { filters.push((r) => r[k] === v); return api; },
    lt: (k, v) => { filters.push((r) => r[k] < v); return api; },
    insert: async (row) => { rows.push({ id: "p" + rows.length, kept: false, created_at: new Date().toISOString(), ...row }); return { error: null }; },
    update: (patch) => ({ eq: async (k, v) => { rows.filter((r) => r[k] === v).forEach((r) => Object.assign(r, patch)); return { error: null }; } }),
    delete: () => ({ eq: async (k, v) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i][k] === v) rows.splice(i, 1); return { error: null }; } }),
    then: (ok) => ok({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return api;
};
stub("../lib/db", { supabase: { from: table } });
const ctx = require("../lib/context");
const calls = [];
const versions = new Map();
let threadDraft = null;
stub("../lib/tools/handlers", {
  draftOnThread: async () => threadDraft,
  ownAddresses: async (tool) => (tool === "gmail_reply" ? ["sam@harbour.test", "orders@harbour.test"] : []),
  predraft: async (tool, input) => { calls.push(["predraft", tool, input]); versions.set("d1", "m1"); return { draftId: "d1", messageId: "m1" }; },
  dropPredraft: async (tool, account, id) => { calls.push(["drop", tool, account, id]); },
  draftVersion: async (tool, account, id) => versions.get(id) || null,
});
const pd = require("../lib/prepared-drafts");
const email = { source: "gmail", type: "email", external_id: "e1", data: { id: "g-msg-1", threadId: "t-1", account: "sam@harbour.test", to: "Orders <orders@harbour.test>, ravi@lantern.test", from: "Ravi <ravi@lantern.test>" } };

test("a draft goes from the address the mail was sent to, in its thread, and is recorded", async () => {
  ctx.activeUserId = "u1";
  const made = await pd.prepare("u1", email, "Hi Ravi, 19:30 works. See you at Hearth.");
  assert.deepEqual(made, { place: "your Gmail drafts", from: "orders@harbour.test" }, "the alias it was sent to, not the mailbox's main address");
  const [, tool, input] = calls.at(-1);
  assert.equal(tool, "gmail_reply");
  assert.deepEqual({ ...input }, { account: "sam@harbour.test", message_id: "g-msg-1", thread_id: "t-1", body: "Hi Ravi, 19:30 works. See you at Hearth.", from: "orders@harbour.test", from_alias: "orders@harbour.test" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, "m1");
  assert.equal(pd.draftLine(made), "I've put a reply in your Gmail drafts, from orders@harbour.test. I'll remove it in 24 hours unless you edit it or tell me to keep it.");
});

test("never a second draft on a thread, and nothing for a source without drafts", async () => {
  threadDraft = { draft_id: "theirs" };
  const before = calls.length;
  assert.equal(await pd.prepare("u1", email, "x"), null);
  threadDraft = null;
  assert.equal(await pd.prepare("u1", { ...email, source: "whatsapp", type: "message" }, "x"), null);
  assert.equal(calls.length, before);
  assert.equal(pd.toolFor("outlook_work"), "outlook_reply");
  assert.equal(pd.toolFor("imap"), "reply_to_mail");
});

test("after 24 hours: removed if untouched, left alone once edited, kept when asked", async () => {
  const old = new Date(Date.now() - 25 * 3600000).toISOString();
  rows.length = 0;
  rows.push({ id: "a", user_id: "u1", tool: "gmail_reply", account: "sam@harbour.test", draft_id: "d1", version: "m1", kept: false, created_at: old });
  rows.push({ id: "b", user_id: "u1", tool: "gmail_reply", account: "sam@harbour.test", draft_id: "d2", version: "m2", kept: false, created_at: old });
  rows.push({ id: "c", user_id: "u1", tool: "gmail_reply", account: "sam@harbour.test", draft_id: "d3", version: "m3", kept: true, created_at: old });
  rows.push({ id: "d", user_id: "u1", tool: "gmail_reply", account: "sam@harbour.test", draft_id: "d4", version: "m4", kept: false, created_at: new Date().toISOString() });
  versions.set("d1", "m1"); versions.set("d2", "m2-edited"); versions.set("d3", "m3"); versions.set("d4", "m4");
  calls.length = 0;
  assert.equal(await pd.sweep("u1"), 1);
  assert.deepEqual(calls, [["drop", "gmail_reply", "sam@harbour.test", "d1"]], "only the untouched one is removed");
  assert.deepEqual(rows.map((r) => r.id).sort(), ["c", "d"], "the edited one is theirs now; kept and recent stay");
});

test("keep it, or remove it now, from the chat", async () => {
  ctx.activeUserId = "u1";
  rows.length = 0;
  rows.push({ id: "x", user_id: "u1", tool: "outlook_reply", account: "sam@harbour.test", draft_id: "o1", version: "ck", kept: false, created_at: new Date().toISOString() });
  assert.deepEqual(await pd.act({ action: "keep" }), { kept: true, note: "It stays in their drafts until they send or delete it." });
  assert.equal(rows[0].kept, true);
  calls.length = 0;
  assert.deepEqual(await pd.act({ action: "remove" }), { removed: true });
  assert.deepEqual(calls, [["drop", "outlook_reply", "sam@harbour.test", "o1"]]);
  assert.equal(rows.length, 0);
  assert.match((await pd.act({ action: "keep" })).error, /no reply draft Closedhand prepared/);
});

test("an untracked draft is taken away again: it could never be removed as promised", async () => {
  const failing = () => ({ ...table(), insert: async () => ({ error: { message: "db down" } }) });
  require.cache[require.resolve("../lib/db")].exports.supabase = { from: failing };
  delete require.cache[require.resolve("../lib/prepared-drafts")];
  const fresh = require("../lib/prepared-drafts");
  calls.length = 0;
  assert.equal(await fresh.prepare("u1", email, "Hi Ravi"), null);
  assert.deepEqual(calls.map((c) => c[0]), ["predraft", "drop"]);
  require.cache[require.resolve("../lib/db")].exports.supabase = { from: table };
});

test("the reply is checked on its own terms, failing closed", async () => {
  const gate = require("../lib/nudge-gate");
  const seen = [];
  const judge = (answer) => () => ({ model: "m", client: { messages: { create: async (req) => { seen.push(req); if (answer instanceof Error) throw answer; return { content: [{ type: "text", text: answer }] }; } } } });
  const store = { location: { timezone: "Asia/Tokyo" }, profile: { settings: {} } };
  assert.deepEqual(await gate.checkReply({ userId: "u1", store, reply: "Yes, Saturday works.", original: "Can you do Saturday?", evidence: "x", modelFor: judge('{"draft": true}') }), { draft: true, problems: [] });
  assert.match(seen[0].system, /it commits the user to anything \(a yes, a no, a date, a payment, an action, an opinion\) the evidence does not show they have decided/);
  assert.equal((await gate.checkReply({ userId: "u1", store, reply: "Yes.", original: "?", evidence: "", modelFor: judge("fine") })).draft, false);
  assert.equal((await gate.checkReply({ userId: "u1", store, reply: "Yes.", original: "?", evidence: "", modelFor: judge(new Error("down")) })).draft, false);
});

test("Pulse makes a draft only for mail from a person, after both checks, and says so in code", () => {
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /if \(!body \|\| !cited\.has\(k\) \|\| !row \|\| row\.type !== "email"\) return null;/);
  assert.match(pulse, /if \(JUNK_SENDER\.test\(row\.data\?\.from \|\| ""\) \|\| fromMailingList\(\{ labels, body: original \}\)\) return null;/, "never a list or an automatic sender");
  assert.match(pulse, /const ok = await gate\.checkReply\(\{ userId, store, reply: body, original, evidence \}\);/);
  const passed = pulse.indexOf("if (!verdictToSend.send) {"), drafted = pulse.indexOf("const draft = reply ? await makeDraft(reply, evidence) : null;");
  assert.ok(passed > 0 && drafted > passed, "the draft is made only once the message itself passed");
  assert.match(pulse, /if \(draft\) text \+= "\\n\\n" \+ require\("\.\/prepared-drafts"\)\.draftLine\(draft\);/);
  assert.match(pulse, /When the answer needs something the items do not say \(their decision, an address, a date\), write no reply: ask in the message whether they want a draft and what it should say\./);
  assert.match(read("index.js"), /require\("\.\/lib\/prepared-drafts"\)\.start\(\);/);
  assert.match(read("migrations/072_prepared_drafts.sql"), /user_id    uuid NOT NULL REFERENCES profiles\(id\) ON DELETE CASCADE/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /name: "prepared_draft",\n\s*core: true,/, "offered in every chat: \"keep it\" may not mention mail");
  assert.match(read("lib/tools/handlers.js"), /case "prepared_draft":\n\s*return require\("\.\.\/prepared-drafts"\)\.act\(toolInput \|\| \{\}\);/);
});
