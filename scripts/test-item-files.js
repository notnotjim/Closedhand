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

test("every source's files are seen in one shape, logos and oversized files left out", () => {
  const mail = { source: "gmail", external_id: "m1", data: { id: "m1", attachments: [
    { filename: "Invoice INV-2291.pdf", mimeType: "application/pdf", size: 52000, attachmentId: "a1" },
    { filename: "logo.png", mimeType: "image/png", size: 4000, attachmentId: "a2" },
    { filename: "huge.zip", size: 40 * 1024 * 1024, attachmentId: "a3" }] } };
  assert.deepEqual(files.filesOf(mail).map((f) => [f.key, f.name]), [["a1", "Invoice INV-2291.pdf"]]);
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

test("every source goes through the one step: mail, events, chats, the scanners and connected apps' files", () => {
  const usi = read("lib/services/usi.js");
  assert.match(usi, /rows = await require\("\.\.\/item-files"\)\.readFor\(userId, rows \|\| \[\]\);/, "rows synced from any source");
  assert.match(usi, /await require\("\.\.\/item-files"\)\.readFor\(userId, dedupedEmails\);/);
  assert.match(usi, /await require\("\.\.\/item-files"\)\.readFor\(userId, dedupedEvents\);/);
  assert.equal((usi.match(/files: require\("\.\.\/item-files"\)\.textsOf\(d\),/g) || []).length, 2, "an email's and an event's files go into its pieces");
  assert.match(usi, /const fHead = \(`File: \$\{String\(file\.name\)\.slice\(0, 60\)\}\\n` \+ head\)\.slice\(0, 290\);/, "each piece of a file headed by its name and what it came with");
  assert.match(usi, /update\(item\.text \+ \(files\.length \? JSON\.stringify\(files\) : ""\)\)/, "a file read later indexes its item again");
  const wa = read("lib/services/wa-digest.js");
  assert.match(wa, /const read = await files\.readFor\(userId, b\.items\.filter\(\(m\) => m\.file\)\.map\(rowOf\)\);/);
  assert.match(wa, /files: b\.items\.flatMap\(\(m\) => files\.textsOf\(m\)\),/);
  assert.match(read("lib/mail-attachments.js"), /await files\.readFor\(userId, \[row\]\);/, "the scanners read the same text");
  assert.match(read("lib/services/usi-connector.js"), /else if \(typeof c\.blob === "string"\) parts\.push\(await require\("\.\.\/item-files"\)\.readBytes\(Buffer\.from\(c\.blob, "base64"\)/, "a connected app's files");
  assert.doesNotMatch(read("lib/services/usi-connector.js"), /exceeds 200,000 characters/, "a long record is indexed whole");
  // Fetching is the attachment tool's own, by source; reading is one reader.
  const access = read("lib/services/data-access.js");
  assert.match(access, /async function attachmentBytes\(userId, params\) \{/);
  assert.match(access, /const got = await attachmentBytes\(userId, params\);/, "the tool and the index fetch alike");
  const itemFiles = read("lib/item-files.js");
  assert.match(itemFiles, /if \(kind === "audio"\) return String\(await require\("\.\/voice"\)\.transcribeAudio\(buffer, \{ userId \}\) \|\| ""\);/);
  assert.match(itemFiles, /return \(await require\("\.\/services\/usi"\)\.extractAttachmentText\(buffer, file\.name, \{ maxChars: Infinity \}\)\) \|\| "";/, "whole");
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
