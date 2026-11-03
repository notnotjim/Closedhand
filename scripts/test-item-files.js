// The files that come with anything connected are read by one step, for
// every source, current and future (lib/item-files.js): an email's
// attachments, an event's Drive files, a chat's photos, documents and voice
// notes, a connected app's own files. Invented data only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const files = require("../lib/item-files");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("every source's files are seen in one shape, of any size, logos left out", () => {
  const mail = { source: "gmail", external_id: "m1", data: { id: "m1", attachments: [
    { filename: "Invoice INV-2291.pdf", mimeType: "application/pdf", size: 52000, attachmentId: "a1" },
    { filename: "logo.png", mimeType: "image/png", size: 4000, attachmentId: "a2" },
    { filename: "huge.zip", size: 40 * 1024 * 1024, attachmentId: "a3" }] } };
  assert.deepEqual(files.filesOf(mail).map((f) => [f.key, f.name]), [["a1", "Invoice INV-2291.pdf"], ["a3", "huge.zip"]]);
  const event = { source: "gcal", external_id: "e1", data: { attachments: [{ name: "Agenda.pdf", url: "https://drive.example/file/1", fileId: "f9" }] } };
  assert.deepEqual(files.filesOf(event).map((f) => [f.key, f.name]), [["f9", "Agenda.pdf"]], "a Drive file by its file id");
  const chat = { source: "whatsapp", external_id: "wa-77", data: { id: "wa-77", file: { name: "voice note.ogg", kind: "audio", mime: "audio/ogg", size: 9000 } } };
  assert.deepEqual(files.filesOf(chat).map((f) => [f.key, f.kind]), [["wa-77", "audio"]], "a chat message's one file, by the message");
  // The shape any later source uses.
  const later = { source: "connected:notes", external_id: "n1", data: { files: [{ key: "doc-3", name: "Plan.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 30000 }] } };
  assert.deepEqual(files.filesOf(later).map((f) => f.key), ["doc-3"]);
  assert.deepEqual(files.filesOf({ data: { body: "no files" } }), []);
  // A picture set into bulk mail's body is decoration; one attached, or in
  // the person's own mail, is read.
  const banner = (labels, inline) => ({ source: "gmail", external_id: "m2", data: { labels, attachments: [{ filename: "hero.jpg", size: 90000, attachmentId: "b1", inline }] } });
  assert.equal(files.filesOf(banner(["INBOX", "CATEGORY_PROMOTIONS"], true)).length, 0);
  assert.equal(files.filesOf(banner(["INBOX", "CATEGORY_PROMOTIONS"], false)).length, 1);
  assert.equal(files.filesOf(banner(["INBOX", "CATEGORY_PERSONAL"], true)).length, 1);
});

test("a file is read once; one that could not be fetched is tried again, less often, then once a month", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const row = (kept) => ({ source: "gmail", external_id: "m1", data: { attachments: [{ filename: "a.pdf", size: 1000, attachmentId: "a1" }], file_texts: kept } });
  assert.equal(files.unread(row(undefined), now).length, 1, "never read");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: "" }]), now).length, 0, "read, and had no words");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, tries: 1, tried: "2026-11-02T11:00:00Z" }]), now).length, 0, "too soon to try again");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, tries: 1, tried: "2026-11-02T04:00:00Z" }]), now).length, 1, "due again");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, tries: 2, tried: "2026-11-02T04:00:00Z" }]), now).length, 0, "the second retry waits twice as long");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, tries: files.MAX_TRIES, tried: "2026-10-20T00:00:00Z" }]), now).length, 0, "after five tries, not before the month is up");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, tries: files.MAX_TRIES, tried: "2026-09-20T00:00:00Z" }]), now).length, 1, "and then again");
  assert.equal(files.unread(row([{ key: "a1", name: "a.pdf", text: null, unreadable: true }]), now).length, 0, "a source with no way to fetch it");
  assert.deepEqual(files.textsOf({ file_texts: [{ key: "a1", name: "a.pdf", text: "Total due £35.50" }, { key: "a2", name: "b.pdf", text: null }] }), [{ name: "a.pdf", text: "Total due £35.50" }]);
});

test("every connection goes through the one step, at the index's one entry", () => {
  const usi = read("lib/services/usi.js");
  assert.match(usi, /async function indexItems\(userId, service, itemType, items, opts = \{\}\) \{\n  if \(!items\?\.length \|\| !hasEmbedConfig\(\)\) return \{ indexed: 0 \};\n  await withRowFiles\(userId, items\);/, "any connection's items");
  assert.doesNotMatch(usi, /readFor\(userId, (rows|dedupedEmails|dedupedEvents)/, "no connection reads its files its own way");
  assert.equal((usi.match(/        rows: \[e\],/g) || []).length, 2, "an email and an event name their own row");
  assert.match(usi, /const fHead = \(`File: \$\{String\(file\.name\)\.slice\(0, 60\)\}\\n` \+ head\)\.slice\(0, 290\);/, "each piece of a file headed by its name and what it came with");
  assert.match(usi, /update\(item\.text \+ \(files\.length \? JSON\.stringify\(files\) : ""\)\)/, "a file read later indexes its item again");
  const wa = read("lib/services/wa-digest.js");
  assert.match(wa, /rows: b\.items\.filter\(\(m\) => m\.file\)\.map\(rowOf\),/, "a chat's day names its messages");
  assert.match(read("lib/services/usi-connector.js"), /\.\.\.\(files \? \{ rows: \[\{ source, external_id: id \}\] \} : \{\}\)/, "a connected app's record names its first passage");
  assert.match(read("lib/mail-attachments.js"), /await files\.readFor\(userId, \[row\]\);/, "the scanners read the same text");
  assert.match(read("lib/services/usi-connector.js"), /if \(require\("\.\.\/item-files"\)\.whenRead\(file\) === "idle"\) \{ files\.push\(file\); parts\.push\(`\[file: \$\{file\.name\}\]`\); \}/, "a connected app's recordings wait like everyone's");
  assert.doesNotMatch(read("lib/services/usi-connector.js"), /exceeds 200,000 characters/, "a long record is indexed whole");
  // Fetching is the attachment tool's own, by source; reading is one reader.
  const access = read("lib/services/data-access.js");
  assert.match(access, /async function attachmentBytes\(userId, params\) \{/);
  assert.match(access, /const got = await attachmentBytes\(userId, params\);/, "the tool and the index fetch alike");
  const itemFiles = read("lib/item-files.js");
  assert.match(itemFiles, /const said = await require\("\.\/voice"\)\.transcribeAudio\(input, \{ userId, here: true \}\)/, "indexing writes voice notes out on this computer");
  assert.match(itemFiles, /return \(await require\("\.\/services\/usi"\)\.extractAttachmentText\(bytes, file\.name, \{ maxChars: Infinity \}\)\) \|\| "";/, "whole");
  // Google and Microsoft hand back a file's bytes whole.
  for (const f of ["lib/services/google.js", "lib/services/microsoft.js"]) {
    assert.match(read(f), /resolve\(\{ raw: bytes, _binary: true \}\)/, f);
    assert.doesNotMatch(read(f), /raw: text\.substring\(0, 10000\)/, f);
  }
  const fts = read("migrations/086_fts_item_files.sql");
  assert.match(fts, /CASE WHEN jsonb_typeof\(d->'file_texts'\) = 'array' THEN d->'file_texts'/, "the word search reads every item's files");
  assert.match(fts, /1000000\),/, "and can never make saving an item fail");
  assert.doesNotMatch(read("lib/platforms/whatsapp-linked.js"), /INGEST_TEXT_CAP/, "a long WhatsApp message is kept whole");
});

// The file step with its fetching, reading and database stood in. `db` holds
// data_cache rows by "source/external_id".
function standIns({ fetch, extract = async (b) => b.toString(), voice, hear, canHear = async () => true, describe = async () => null }) {
  const stub = (rel, exports) => { const id = require.resolve(path.join("..", "lib", rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  const db = new Map();
  const writes = [];
  // Closedhand idle or busy, as the test says; one hearing at a time.
  const quiet = { now: true, hearing: 0, most: 0 };
  let turn = Promise.resolve();
  stub("idle", { during: (fn) => fn(), touch() {}, isIdle: () => quiet.now, LOOK_MS: 5,
    oneAtATime: (fn) => { const run = turn.then(async () => { quiet.hearing++; quiet.most = Math.max(quiet.most, quiet.hearing); try { return await fn(); } finally { quiet.hearing--; } }); turn = run.catch(() => {}); return run; } });
  stub("video", { hearMedia: hear || (async () => ({})), canHear, clock: (t) => Math.floor(t / 60) + ":" + String(Math.round(t % 60)).padStart(2, "0") });
  stub("../user-store", { UserStore: { load: async () => ({}) } });
  stub("storage", { swapToCloudStore: () => {} });
  stub("services/data-access", { attachmentBytes: fetch });
  stub("services/usi", { extractAttachmentText: extract, describeHere: describe });
  if (voice) stub("voice", { transcribeAudio: voice });
  const query = () => {
    const q = { where: {}, eq: (k, v) => { q.where[k] = v; return q; }, select: () => q,
      update: (v) => { q.set = v; return q; },
      maybeSingle: () => q,
      then: (r) => {
        const key = `${q.where.source}/${q.where.external_id}`;
        if (q.set) { writes.push(q.set); db.set(key, q.set.data); return r({ error: null }); }
        return r({ data: db.has(key) ? { data: db.get(key) } : null, error: null });
      } };
    return q;
  };
  stub("db", { supabase: { from: () => query() } });
  return { db, writes, quiet };
}
const settle = async (until) => { for (let i = 0; i < 300 && !until(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("two readers of one item at once (a sync running long, the sweep after it) fetch its files once", async () => {
  let fetches = 0;
  const { db, writes } = standIns({ fetch: async () => { fetches++; await new Promise((r) => setTimeout(r, 30)); return { buffer: Buffer.from("Total due £35.50"), filename: "INV-2291.pdf" }; } });
  const row = (id = "m-1") => ({ source: "gmail", external_id: id, data: { id, attachments: [{ filename: "INV-2291.pdf", size: 50000, attachmentId: "a0" }] } });
  db.set("gmail/m-1", row().data);
  const [a, b] = [row(), row()];
  await Promise.all([files.readFor("u-1", [a]), files.readFor("u-1", [b])]);
  assert.equal(fetches, 1, "the second waits for the first");
  assert.equal(writes.length, 1);
  assert.equal(b.data.file_texts[0].text, "Total due £35.50", "and gets what it read");
  await files.readFor("u-1", [row()]);
  assert.equal(fetches, 1, "a later reader of the same item finds it read");
  db.set("gmail/m-2", row("m-2").data);
  await files.readFor("u-1", [row("m-2")]);
  assert.equal(fetches, 2, "and another item is not held back");
});

test("a large file is read from disk by a reader of its own, after the rest, and its copy removed", async () => {
  const dl = require("../lib/download-file");
  const fetched = [];
  let onDisk = null;
  const { db } = standIns({
    fetch: async (userId, p) => {
      fetched.push(p.attachment_id);
      if (p.attachment_id !== "big") return { buffer: Buffer.from("Agenda: budget first"), filename: p.filename };
      onDisk = dl.tempPath(p.filename);
      fs.writeFileSync(onDisk, "Chapter 12. The lease runs to 2031.");
      return { path: onDisk, size: 400 * 1024 * 1024, filename: p.filename };
    },
  });
  const row = { source: "gmail", external_id: "m-9", data: { id: "m-9", attachments: [
    { filename: "Scanned lease.pdf", size: 400 * 1024 * 1024, attachmentId: "big" },
    { filename: "Agenda.txt", size: 2000, attachmentId: "small" }] } };
  db.set("gmail/m-9", JSON.parse(JSON.stringify(row.data)));
  await files.readFor("u-1", [row]);
  assert.deepEqual(row.data.file_texts.map((t) => t.key), ["small"], "the small one is read at once, the large one waits");
  for (let i = 0; i < 100 && (db.get("gmail/m-9").file_texts || []).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const kept = db.get("gmail/m-9").file_texts;
  assert.deepEqual(kept.map((t) => [t.key, t.text]), [["small", "Agenda: budget first"], ["big", "Chapter 12. The lease runs to 2031."]], "read, and what was read before kept");
  assert.deepEqual(fetched, ["small", "big"]);
  assert.equal(fs.existsSync(onDisk), false, "its copy on disk is removed");
  assert.equal(files.unread({ source: "gmail", external_id: "m-9", data: db.get("gmail/m-9") }).length, 0);
});

test("a large video waits, unfetched and keeping its tries, while nothing here can hear it", async () => {
  let fetches = 0;
  const { db } = standIns({ fetch: async () => { fetches++; return { buffer: Buffer.from("x") }; }, canHear: async () => false });
  const row = { source: "gcal", external_id: "e-4", data: { attachments: [{ title: "Ceremony full.mp4", mimeType: "video/mp4", fileId: "f-77" }] } };
  db.set("gcal/e-4", JSON.parse(JSON.stringify(row.data)));
  await files.readFor("u-1", [row]);
  for (let i = 0; i < 100 && !(db.get("gcal/e-4").file_texts || []).length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetches, 0, "a 600 MB download for nothing, every retry");
  assert.deepEqual(db.get("gcal/e-4").file_texts.map((t) => [t.key, t.text, t.tries]), [["f-77", null, 0]]);
});

test("a recording the voice note reader cannot open (an MP3) is heard as File Search hears it; a file on disk too", async () => {
  const heard = [];
  standIns({
    fetch: async () => ({}),
    voice: async () => { throw new Error("This kind of voice note can't be written out on this computer yet. Type the message instead."); },
    hear: async (a) => { heard.push([a.name, a.video, a.file ? "disk" : "bytes"]); return { said: { lines: [{ start: 0, text: "Welcome to the show." }] } }; },
  });
  const said = "What's said:\n[0:00] Welcome to the show.";
  assert.equal(await files.readBytes(Buffer.from("ID3 not really"), { name: "Episode 4.mp3", mime: "audio/mpeg" }, "u-1"), said, "with its times, as File Search writes it");
  const dl = require("../lib/download-file");
  const onDisk = dl.tempPath("Ceremony.mov");
  fs.writeFileSync(onDisk, Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  "), Buffer.alloc(32)]));
  assert.equal(await files.readBytes({ path: onDisk }, { name: "Ceremony.mov", mime: "" }, "u-1"), said, "known to be a video by its own bytes");
  dl.removeTemp(onDisk);
  assert.deepEqual(heard, [["Episode 4.mp3", false, "bytes"], ["Ceremony.mov", true, "disk"]]);
});

test("a video from a connection gets what File Search's do: what's said with its times, and six moments on screen described by the VLM with their words", async () => {
  const asked = [], described = [];
  standIns({
    fetch: async () => ({}),
    hear: async (a) => { asked.push([a.name, a.video, a.frames]); return { said: { lines: [{ start: 0, text: "Welcome, everyone." }, { start: 75, text: "Cut the ribbon." }] }, frames: [{ time: 12, jpeg: Buffer.from("frame one") }, { time: 80, jpeg: Buffer.from("frame two") }] }; },
    describe: async (images, opts) => { described.push([Buffer.from(images[0].base64, "base64").toString(), opts.background]); return described.length === 1 ? "A stage with a red ribbon across it." : "People clapping beside a cut ribbon."; },
  });
  const reader = require("../lib/file-reader");
  const realOcr = reader.ocrImage;
  reader.ocrImage = async (jpeg) => (String(jpeg) === "frame one" ? "GRAND OPENING" : null);
  try {
    assert.equal(await files.readBytes(Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  "), Buffer.alloc(32)]), { name: "Opening.mov", mime: "video/quicktime" }, "u-1"),
      "What's said:\n[0:00] Welcome, everyone.\n[1:15] Cut the ribbon.\n\nWhat's on screen:\n[0:12] (on screen) A stage with a red ribbon across it.\nWords on screen: GRAND OPENING\n[1:20] (on screen) People clapping beside a cut ribbon.");
  } finally { reader.ocrImage = realOcr; }
  assert.deepEqual(asked, [["Opening.mov", true, 6]], "six frames, as File Search takes");
  assert.deepEqual(described, [["frame one", true], ["frame two", true]], "each described in the background");
});

test("recordings and videos wait while Closedhand is busy, then are heard newest first, one at a time; a large document does not wait", async () => {
  const order = [];
  const { db, quiet } = standIns({
    fetch: async (userId, p) => { order.push(p.attachment_id); return { buffer: Buffer.from(p.attachment_id === "scan" ? "Lease to 2031" : "x"), filename: p.filename }; },
    hear: async (a) => { await new Promise((r) => setTimeout(r, 20)); return { said: { lines: [{ start: 0, text: `said in ${a.name}` }] } }; },
  });
  quiet.now = false;
  const mail = (id, date, att) => ({ source: "outlook", external_id: id, data: { id, date, attachments: [att] } });
  const rows = [
    mail("o-1", "2026-03-02T10:00:00Z", { filename: "Board call.m4a", mimeType: "audio/mp4", size: 40 * 1024 * 1024, attachmentId: "older" }),
    mail("o-2", "2026-10-30T10:00:00Z", { filename: "Site walk.mov", mimeType: "video/quicktime", size: 140 * 1024 * 1024, attachmentId: "newer" }),
    mail("o-3", "2026-06-01T10:00:00Z", { filename: "Scanned lease.pdf", mimeType: "application/pdf", size: 60 * 1024 * 1024, attachmentId: "scan" }),
  ];
  for (const r of rows) db.set(`outlook/${r.external_id}`, JSON.parse(JSON.stringify(r.data)));
  await files.readFor("u-1", rows);
  await settle(() => order.includes("scan"));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ["scan"], "the document is read; nothing is heard while Closedhand is busy");
  quiet.now = true;
  await settle(() => order.length === 3 && (db.get("outlook/o-1").file_texts || []).length);
  assert.deepEqual(order, ["scan", "newer", "older"], "newest first");
  assert.equal(quiet.most, 1, "one hearing at a time");
  assert.equal(db.get("outlook/o-2").file_texts[0].text, "What's said: [0:00] said in Site walk.mov");
});
