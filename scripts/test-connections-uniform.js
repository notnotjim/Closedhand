// Every connection is read the same way (AGENTS.md): its items' text whole,
// its links kept beside their words, its own files read by the one file step
// at the index's one entry, whichever connection it is. Invented data only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// data_cache as a list of rows, with the queries the code makes of it.
// A column, or a path into a JSON one ("data->>_channelId").
const val = (r, k) => (/->>/.test(k) ? k.split(/->>|->/).reduce((o, p) => (o == null ? o : o[p]), r) : r[k]);
function fakeDb(rows) {
  return {
    from() {
      const filters = [];
      let cols = "*", one = false, upserting = null;
      const q = {
        select(c) { cols = c || "*"; return q; },
        eq(k, v) { filters.push((r) => String(val(r, k)) === String(v)); return q; },
        in(k, vs) { filters.push((r) => vs.map(String).includes(String(val(r, k)))); return q; },
        gt(k, v) { filters.push((r) => val(r, k) > v); return q; },
        order() { return q; },
        limit(n) { q.max = n; return q; },
        maybeSingle() { one = true; return q; },
        single() { one = true; return q; },
        upsert(batch) { upserting = batch; return q; },
        update(patch) { q.patch = patch; return q; },
        then(resolve, reject) {
          if (q.patch) {
            for (const r of rows.filter((r) => filters.every((f) => f(r)))) Object.assign(r, JSON.parse(JSON.stringify(q.patch)));
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          if (upserting) {
            for (const b of upserting) {
              const at = rows.findIndex((r) => r.user_id === b.user_id && r.source === b.source && r.external_id === b.external_id);
              if (at >= 0) rows[at] = JSON.parse(JSON.stringify(b)); else rows.push(JSON.parse(JSON.stringify(b)));
            }
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
          const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, q.max || Infinity).map((r) => (/file_texts:data->file_texts/.test(cols)
            ? { external_id: r.external_id, file_texts: r.data?.file_texts ?? null } : JSON.parse(JSON.stringify(r))));
          return Promise.resolve({ data: one ? hit[0] || null : hit, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const stub = (rel, exports) => { const id = require.resolve(path.join("..", rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };

test("the index's one entry reads the files of whatever rows an item names, given whole or by id, for any connection", async () => {
  const rows = [{ user_id: "u1", source: "connected:team-chat", external_id: "C1_17", data: { id: "C1_17", text: "[file: Plan.txt]", files: [{ key: "F9", name: "Plan.txt", mime: "text/plain", size: 900 }] } }];
  const db = fakeDb(rows);
  stub("user-store", { supabase: db, UserStore: { load: async () => ({}) } });
  stub("lib/db", { supabase: db });
  stub("lib/storage", { swapToCloudStore: () => {} });
  stub("lib/idle", { during: (fn) => fn(), touch() {}, isIdle: () => true, oneAtATime: (fn) => fn(), LOOK_MS: 5 });
  stub("lib/services/data-access", { attachmentBytes: async (u, p) => ({ buffer: Buffer.from(p.attachment_id === "F9" ? "Launch on 4 May" : "Total due 35.50"), filename: p.filename }) });
  for (const m of ["lib/item-files", "lib/services/usi"]) delete require.cache[require.resolve(path.join("..", m))];
  const usi = require("../lib/services/usi");
  const items = [
    { external_id: "conv-1", text: "Slack conversation", rows: [{ source: "connected:team-chat", external_id: "C1_17" }] },
    { external_id: "mail-1", text: "Your bill", rows: [{ source: "gmail", external_id: "m1", data: { id: "m1", attachments: [{ filename: "Bill.txt", size: 800, attachmentId: "a1" }] } }] },
    { external_id: "page-1", text: "A page with no files" },
  ];
  await usi._withRowFiles("u1", items);
  assert.deepEqual(items[0].files, [{ name: "Plan.txt", text: "Launch on 4 May" }], "read from the cached row");
  assert.deepEqual(items[1].files, [{ name: "Bill.txt", text: "Total due 35.50" }], "read from the row given");
  assert.equal(items[2].files, undefined);
  assert.ok(items.every((i) => !("rows" in i)), "the rows are not indexed themselves");
  assert.equal(rows[0].data.file_texts[0].text, "Launch on 4 May", "and what was read is kept on the row");
});

test("saving a row again keeps what was read from the files it still has", async () => {
  const rows = [{ user_id: "u1", source: "gcal", external_id: "ev1", data: { id: "ev1", attachments: [{ name: "Agenda.txt", fileId: "f1" }, { name: "Old.txt", fileId: "f0" }],
    file_texts: [{ key: "f1", name: "Agenda.txt", text: "Budget first" }, { key: "f0", name: "Old.txt", text: "gone" }] } }];
  stub("user-store", { supabase: fakeDb(rows), UserStore: {} });
  delete require.cache[require.resolve("../lib/services/data-sync")];
  delete require.cache[require.resolve("../lib/item-files")];
  const sync = require("../lib/services/data-sync");
  await sync.upsertCacheItems("u1", "gcal", "event", [{ id: "ev1", summary: "Board", attachments: [{ name: "Agenda.txt", fileId: "f1" }] }]);
  assert.equal(rows[0].data.summary, "Board", "saved anew");
  assert.deepEqual(rows[0].data.file_texts, [{ key: "f1", name: "Agenda.txt", text: "Budget first" }], "a file it still has is not read again; one it no longer has is dropped");
});

test("HTML from any connection is read whole, each link's address beside its words", () => {
  stub("user-store", { supabase: fakeDb([]), UserStore: {} });
  delete require.cache[require.resolve("../lib/services/data-sync")];
  const sync = require("../lib/services/data-sync");
  const html = `<p>Your crossing is booked. <a href="https://ferries.example/b/NS-44182">Manage booking</a></p>
    <p><a href="https://videos.example/welcome"><img alt="Watch the welcome video" src="w.jpg"></a></p>
    <p>This email is intended to confirm your crossing on 3 April, cabin 8127.</p><p>-- <br>Northsea Ferries</p>`;
  const mail = sync.gmailItem({ id: "m1", threadId: "t1", labelIds: ["INBOX"], payload: { mimeType: "text/html", headers: [{ name: "Subject", value: "Your crossing" }, { name: "From", value: "Northsea Ferries <b@northsea.example>" }], body: { data: Buffer.from(html).toString("base64url") } } }, "alex@example.com");
  assert.match(mail.body, /Manage booking \(https:\/\/ferries\.example\/b\/NS-44182\)/);
  assert.match(mail.body, /Watch the welcome video \(https:\/\/videos\.example\/welcome\)/, "a link with only a picture keeps the picture's words");
  assert.match(mail.body, /cabin 8127/, "nothing cut after a line that reads like a disclaimer");
  assert.match(mail.body, /Northsea Ferries$/, "or a signature");
  assert.equal(sync._test.eventText(`Bring <b>photo ID</b>. <a href="https://venue.example/map">Map</a>`), "Bring photo ID. Map (https://venue.example/map)", "an event description written in a calendar's editor");
});

test("calendar feeds keep descriptions whole and list attachments given by address, which are fetched from it", async () => {
  const { icsAttachments } = require("../lib/services/ics-calendar");
  assert.deepEqual(icsAttachments([{ val: "https://files.example/agenda%20v2.pdf", params: { FMTTYPE: "application/pdf" } }, "CID:inline-part"]),
    [{ name: "agenda v2.pdf", mimeType: "application/pdf", fileId: "https://files.example/agenda%20v2.pdf" }]);
  const long = "Agenda. ".repeat(400) + "Parking at the back.";
  const ev = require("../lib/services/caldav")._test.parseEvent({ data: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Board\r\nDTSTART:20261110T090000Z\r\nDESCRIPTION:${long}\r\nATTACH;FMTTYPE=application/pdf;FILENAME=Minutes.pdf:https://files.example/m.pdf\r\nEND:VEVENT\r\nEND:VCALENDAR` });
  assert.ok(ev.description.endsWith("Parking at the back."), "whole");
  assert.deepEqual(ev.attachments, [{ name: "Minutes.pdf", mimeType: "application/pdf", fileId: "https://files.example/m.pdf" }]);
  // Fetched from its address, to the file step.
  const server = http.createServer((req, res) => res.end("Minutes: budget approved"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    stub("user-store", { supabase: fakeDb([]), UserStore: {} });
    delete require.cache[require.resolve("../lib/services/data-access")];
    const got = await require("../lib/services/data-access").attachmentBytes("u1", { source: "ics", attachment_id: `http://127.0.0.1:${server.address().port}/m.pdf`, filename: "Minutes.pdf" });
    assert.equal(String(got.buffer), "Minutes: budget approved");
  } finally { server.close(); }
});

test("every connection meets the one contract: no text cut, files listed and fetchable, nothing read its own way", () => {
  // (a) No connection cuts the text it keeps.
  const ingest = ["lib/services/data-sync.js", "lib/services/ics-calendar.js", "lib/services/caldav.js", "lib/services/mac-calendar.js", "lib/services/imap-mail.js",
    "lib/services/usi-connector.js", "lib/platforms/whatsapp-linked.js", "lib/services/bank-sync.js", "lib/assistant-email.js", "lib/services/mail-history.js", "lib/services/wa-digest.js"];
  const cuts = ingest.flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => /\b(text|body|description|content|notes|caption): [^\n]*\.(substring|slice)\(0, ?\d{3,}\)/.test(l) && !/\.outgoing\(/.test(l)); // mail Closedhand sends is not a connection's data
  assert.deepEqual(cuts.map(([f, n]) => `${f}:${n}`), [], "text cut on the way in");
  assert.doesNotMatch(read("lib/services/data-sync.js"), /\$\.text\(\)|CONFIDENTIALITY NOTICE/, "HTML made text by the one reader only");
  // (b) Every connection that keeps rows can have their files fetched.
  const sources = new Set();
  for (const f of ingest) for (const m of read(f).matchAll(/upsertCacheItems\(userId, "([a-z_]+)"/g)) sources.add(m[1]);
  sources.add("assistant_email");
  const access = read("lib/services/data-access.js");
  const fetchable = new Set([...access.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
  assert.ok(sources.size >= 6, "the check sees the connections");
  assert.deepEqual([...sources].filter((s) => !fetchable.has(s)), [], "a connection whose files nothing can fetch");
  assert.match(access, /if \(\/\^mcp:\/\.test\(source\)\) \{/, "a connected app's files, asked for again");
  // (c) Nothing reads a connection's files its own way.
  assert.doesNotMatch(read("lib/assistant-email.js"), /extractAttachmentText/, "mail to Closedhand's own address");
  assert.match(read("AGENTS.md"), /Every connection meets one\n  contract\./);
});

test("how far back each kind of connection is read is decided the same way, in one place", () => {
  const depth = require("../lib/services/sync-depth");
  assert.deepEqual([depth.MAIL_DAYS, depth.PERSONAL_MAIL_DAYS, depth.CALENDAR_PAST_DAYS, depth.CALENDAR_FUTURE_DAYS], [365, 1825, 1825, 365]);
  const t = Date.parse("2026-11-03T00:00:00Z"), DAY = 86400000;
  const first = depth.calendarWindows("u9:test", t);
  assert.deepEqual(first.map((w) => [Math.round((t - w.from) / DAY), Math.round((w.to - t) / DAY), w.far]), [[365, 365, false], [1825, -365, true]], "the year either side, and the years before");
  assert.equal(depth.calendarWindows("u9:test", t + 600000).length, 1, "not begun again beside a read under way");
  assert.equal(depth.calendarWindows("u9:test", t + 3600000).length, 2, "but again an hour on, if that one never finished");
  depth.farRead("u9:test", t + 3600000);
  assert.equal(depth.calendarWindows("u9:test", t + 7200000).length, 1, "then once a day");
  assert.ok(first.every((w) => w.to - w.from <= 4 * 365 * DAY + DAY), "no stretch longer than the four years a Mac answers at once");
  const sync = read("lib/services/data-sync.js");
  assert.equal((sync.match(/depth\.calendarWindows\(`\$\{userId\}:/g) || []).length, 3, "Google, Outlook and Mac calendars");
  assert.match(read("lib/services/caldav.js"), /depth\.calendarWindows\(`\$\{userId\}:caldav`\)/);
  assert.match(read("lib/services/ics-calendar.js"), /CALENDAR_PAST_DAYS: WINDOW_PAST_DAYS, CALENDAR_FUTURE_DAYS: WINDOW_FUTURE_DAYS \} = require\("\.\/sync-depth"\)/);
  assert.doesNotMatch(read("lib/services/ics-calendar.js"), /MAX_OCCURRENCES/, "every occurrence of a repeating event, not the first hundred");
  assert.match(read("lib/services/mail-history.js"), /const HORIZON_DAYS = depth\.MAIL_DAYS;/);
  assert.match(read("lib/platforms/whatsapp-linked.js"), /syncFullHistory: true,/);
  assert.doesNotMatch(read("lib/platforms/whatsapp-linked.js"), /HISTORY_CAP/);
  assert.match(read("lib/services/bank-sync.js"), /const EMPTY_WINDOWS_AT_THE_END = 2;/);
  assert.doesNotMatch(read("lib/services/recall-protocol.js"), /Page limit reached|Collection limit reached/, "a connected app is read on, not cut off");
});

test("a picture from any connection keeps its words and what it shows, written by the VLM on this computer even when an image model is chosen", async () => {
  const rows = [{ user_id: "u1", source: "gmail", external_id: "m7", data: { id: "m7", attachments: [{ filename: "Shopfront.jpg", size: 40 * 1024, attachmentId: "p1" }] } }];
  const db = fakeDb(rows);
  let asked = 0;
  const seen = [];
  stub("user-store", { supabase: db, UserStore: { load: async () => ({}) } });
  stub("lib/db", { supabase: db });
  stub("lib/storage", { swapToCloudStore: () => {} });
  stub("lib/idle", { during: (fn) => fn(), touch() {}, isIdle: () => true, oneAtATime: (fn) => fn(), LOOK_MS: 5 });
  stub("lib/services/data-access", { attachmentBytes: async () => ({ buffer: Buffer.alloc(40 * 1024, 7), filename: "Shopfront.jpg" }) });
  stub("lib/file-reader", { ...require("../lib/file-reader"), kindOf: () => "image", readFile: async () => ({ kind: "image", text: "LARKSPUR BAKERY open 7 till 3" }) });
  stub("lib/model-jobs", { role: (name) => (name === "vision" ? { model: "seeing" } : undefined), complete: async () => { asked++; return "from the image model"; } });
  stub("lib/local-models", { localDescribeImage: async (bytes, { urgent }) => { seen.push([bytes.length, urgent]); return "A bakery front on a narrow street, loaves in the window."; } });
  for (const m of ["lib/item-files", "lib/services/usi"]) delete require.cache[require.resolve(path.join("..", m))];
  const usi = require("../lib/services/usi");
  try {
    const both = "LARKSPUR BAKERY open 7 till 3\n\nA bakery front on a narrow street, loaves in the window.";
    assert.equal(await usi.extractAttachmentText(Buffer.alloc(40 * 1024, 7), "Shopfront.jpg", { maxChars: Infinity }), both, "its sign and its street");
    const item = { external_id: "mail-7", text: "Photos from the street", rows: [{ source: "gmail", external_id: "m7" }] };
    await usi._withRowFiles("u1", [item]);
    assert.equal(rows[0].data.file_texts[0].text, both.replace(/\s+/g, " "));
    assert.equal(asked, 0, "indexing never sends a picture to the image model");
    assert.deepEqual(seen, [[40 * 1024, false], [40 * 1024, false]], "every picture, behind anyone waiting on one");
  } finally {
    for (const m of ["lib/file-reader", "lib/model-jobs", "lib/local-models"]) delete require.cache[require.resolve(path.join("..", m))];
  }
});

// The index's own table, as the indexing pass and search use it.
function fakeIndex(searchRows = []) {
  const tables = { data_vectors: [], index_progress: [] };
  let nextId = 1;
  return {
    tables,
    rpc: async (name) => ({ data: name === "search_data_vectors" ? searchRows : [], error: null }),
    from(table) {
      const rows = tables[table] || (tables[table] = []);
      const filters = [];
      let op = null, payload = null, conflict = null, one = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { filters.push((r) => String(r[k]) === String(v)); return q; },
        in(k, vs) { filters.push((r) => vs.map(String).includes(String(r[k]))); return q; },
        gt(k, v) { filters.push((r) => r[k] > v); return q; },
        single() { one = true; return q; }, maybeSingle() { one = true; return q; },
        upsert(p, o) { op = "upsert"; payload = Array.isArray(p) ? p : [p]; conflict = String(o?.onConflict || "id").split(","); return q; },
        update(p) { op = "update"; payload = p; return q; },
        delete() { op = "delete"; return q; },
        then(resolve, reject) {
          const match = (r) => filters.every((f) => f(r));
          let data = null;
          if (op === "upsert") {
            const out = payload.map((p) => {
              const at = rows.findIndex((r) => conflict.every((c) => String(r[c]) === String(p[c])));
              const row = { ...(at >= 0 ? rows[at] : { id: nextId++ }), ...JSON.parse(JSON.stringify(p)) };
              if (at >= 0) rows[at] = row; else rows.push(row);
              return row;
            });
            data = one ? out[0] : out;
          } else if (op === "update") rows.filter(match).forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload))));
          else if (op === "delete") { const keep = rows.filter((r) => !match(r)); rows.splice(0, rows.length, ...keep); }
          else { const hit = rows.filter(match); data = one ? hit[0] || null : hit; }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const unitVector = (n) => Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));
function indexStandIns(db, embedded) {
  stub("user-store", { supabase: db, UserStore: { load: async () => ({}) } });
  stub("lib/db", { supabase: db });
  stub("lib/idle", { during: (fn) => fn(), touch() {}, isIdle: () => true, oneAtATime: (fn) => fn(), LOOK_MS: 5 });
  stub("lib/model-jobs", { withSettings: (u, fn) => fn(), role: () => null, complete: async () => null });
  stub("lib/local-models", { localEmbed: async (texts) => { embedded.push(...texts); return texts.map(() => unitVector(0)); } });
  for (const m of ["lib/item-files", "lib/services/usi"]) delete require.cache[require.resolve(path.join("..", m))];
  return require("../lib/services/usi");
}
const restore = () => { for (const m of ["lib/model-jobs", "lib/local-models", "lib/idle", "lib/services/usi"]) delete require.cache[require.resolve(path.join("..", m))]; };

test("a connection's pictures, video frames and sound are pieces of their item with the vectors kept for them, as File Search's are", async () => {
  const db = fakeIndex(), embedded = [];
  const usi = indexStandIns(db, embedded);
  try {
    const item = { external_id: "mail-7", head: "Email: Photos from the street", text: "Photos from the street. A few from the walk.",
      files: [{ name: "Shopfront.jpg", text: "LARKSPUR BAKERY open 7 till 3", media: [{ modality: "image", vector: [0.6, 0.8], label: "(picture) LARKSPUR BAKERY open 7 till 3" }] }] };
    await usi.indexItems("u1", "gmail", "email", [item], { scoped: true });
    const pieces = db.tables.data_vectors.filter((r) => r.piece_of);
    const picture = pieces.find((r) => r.source_metadata.modality);
    assert.equal(picture.content, "[File Shopfront.jpg] (picture) LARKSPUR BAKERY open 7 till 3");
    assert.equal(picture.source_metadata.modality, "image");
    const v = JSON.parse(picture.embedding);
    assert.deepEqual([v.length, v[0], v[1], v[2]], [1536, 0.6, 0.8, 0], "its kept vector, at the index's length");
    assert.equal(embedded.length, 2, "only the item's first piece and the file's words are embedded, never the picture again");
    assert.ok(embedded.every((t) => !/\(picture\)/.test(t)));
    // An item without vectors keeps the hash it had before they were kept.
    const crypto = require("crypto");
    const plain = { ...item, external_id: "mail-8", files: [{ name: "Plan.pdf", text: "The plan" }] };
    await usi.indexItems("u1", "gmail", "email", [plain], { scoped: true });
    assert.equal(plain._content_hash, crypto.createHash("sha256").update(plain.text + JSON.stringify([["Plan.pdf", 8]])).digest("hex"));
  } finally { restore(); }
});

test("search finds a connection's picture by what it shows only over File Search's line, and marks it for the reranker", async () => {
  const { MEDIA_MATCH } = require("../lib/services/doc-search");
  const piece = (item, n, content, similarity, meta = {}) => ({ service: "gmail", item_type: "email", external_id: `${item}#${n}`, content, similarity,
    enrichment_level: "basic", source_metadata: { _piece_of: item, _piece: n, ...meta } });
  const db = fakeIndex([
    piece("mail-1", 2, "[File Zebra.jpg] (picture) An animal in a field.", MEDIA_MATCH + 0.04, { modality: "image" }),
    { service: "gmail", item_type: "email", external_id: "mail-3", content: "Zoo trip on Saturday", similarity: 0.5, enrichment_level: "basic", source_metadata: {} },
    piece("mail-2", 3, "[File Owl.jpg] (picture) A bird on a branch.", MEDIA_MATCH - 0.03, { modality: "image" }),
  ]);
  const usi = indexStandIns(db, []);
  try {
    const { results } = await usi.search("u1", "a zebra", { queryEmbedding: unitVector(0) });
    assert.deepEqual(results.map((r) => [r.id, !!r._media]), [["mail-1", true], ["mail-3", false]], "the owl under the line is dropped");
  } finally { restore(); }
});

test("the reranker scores a picture or a sound that matched by what it is as clearly about the query, whatever it made of the label", async () => {
  const { RELEVANT } = require("../lib/services/doc-search");
  const rr = require("../webapp/reranker");
  rr.setLocalScorer(async (q, texts) => texts.map((t) => (/\(picture\)/.test(t) ? 0.0001 : 0.3)));
  const ranked = await rr.rerank("a zebra", [
    { content: "Zoo trip on Saturday" }, { content: "(picture) An animal in a field.", _media: true }, { content: "(picture) A logo." },
  ], 3);
  assert.deepEqual(ranked.map((r) => [r.content, r._rerank_score]),
    [["Zoo trip on Saturday", 0.3], ["(picture) An animal in a field.", RELEVANT], ["(picture) A logo.", 0.0001]]);
});
