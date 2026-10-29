// /clear in any chat asks first, in the dashboard's words, and only a yes
// clears; then it clears what the dashboard's Clear conversation history
// clears, through the same code (clear-conversations.js). It used to clear
// at once, with no question, and differently on each side: the web chat kept
// Context Notes, the chat apps kept the web chat's transcript, and neither
// cleared Closedhand's own email.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// Tables that do what the queries say, for the few query shapes the wipe uses.
function tables(data) {
  const field = (row, col) => col.includes("->>") ? row[col.split("->>")[0]]?.[col.split("->>")[1]] : row[col];
  return {
    data,
    from(name) {
      const where = [];
      let op = "select", patch = null, one = false;
      const q = {
        select: () => q,
        delete: () => ((op = "delete"), q),
        update: (p) => ((op = "update"), (patch = p), q),
        eq: (c, v) => (where.push((r) => field(r, c) === v), q),
        in: (c, vs) => (where.push((r) => vs.includes(field(r, c))), q),
        maybeSingle: () => ((one = true), q),
        then(res, rej) {
          const rows = data[name] || [];
          const hit = rows.filter((r) => where.every((w) => w(r)));
          if (op === "delete") data[name] = rows.filter((r) => !hit.includes(r));
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: one ? hit[0] || null : hit, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

test("clearing takes conversations and their Context Notes, everywhere, and leaves Pinned Facts, schedules and connections", async () => {
  const db = tables({
    assistant_email_accounts: [{ user_id: "u1", address: "pip@closedhand.ai" }],
    assistant_email_threads: [{ user_id: "u1" }],
    conversation_threads: [{ user_id: "u1" }, { user_id: "u2" }],
    conversations: [{ user_id: "u1", messages: [{ role: "user", content: "hi" }], summary: "s" }],
    web_messages: [{ user_id: "u1" }],
    data_cache: [{ user_id: "u1", source: "conversation" }, { user_id: "u1", source: "assistant_email" }, { user_id: "u1", source: "gmail" }],
    data_vectors: [
      { user_id: "u1", service: "memory", item_type: "conversation_summary" },
      { user_id: "u1", service: "memory", item_type: "thread_summary" },
      { user_id: "u1", service: "memory", item_type: "fact" },
      { user_id: "u1", service: "email", source_metadata: { source: "assistant_email" } },
      { user_id: "u1", service: "email", source_metadata: { source: "gmail" } },
    ],
    facts: [{ user_id: "u1", key: "partner" }],
    schedules: [{ user_id: "u1" }],
    connections: [{ user_id: "u1", service: "google" }],
  });
  const relayed = [];
  const { clearConversations } = require("../lib/clear-conversations");
  await clearConversations(db, "u1", async (account, ...call) => relayed.push([account.address, ...call]));
  const d = db.data;
  assert.deepEqual(relayed, [["pip@closedhand.ai", "clear", "POST", { remove: false, resume: true }]], "the email relay's copy too");
  assert.equal(d.assistant_email_threads.length, 0);
  assert.deepEqual(d.conversation_threads, [{ user_id: "u2" }], "only this person's");
  assert.deepEqual(d.conversations[0].messages, []);
  assert.equal(d.web_messages.length, 0);
  assert.deepEqual(d.data_cache.map((r) => r.source), ["gmail"]);
  assert.deepEqual(d.data_vectors.map((r) => r.item_type || r.source_metadata.source), ["fact", "gmail"], "Context Notes go, Pinned Facts stay");
  assert.equal(d.facts.length + d.schedules.length + d.connections.length, 3);
});

test("the dashboard and /clear clear with the same code", () => {
  assert.equal(read("lib/clear-conversations.js"), read("webapp/clear-conversations.js"));
  assert.match(read("webapp/server.js"), /app\.post\("\/api\/account\/clear-conversations"[\s\S]{0,400}clearConversations\(supabase, userId, require\("\.\/assistant-email-settings"\)\.call\)/);
  assert.match(read("lib/conversation.js"), /clearConversations\(supabase, userId, require\("\.\/assistant-email"\)\.call\)/);
  assert.doesNotMatch(read("webapp/server.js"), /\/api\/chat\/clear/, "the web chat's own lesser clear is gone");
});

function command() {
  const calls = { cleared: [], sent: [], saved: 0 };
  const stand = (rel, exports) => { const file = require.resolve(path.join(root, "lib", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
  stand("conversation.js", { clearHistory: async (userId) => { calls.cleared.push(userId); } });
  stand("storage.js", { saveStore: () => { calls.saved++; } });
  stand("web-chat-ws.js", { sendToUser: (userId, msg) => calls.sent.push([userId, msg]) });
  const file = require.resolve(path.join(root, "lib/clear-command.js"));
  delete require.cache[file];
  return { clear: require(file), calls };
}

test("/clear asks first in the dashboard's words, and a yes clears", async () => {
  const { clear, calls } = command();
  assert.equal(clear.isClear("/clear"), true);
  assert.equal(clear.isClear(" /CLEAR "), true);
  assert.equal(clear.isClear("/clear the table for me"), false);
  const asked = clear.ask("u1");
  assert.match(asked, /^Clear your conversation history\? .*Context Notes\. Pinned Facts, schedules and connections stay\. Reply yes to clear it\.$/);
  assert.match(read("webapp/views/dashboard.html"), /Conversations and their Context Notes\. Pinned Facts, schedules and connections stay\./, "the dashboard says the same");
  assert.deepEqual(calls.cleared, [], "nothing cleared by asking");
  assert.equal(clear.answersClearQuestion("u1", "yes"), true);
  assert.equal(await clear.handleClearReply("u1", "Yes!"), "Conversation history cleared. Pinned Facts, schedules and connections stayed.");
  assert.deepEqual(calls.cleared, ["u1"]);
  assert.equal(calls.saved, 1);
  assert.deepEqual(calls.sent, [["u1", { type: "cleared" }]], "an open web chat empties");
  assert.equal(clear.handleClearReply("u1", "yes"), null, "one yes, one clear");
});

test("a no, anything else or a late yes clears nothing", async () => {
  const { clear, calls } = command();
  clear.ask("u1");
  assert.equal(await clear.handleClearReply("u1", "no"), "Not cleared.");
  clear.ask("u1");
  assert.equal(clear.handleClearReply("u1", "what's on tomorrow?"), null, "they moved on");
  assert.equal(clear.handleClearReply("u1", "yes"), null, "so a later yes is not this one");
  clear.ask("u1");
  clear._waiting.set("u1", Date.now() - 16 * 60 * 1000);
  assert.equal(clear.answersClearQuestion("u1", "yes"), false);
  assert.equal(clear.handleClearReply("u1", "yes"), null);
  assert.deepEqual(calls.cleared, []);
});

test("/clear is decided in one place for every chat, before the model, and no chat app clears on its own", () => {
  const engine = read("lib/engine.js");
  const at = (s) => engine.indexOf(s);
  assert.ok(at("clearCommand.isClear(userMessage)") > 0 && at("clearCommand.handleClearReply(userId, userMessage)") > 0);
  assert.ok(at("clearCommand.handleClearReply(userId, userMessage)") < at("if (ctx.foldedIn)"), "a yes taken into a running reply is still read as the answer");
  assert.ok(at("clearCommand.handleClearReply(userId, userMessage)") < at("if (isBugReport(userMessage))"), "/bug after /clear drops the clear question, so a yes to the report can't clear later");
  assert.ok(at("clearCommand.isClear(userMessage)") > at("handleBugSendReply(userId, userMessage)"), "/clear after /bug drops the bug question");
  for (const f of fs.readdirSync(path.join(root, "lib/platforms"))) {
    const src = read("lib/platforms/" + f);
    assert.doesNotMatch(src, /"\/clear"/, f);
    assert.doesNotMatch(src, /=== "\/[a-z]|startsWith\("\/[a-z]/, f + ": no commands of its own, so every chat app answers the same (Telegram's /start only begins introductions)");
    assert.doesNotMatch(src, /clearAllThreads/, f);
    assert.doesNotMatch(src, /services\.push\("Gmail, Calendar, Drive"\)/, f + ": 'start' no longer answers with an old list of connections");
  }
  const web = read("webapp/views/index.html");
  assert.doesNotMatch(web, /text === '\/clear'/, "the web chat sends /clear like any message");
  assert.match(web, /msg\.type === 'cleared'/);
});

test("a yes to the question waits its turn rather than joining a reply already running", () => {
  const { clear } = command();
  const ctx = require("../lib/context");
  ctx.pendingConfirmations = ctx.pendingConfirmations || {};
  const fold = require("../lib/fold-in");
  clear.ask("u9");
  const real = require.resolve(path.join(root, "lib/clear-command.js"));
  assert.equal(require.cache[real].exports, clear);
  assert.equal(fold.arrive("u9", { text: "yes", platform: "telegram", chatId: 1 }), null);
});
