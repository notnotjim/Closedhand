// A table in a chat app (lib/chat-tables.js). No chat app shows one, so an
// answer's figures arrived as a grid of pipes and dashes. There each table
// goes as one line per row, and the answer is also kept as a page with the
// table laid out, linked under it. Invented figures throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tables = require("../lib/chat-tables");

const ANSWER = "Two vans cover it.\n\n[[next]]\n\n| | Buy | Rent |\n|---|---|---|\n| Small van | £18k | £400/mo |\n| **Large van**, refrigerated | £31k | - |\n\nRenting wins under two years.";

test("each row goes as a line, its first cell the label, bold where the app shows bold", () => {
  assert.equal(tables.flatten(ANSWER, "whatsapp_linked"),
    "Two vans cover it.\n\n[[next]]\n\n**Small van**: Buy £18k, Rent £400/mo\n**Large van, refrigerated**: Buy £31k\n\nRenting wins under two years.",
    "an empty cell is left out");
  assert.match(tables.flatten(ANSWER, "telegram"), /\nSmall van: Buy £18k, Rent £400\/mo\nLarge van, refrigerated: Buy £31k\n/, "Telegram and LINE show asterisks as typed");
  assert.match(require("../lib/chat-format").formatWhatsApp(ANSWER), /\n\*Small van\*: Buy £18k, Rent £400\/mo\n/, "WhatsApp's own bold");
  assert.equal(tables.flatten("| Hotel | Per night |\n|---|---:|\n| Harbour Inn | £92 |", "discord"), "**Harbour Inn**: £92", "with one column beside the label, just its value");
  assert.equal(tables.flatten("| Stop | Times |\n|---|---|\n| Quay | 9:10, 9:40 |\n", "slack"), "**Quay**: 9:10, 9:40\n");
  assert.equal(tables.flatten("| Day | Open | Shut |\n|---|---|---|\n| Sat | 9, or 10 in winter | 17 |", "line"), "Sat: Open 9, or 10 in winter; Shut 17", "a value with a comma in it is kept apart");
});

test("the web chat, code and pipes that are not a table are left as written", () => {
  assert.equal(tables.flatten(ANSWER, "web"), ANSWER);
  const code = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
  assert.equal(tables.flatten(code, "whatsapp"), code);
  assert.equal(tables.flatten("Pick A | B, either works.", "whatsapp"), "Pick A | B, either works.");
  assert.equal(tables.hasTable("Pick A | B"), false);
});

// The page is made through the database and the person's model, so their
// stand-ins stay in place until the test ends.
function load(stubs, t) {
  const full = require.resolve("../lib/chat-tables");
  delete require.cache[full];
  const real = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = real; delete require.cache[full]; });
  return require(full);
}
function stubs(saved, updated) {
  return {
    "../user-store": { supabase: { from: () => ({
      insert: (row) => { saved.push(row); return { select: () => ({ single: async () => ({ data: { id: "page-1" }, error: null }) }) }; },
      update: (row) => ({ eq: () => ({ eq: async () => { updated.push(row); return { error: null }; } }) }),
    }) } },
    "./dashboard-links": { reportUrl: async (platform, id) => `https://example.test/page/${id}` },
    "./llm": { getInternalClient: () => ({ model: "m", client: { messages: { create: async () => ({ content: [{ type: "text", text: "**\"Buying or renting vans.\"**" }] }) } } }) },
  };
}

test("a chat answer with a table is kept as a page, linked under the answer, and the chat gets lines", async (t) => {
  const saved = [], updated = [];
  const mod = load(stubs(saved, updated), t);
  const out = await mod.forChatApp({ userId: "u1", platform: "whatsapp_linked", text: ANSWER, asked: "Should we buy or rent the vans for the market stall this year, given we only trade on Saturdays and the market moves to the harbour in spring?" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, "Two vans cover it.\n\n| | Buy | Rent |\n|---|---|---|\n| Small van | £18k | £400/mo |\n| **Large van**, refrigerated | £31k | - |\n\nRenting wins under two years.", "the whole answer, the table as a table");
  assert.equal(saved[0].title, "Should we buy or rent the vans for the market stall this year, given we only trade on Saturdays and the…", "named after the question at first");
  assert.match(out, /^Two vans cover it\.\n\n\[\[next\]\]\n\n\*\*Small van\*\*: Buy £18k, Rent £400\/mo\n[\s\S]*Renting wins under two years\.\n\nOpen the page: https:\/\/example\.test\/page\/page-1$/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(updated, [{ title: "Buying or renting vans" }], "then given a short title by the person's model, as plain words");
});

test("no second page when the turn made one, and none in the web chat or without a table", async (t) => {
  const saved = [], updated = [];
  const mod = load(stubs(saved, updated), t);
  assert.equal(await mod.forChatApp({ userId: "u1", platform: "telegram", text: ANSWER, asked: "vans?", madePage: true }), tables.flatten(ANSWER, "telegram"));
  const linked = ANSWER + "\n\nOpen the page: https://example.test/page/abc";
  assert.equal(await mod.forChatApp({ userId: "u1", platform: "slack", text: linked, asked: "vans?" }), tables.flatten(linked, "slack"));
  assert.equal(await mod.forChatApp({ userId: "u1", platform: "web", text: ANSWER, asked: "vans?" }), ANSWER);
  assert.equal(await mod.forChatApp({ userId: "u1", platform: "whatsapp", text: "No table here.", asked: "vans?" }), "No table here.");
  assert.equal(saved.length, 0);
});

test("a run's page belongs to its run, so its delivery links it", async () => {
  const rows = [];
  const db = { from: () => ({ insert: (row) => { rows.push(row); return { select: () => ({ single: async () => ({ data: { id: "p" }, error: null }) }) }; } }) };
  await tables.keepAsPage("u1", ANSWER, { title: "Van costs", run: { table: "agent_tasks", id: "t1" }, db });
  await tables.keepAsPage("u1", ANSWER, { title: "Weekly van check", run: { table: "automation_runs", id: "r1" }, db });
  assert.equal(rows[0].task_id, "t1");
  assert.equal(rows[1].automation_run_id, "r1");
  assert.equal(rows[0].title, "Van costs");
});

// An answer nobody gets in a chat, or one too long for a chat (which gets a
// short version and once linked the Agents tab), is kept as its run's page:
// a task's card leaves the tab after a week, a page stays on Pages.
test("an answer only on the dashboard, or too long for a chat, becomes its run's page", async () => {
  const delivery = require("../lib/task-delivery");
  const rows = [];
  const db = { from: () => ({ insert: (row) => { rows.push(row); return { select: () => ({ single: async () => ({ data: { id: "p" + rows.length }, error: null }) }) }; } }) };
  const task = { id: "t1", user_id: "u1", title: "Van costs" };
  assert.equal(await delivery.answerPage(db, task, "agent_tasks", "Two vans cover it.", []), "p1", "answered only here");
  assert.equal(rows[0].task_id, "t1");
  assert.equal(rows[0].reason, "A task's answer, kept only here");
  assert.equal(await delivery.answerPage(db, task, "agent_tasks", "Two vans cover it.", [{ platform: "telegram", chatId: "9" }]), null, "a short answer in a chat stays in the chat");
  const long = "Renting wins. ".repeat(300);
  assert.equal(await delivery.answerPage(db, { id: "r1", user_id: "u1", runtime: { config: { name: "Weekly van check" } } }, "automation_runs", long, [{ platform: "telegram", chatId: "9" }]), "p2", "too long for a chat");
  assert.deepEqual([rows[1].automation_run_id, rows[1].title, rows[1].reason], ["r1", "Weekly van check", "An answer too long for a chat"]);
  assert.equal(await delivery.answerPage(db, { id: "r2", user_id: "u1", runtime: {} }, "automation_runs", "Short.", []), null, "a routine's short run keeps to its card");
  assert.equal(await delivery.answerPage(db, task, "agent_tasks", null, []), null, "nothing to keep when it could not finish");
});

test("every way an answer reaches a chat app goes through it", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /finalText = await require\("\.\/chat-tables"\)\.forChatApp\(\{ userId, platform: deliverPlatform, text: finalText, asked: require\("\.\/one-chat"\)\.theirWords\(userMessage\), madePage: toolsUsed\.has\("save_report"\) \}\);\n(?:\s*\/\/.*\n)*\s*finalText = require\("\.\/page-link"\)\.linkLast\(finalText\);/, "a chat turn, before its page link is placed");
  assert.match(engine, /wrapText = await require\("\.\/chat-tables"\)\.forChatApp\(/, "the summary of a turn that ran out of time");
  assert.match(read("lib/messaging.js"), /message = require\("\.\/chat-tables"\)\.flatten\([\s\S]{0,140}, platform\);/, "background answers, Pulse and reminders");
  assert.match(read("lib/chat-format.js"), /require\("\.\/chat-tables"\)\.flatten\(String\(text\), "whatsapp"\)/, "WhatsApp, a turn from elsewhere copied into the person's own chat included");
  const delivery = read("lib/task-delivery.js");
  assert.match(delivery, /const reportId = await reportFor\(db, row, table\) \|\| await tablePage\(row, table, report, destinations\) \|\| await answerPage\(db, row, table, report, destinations\);/, "a run's answer");
  assert.doesNotMatch(delivery, /needsTableAdaptation/, "no model call to rewrite a table");
});
