// lib/item-files.js: the files that come with anything connected, read whole.
//
// An email has attachments, a calendar event its Drive files, a chat message
// a photo, a document or a voice note, and a connected app may hand over a
// file of its own. Every source keeps the files that come with an item on
// the item's cached row (data_cache), and this one step reads each of them
// once, whole, on the computer running Closedhand: a document by its text, a
// picture by any words in it (and a description, where the person chose an
// image model), sound and video by what is said. What it read is kept on the
// row as file_texts, which the index (lib/services/usi.js) cuts into pieces of
// the item and the word search reads (migration 086).
//
// A source added later needs only two things. Its cached rows say what files
// an item has, in `files` ([{ key, name, mime, size }]) or in the shapes the
// first sources used (`attachments` on mail and events, `file` on a chat
// message); and lib/services/data-access.js attachmentBytes can fetch a file
// by its source, the item's id and the file's key. Everything after that,
// reading, indexing and search, is this one step. A connected app whose files
// arrive as bytes (an MCP server's resources) reads them with readBytes.
//
// Any size is read, at one of three times. A document up to BIG is read at
// once, with its item. A larger one (a scanned book) is fetched to disk as it
// arrives (lib/download-file.js) and read soon after, one at a time. A
// recording or a video waits until Closedhand is otherwise idle (lib/idle.js)
// and is heard then, newest first, one at a time: a two-hour video takes
// about half an hour, and nobody is waiting on it. Until then the item is
// found by its own words and the file's name.

const fs = require("fs");
const ctx = require("./context");

// A document larger than this, or one whose source does not say its size (a
// calendar event's Drive file), is read soon after its item, not with it.
const BIG = 25 * 1024 * 1024;
// What is not read: pictures small enough to be a logo or a tracking pixel.
const PICTURE = /\.(jpe?g|png|gif|webp|tiff?|bmp|heic|heif)$/i;
const SMALL_PICTURE = 30 * 1024;
// A file that could not be fetched is tried again, less often each time, and
// after this many tries once a month: a file deleted at its source stops
// costing calls, and one that comes back (an account connected again, a file
// shared again) is still read. The model can always open a file live when a
// question needs it.
const MAX_TRIES = 5;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

// The files an item's cached row says it has, in one shape. A picture set
// into the body of bulk mail (a newsletter's banner, a shop's product shots)
// is its decoration, not something sent: on one mailbox it was 4,329
// pictures against 610 real attachments, each taking seconds to read.
function filesOf(row) {
  const d = (row && row.data) || {};
  const bulk = !!d.bulk || (Array.isArray(d.labels) && d.labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l)));
  const list = Array.isArray(d.files) ? d.files
    : d.file ? [{ key: row.external_id, ...d.file }]
    : Array.isArray(d.attachments) ? d.attachments.map((a) => ({
      key: a.attachmentId || a.attachment_id || a.fileId || a.id,
      name: a.filename || a.name || a.title || "",
      mime: a.mimeType || a.mime || "",
      size: a.size || 0,
      inline: !!(a.inline || a.isInline),
    }))
    : [];
  return list.map((f) => ({ key: f.key == null ? "" : String(f.key), name: String(f.name || "file"), mime: String(f.mime || ""), size: Number(f.size) || 0, kind: f.kind || null, inline: !!f.inline }))
    .filter((f) => f.key && !(PICTURE.test(f.name) && f.size && f.size <= SMALL_PICTURE) && !(bulk && f.inline && PICTURE.test(f.name)));
}

// The files of a row not read yet, or due another try.
function unread(row, now = Date.now()) {
  const kept = Array.isArray(row?.data?.file_texts) ? row.data.file_texts : [];
  return filesOf(row).filter((f) => {
    const k = kept.find((t) => t.key === f.key);
    if (!k) return true;
    if (k.text != null || k.unreadable) return false;
    const since = now - Date.parse(k.tried || 0);
    return (k.tries || 0) < MAX_TRIES ? since > RETRY_AFTER_MS * (k.tries || 1) : since > MONTHLY_MS;
  });
}

const MEDIA = /^(audio|video)\/|\.(mp4|mov|m4v|webm|mkv|avi|3gp|mpe?g|mp3|m4a|aac|wav|ogg|opus|flac|aiff?|caf|amr)$/i;
// When a file is read: "now" with its item, "soon" after it, or "idle".
const whenRead = (f) => (f.kind === "audio" || f.kind === "video" || MEDIA.test(f.mime) || MEDIA.test(f.name) ? "idle"
  : !f.size || f.size > BIG ? "soon" : "now");
// An item's own date, for hearing the newest first.
const dateOf = (d = {}) => Date.parse(d.date || d.start?.dateTime || d.start?.date || d.start || d.received_at || 0) || 0;

// The first bytes of a file on disk, enough to tell what it is.
function firstBytes(file) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(4096); return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)); }
  finally { fs.closeSync(fd); }
}

// The words of a file: a document's text, a picture's words, what is said in
// sound or video. "" when it holds none. `input` is the file's bytes, or
// { path } for one on disk, of any size: sound and video are heard from it a
// piece at a time.
async function readBytes(input, file, userId) {
  const onDisk = !Buffer.isBuffer(input) && input && input.path;
  const kind = file.kind || (/^audio\//.test(file.mime) ? "audio" : /^video\//.test(file.mime) ? "video"
    : require("./file-reader").kindOf(onDisk ? firstBytes(onDisk) : input, file.name));
  if (kind === "audio" || kind === "video") {
    // A voice note is written out as one sent to Closedhand is (lib/voice.js),
    // which reads Ogg and WAV, as does a connected speech service; any other
    // recording, and a video, is heard as File Search hears it (lib/video.js).
    if (kind === "audio" && !onDisk) {
      const said = await require("./voice").transcribeAudio(input, { userId })
        .catch((e) => { if (/can't be written out/.test(e.message)) return null; throw e; });
      if (said != null) return String(said);
    }
    const heard = await require("./video").hearMedia({ userId, ...(onDisk ? { file: onDisk } : { buffer: input }), name: file.name, video: kind === "video" });
    return (heard?.said?.lines || []).map((l) => l.text).filter(Boolean).join(" ");
  }
  const bytes = onDisk ? fs.readFileSync(onDisk) : input;
  return (await require("./services/usi").extractAttachmentText(bytes, file.name, { maxChars: Infinity })) || "";
}

// Rows whose files are being read now, so a second caller (a sync still
// running past its time while the sweep after it starts) waits for that read
// instead of fetching the same files again.
const reading = new Map();

// The person's context and store, which fetching their files needs. False
// when they have none.
async function asPerson(userId, fn) {
  const { UserStore } = require("../user-store");
  const store = await UserStore.load(userId).catch(() => null);
  if (!store) return false;
  await ctx.runWithInheritedContext(async () => {
    require("./storage").swapToCloudStore(store, userId);
    await fn();
  });
  return true;
}

// Reads the unread files of these rows that are read with their item, and
// keeps what it read on each row. Returns the rows, each with its file_texts
// as now kept. The rest wait (below); the item is indexed again once they are
// read, as anything whose words changed is.
async function readFor(userId, rows) {
  const due = (rows || []).filter((r) => unread(r).length);
  if (!due.length) return rows;
  const now = due.filter((r) => unread(r).some((f) => whenRead(f) === "now"));
  if (now.length) await require("./idle").during(() => asPerson(userId, async () => { for (const row of now) await readOnce(userId, row, "now"); }));
  for (const row of due) {
    const later = new Set(unread(row).map(whenRead));
    if (later.has("soon") || later.has("idle")) wait(userId, row, later);
  }
  return rows;
}

// One reader at a time for a row: a second waits for the first and then reads
// only what is still unread.
async function readOnce(userId, row, when) {
  const key = `${userId}\n${row.source}\n${row.external_id}`;
  while (reading.has(key)) row.data = await reading.get(key);
  let done;
  reading.set(key, new Promise((r) => { done = r; }));
  try { await readRow(userId, row, when); } finally { reading.delete(key); done(row.data); }
}

// Items with files read later. A large document is read as soon as the one
// before it is; recordings and videos only while Closedhand is otherwise
// idle, the newest first, one hearing at a time across Closedhand (File
// Search's too). A restart loses the list; the next pass over the item (a
// sync, the sweep, the WhatsApp digest) finds the file still unread and puts
// it back.
const waiting = new Map();
let working = false;
function wait(userId, row, when) {
  const key = `${userId}\n${row.source}\n${row.external_id}`;
  const had = waiting.get(key);
  waiting.set(key, { userId, source: row.source, external_id: row.external_id, at: dateOf(row.data),
    soon: when.has("soon") || !!had?.soon, idle: when.has("idle") || !!had?.idle });
  if (!working) work().catch((e) => console.error(`[item-files] files read later: ${e.message}`));
}
async function work() {
  working = true;
  const idle = require("./idle");
  try {
    while (waiting.size) {
      const all = [...waiting.entries()];
      const soon = all.find(([, w]) => w.soon);
      if (soon) {
        const [key, w] = soon;
        w.soon = false;
        if (!w.idle) waiting.delete(key);
        await asPerson(w.userId, () => readOnce(w.userId, { source: w.source, external_id: w.external_id, data: {} }, "soon"));
        continue;
      }
      if (!idle.isIdle()) { await new Promise((r) => { const t = setTimeout(r, idle.LOOK_MS); if (t.unref) t.unref(); }); continue; }
      const [key, w] = all.sort(([, a], [, b]) => b.at - a.at)[0];
      waiting.delete(key);
      await idle.oneAtATime(() => asPerson(w.userId, () => readOnce(w.userId, { source: w.source, external_id: w.external_id, data: {} }, "idle")));
    }
  } finally { working = false; }
}

// One row's unread files read at one time ("now", "soon", "idle"), read and
// kept on it. The row is read as it is now first, so what another reader kept
// since is not written over.
async function readRow(userId, row, when) {
  const { supabase } = require("./db");
  const { data: now } = await supabase.from("data_cache").select("data")
    .eq("user_id", userId).eq("source", row.source).eq("external_id", row.external_id).maybeSingle();
  if (now && now.data) row.data = { ...now.data, ...row.data, file_texts: now.data.file_texts };
  const todo = unread(row).filter((f) => whenRead(f) === when);
  if (!todo.length) return;
  const { attachmentBytes } = require("./services/data-access");
  const { removeTemp } = require("./download-file");
  const kept = Array.isArray(row.data.file_texts) ? [...row.data.file_texts] : [];
  for (const f of todo) {
    const before = kept.find((t) => t.key === f.key);
    let entry, got = {};
    try {
      // A recording or video is heard on the sandbox computer or a Mac: with
      // neither now, it is not fetched for nothing, and waits.
      if (when === "idle" && !(await require("./video").canHear(userId))) {
        throw new Error("Closedhand hears recordings and videos with its sandbox computer, which isn't running.");
      }
      got = await attachmentBytes(userId, { source: row.source, message_id: row.data.id || row.external_id, attachment_id: f.key, filename: f.name });
      if (got.error) throw Object.assign(new Error(got.error), { lasting: /^Unknown source/.test(got.error) });
      const text = await readBytes(got.path ? { path: got.path } : got.buffer, { ...f, name: got.filename || f.name, kind: f.kind || got.kind }, userId);
      entry = { key: f.key, name: f.name, text: require("./readable-text").readable(text).replace(/\s+/g, " ").trim() };
    } catch (e) {
      // A source with no way to fetch its files is not asked again. A video
      // waiting for the sandbox computer to be running keeps its tries: it is
      // read whenever the sandbox next is.
      const waiting = /sandbox computer, which isn't running/.test(e.message);
      entry = e.lasting ? { key: f.key, name: f.name, text: null, unreadable: true }
        : { key: f.key, name: f.name, text: null, tries: ((before && before.tries) || 0) + (waiting ? 0 : 1), tried: new Date().toISOString() };
      console.log(`[item-files] ${row.source} file not read yet: ${String(e.message).slice(0, 120)}`);
    } finally {
      removeTemp(got.path);
    }
    if (before) kept[kept.indexOf(before)] = entry; else kept.push(entry);
  }
  row.data = { ...row.data, file_texts: kept };
  const { error } = await supabase.from("data_cache").update({ data: row.data })
    .eq("user_id", userId).eq("source", row.source).eq("external_id", row.external_id);
  if (error) console.error(`[item-files] could not keep what was read: ${error.message}`);
}

// What an item's files said, for the index: name and whole text, read ones only.
function textsOf(data) {
  return (Array.isArray(data?.file_texts) ? data.file_texts : []).filter((t) => t && t.text).map((t) => ({ name: t.name, text: t.text }));
}

module.exports = { filesOf, unread, whenRead, readBytes, readFor, textsOf, MAX_TRIES, BIG };
