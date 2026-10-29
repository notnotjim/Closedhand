// Replying to an earlier message picks its topic up in the one Chat: the
// message replied to goes in front of the new one in every app, and when it
// has left the conversation the LLM reads, the exchange it was in comes back
// word for word from the archive (lib/reply-context.js). The web chat has a
// Reply on each message and a Search Chat to find an old one. Invented
// people and places only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { noteFor } = require("../lib/reply-context");

// A stand-in for data_cache: eq, ilike on data->>text, in, limit.
function archive(rows) {
  return { from: () => {
    const filters = []; let cap = Infinity;
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push((r) => (k === "source" ? r.source === v : k === "user_id" ? r.user_id === v : true)); return q; },
      ilike: (k, v) => { const needle = v.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase(); filters.push((r) => String(r.data.text).toLowerCase().includes(needle)); return q; },
      in: (k, ids) => { filters.push((r) => ids.includes(r.external_id)); return q; },
      limit: (n) => { cap = n; return q; },
      then: (ok) => ok({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, cap), error: null }),
    };
    return q;
  } };
}
const turn = (n, sender, text) => ({ user_id: "u1", source: "conversation", external_id: `conv-t1-${n}`, data: { chat: "t1", sender, text } });
const rows = [
  turn(0, "me", "Morning, anything on today?"),
  turn(1, "Closedhand", "Just the dentist at 3."),
  turn(2, "me", "Can you find flats in Porto under 900 a month near the river?"),
  turn(3, "Closedhand", "Three fit: Rua das Flores 12 at 850, Cais da Ribeira 4 at 880, and Miragaia 9 at 790. Miragaia has a balcony."),
  turn(4, "me", "Book a viewing for Miragaia on Saturday."),
  turn(5, "Closedhand", "Asked the agent, Ines Duarte, for Saturday at 11."),
  turn(6, "me", "Thanks"),
];

test("a reply to a message that has left the conversation brings back the exchange it was in", async () => {
  const note = await noteFor("u1", '[replying to Closedhand\'s message: "Three fit: Rua das Flores 12 at 850, Cais da Ribeira 4 at 880, and Miragaia 9 at 790. Miragaia has a balcony."]\nIs the balcony one still free?', { conversation: [{ role: "user", content: "What time is it in Lisbon?" }], supabase: archive(rows) });
  assert.match(note, /has left the conversation you can see/);
  assert.match(note, /The user: Can you find flats in Porto under 900/, "the lead-up");
  assert.match(note, /You \(Closedhand\) \(the message being replied to\): Three fit:/);
  assert.match(note, /The user: Book a viewing for Miragaia on Saturday\./, "and what followed");
  assert.ok(note.indexOf("Can you find flats") < note.indexOf("Three fit") && note.indexOf("Three fit") < note.indexOf("Book a viewing"), "in order");
});

test("nothing more when the message is still in view, the quote is too short, or nothing matches", async () => {
  const db = archive(rows);
  const quote = '[Replying to: "Three fit: Rua das Flores 12 at 850, Cais da Ribeira 4 at 880"]\n\nAnd the cheapest?';
  assert.equal(await noteFor("u1", quote, { conversation: [{ role: "assistant", content: "Three fit: Rua das Flores 12 at 850, Cais da Ribeira 4 at 880, and Miragaia 9 at 790." }], supabase: db }), null, "the quote already points at it");
  assert.equal(await noteFor("u1", '[Replying to: "ok"]\n\nyes', { conversation: [], supabase: db }), null);
  assert.equal(await noteFor("u1", '[Replying to: "A message nobody ever sent about a yacht"]\n\nhm', { conversation: [], supabase: db }), null);
  assert.equal(await noteFor("u1", "No reply at all", { conversation: [], supabase: db }), null);
});

test("every app's reply goes in the same way, the web chat's too, and the engine hears the earlier exchange", () => {
  const ws = read("lib/web-chat-ws.js");
  assert.match(ws, /text = `\[replying to \$\{who\}: "\$\{quote\}"\]\\n\$\{text\}`;/);
  assert.match(read("lib/project-rules.js"), /const REPLY = \/\^\\s\*\\\[replying to\[\^"\\\]\]\*"\(\[\\s\\S\]\*\?\)"\\\]\\s\*\/i;/, "one reader for every app's form");
  const engine = read("lib/engine.js");
  assert.match(engine, /turnOpts\.replyNote = await require\("\.\/reply-context"\)\.noteFor\(userId, userMessage\)/);
  assert.match(engine, /\(opts\.replyNote \? "\\n\\n" \+ opts\.replyNote : ""\)/);
});

test("the web chat: Reply on each message, the message replied to above the box and atop the reply, and Search Chat", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /reply\.title = 'Reply';\n\s+reply\.setAttribute\('aria-label', 'Reply'\);/);
  assert.match(page, /<div class="reply-bar" id="replyBar" hidden>/);
  assert.match(page, /if \(_replyTo\) \{ payload\.replyTo = _replyTo\.text; payload\.replyWho = _replyTo\.who; clearReply\(\); \}/);
  assert.match(page, /quote\.className = 'msg-quote'; quote\.textContent = replied\[1\];/, "a sent reply shows what it answers, from history too");
  assert.match(page, /<input type="search" id="chatSearch" placeholder="Search Chat" aria-label="Search Chat"/);
  assert.match(page, /fetch\('\/api\/conversation\/search\?q=' \+ encodeURIComponent\(q\)\)/);
  assert.match(page, /setReply\(r\.text, r\.who\);/, "a result is replied to");
  const server = read("webapp/projects.js");
  assert.match(server, /app\.get\("\/api\/conversation\/search"/);
  assert.match(server, /\.eq\("source", "conversation"\)\n\s+\.ilike\("data->>text"/, "the archive is searched too");
  assert.match(server, /filter\(\(r\) => !skip\.has\(String\(r\.data\?\.chat\)\)\)/, "and project conversations are left out");
});

test("deleting a project takes its whole conversation, its Context Notes and the turns kept once condensed, and leaves files and Pinned Facts", async () => {
  const done = [];
  const db = { from: (table) => {
    const call = { table, op: "select", filters: [] };
    const q = {
      select: () => q, single: () => q, insert: (row) => { done.push({ table, op: "insert", row }); return Promise.resolve({ error: null }); },
      delete: () => { call.op = "delete"; return q; },
      eq: (k, v) => { call.filters.push([k, v]); return q; },
      in: (k, v) => { call.filters.push([k, v]); return q; },
      then: (ok) => {
        done.push(call);
        if (table === "projects" && call.op === "select") return ok({ data: { name: "Porto flat" }, error: null });
        if (table === "conversation_threads") return ok({ data: [{ id: "t9" }], error: null });
        return ok({ data: null, error: null });
      },
    };
    return q;
  } };
  const { deleteProject } = require("../lib/project-rules");
  assert.deepEqual(await deleteProject(db, "u1", "p1"), {});
  const archive = done.find((c) => c.table === "data_cache");
  assert.deepEqual(archive && { op: archive.op, filters: archive.filters }, { op: "delete", filters: [["user_id", "u1"], ["source", "conversation"], ["data->>chat", ["t9"]]] });
  const notes = done.find((c) => c.table === "data_vectors");
  assert.deepEqual(notes && { op: notes.op, filters: notes.filters }, { op: "delete", filters: [["user_id", "u1"], ["item_type", "conversation_summary"], ["source_metadata->>thread_id", ["t9"]]] }, "and the Context Notes made from it, so Chat recalls nothing of it");
  assert.ok(!done.some((c) => c.table === "facts" || c.table === "documents"), "Pinned Facts and files stay");
  assert.ok(done.findIndex((c) => c.table === "conversation_threads") < done.findIndex((c) => c.table === "projects" && c.op === "delete"), "its threads are found before the project (and they with it) are gone");
});
