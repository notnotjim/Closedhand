// Files kept by Closedhand are deleted on time: a file the person sent 90
// days after Closedhand last used it, a working copy (fetched from their
// mail, Drive or a chat, or too big for the web chat) a day on, since the
// original stays where it came from. Every copy goes, the copy on disk too.
// Nothing Closedhand sends is listed as a file: what it makes is a page, and
// Files left the Pages tab. All ids invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { deleteOldFiles } = require("../lib/file-expiry");

const DAY = 86400000, NOW = Date.parse("2026-10-26T00:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

function fakeDb(rows, projects = []) {
  const removed = [];
  const db = {
    storage: { from: () => ({ remove: async (paths) => { removed.push(...paths); return {}; } }) },
    from: (table) => {
      if (table === "projects") return { select: async () => ({ data: projects, error: null }) };
      const f = [];
      const q = {
        select() { return q; },
        eq(k, v) { f.push((r) => r[k] === v); return q; },
        neq(k, v) { f.push((r) => r[k] !== v); return q; },
        lt(k, v) { f.push((r) => r[k] < v); return q; },
        in(k, vs) { f.push((r) => vs.includes(r[k])); return q; },
        delete() { q.deleting = true; return q; },
        then(ok, bad) {
          const hit = rows.filter((r) => f.every((t) => t(r)));
          if (q.deleting) { for (const r of hit) rows.splice(rows.indexOf(r), 1); return Promise.resolve({ error: null }).then(ok, bad); }
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(ok, bad);
        },
      };
      return q;
    },
  };
  return { db, removed };
}

test("a file sent goes 90 days after its last use, a working copy a day on, and every copy with it", async () => {
  const rows = [
    { user_id: "u1", attachment_id: "att_1", storage_path: "u1/att_1", direction: "in", created_at: ago(120), last_used_at: ago(91) },
    { user_id: "u1", attachment_id: "att_2", storage_path: "u1/att_2", direction: "in", created_at: ago(120), last_used_at: ago(89) },
    { user_id: "u1", attachment_id: "att_3", storage_path: "u1/att_3", direction: "working", created_at: ago(2) },
    { user_id: "u1", attachment_id: "att_4", storage_path: "u1/att_4", direction: "working", created_at: new Date(NOW - 3600000).toISOString() },
    { user_id: "u1", attachment_id: "att_out_5", storage_path: "u1/att_out_5", direction: "out", created_at: ago(6) },
    { user_id: "u1", attachment_id: "att_6", storage_path: "u1/att_6", direction: "in", created_at: ago(300), last_used_at: ago(200) },
  ];
  const projects = [{ context: [{ kind: "file", id: "att_6", title: "Floor plan.pdf" }, { kind: "note", id: "note_1" }] }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-files-"));
  for (const name of ["att_1.pdf", "att_2.jpg", "att_3.pdf", "att_4.png", "att_9.pdf", "att_10.pdf"]) {
    fs.writeFileSync(path.join(dir, name), "x");
    const t = name === "att_10.pdf" ? new Date(NOW - 60000) : new Date(NOW - 2 * 3600000);
    fs.utimesSync(path.join(dir, name), t, t);
  }
  const { db, removed } = fakeDb(rows, projects);
  assert.equal(await deleteOldFiles(db, NOW, dir), 3);
  assert.deepEqual(rows.map((r) => r.attachment_id), ["att_2", "att_4", "att_6"], "a file a project holds stays as long as the project");
  assert.deepEqual(removed.sort(), ["u1/att_1", "u1/att_3", "u1/att_out_5"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["att_10.pdf", "att_2.jpg", "att_4.png"], "the disk copies go too, and one deleted on the dashboard, but never one just arriving");
  fs.rmSync(dir, { recursive: true });
  assert.match(read("index.js"), /require\("\.\/lib\/file-expiry"\)\.start\(\);/);
  assert.doesNotMatch(read("lib/attachments.js"), /cleanupOldAttachments|ATTACHMENT_MAX_AGE_MS/, "the old cleanup, which nothing ran, is gone");
  const att = read("lib/attachments.js");
  assert.equal((att.match(/usedNow\(userId, attachmentId\);/g) || []).length, 2, "reading it or attaching it to an email counts as use");
  assert.match(read("migrations/073_attachment_last_used.sql"), /UPDATE attachments SET last_used_at = created_at WHERE last_used_at IS NULL;/);
  assert.match(read("webapp/views/dashboard.html"), />Files you've sent Closedhand\. Automatically deleted from Closedhand's records 90 days after they were last used\.</);
});

test("a fetched file is a working copy, never one the person sent, and nothing sent is filed as a file", () => {
  assert.match(read("lib/services/data-access.js"), /buffer, ext, fileName: filename, direction: "working",/);
  const messaging = read("lib/messaging.js");
  assert.doesNotMatch(messaging, /recordOutgoingFile|FILE_ORIGIN_LABELS|saved on your dashboard|too large/);
  assert.match(messaging, /sendToUser\(chatId, \{ type: "file", filename, mediaType: mimeType \|\| "application\/octet-stream", size: buffer\.length, url: `\/api\/files\/\$\{encodeURIComponent\(id\)\}\/download` \}\);/, "a big file in the web chat is a link, never refused");
  assert.match(read("webapp/views/index.html"), /var url = msg\.url \|\| \('data:'/);
  assert.match(messaging, /async function sendDocument\(chatId, buffer, filename, mimeType\) \{\n\s*return sendDocumentToPlatform\(/);
  const server = read("webapp/server.js");
  assert.doesNotMatch(server, /app\.get\("\/api\/files", |app\.delete\("\/api\/files", /);
  assert.match(server, /\.eq\("direction", "in"\)\n\s*\.order\("created_at", \{ ascending: false \}\)/, "Files you've sent lists what the person sent");
});
