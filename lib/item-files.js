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

const ctx = require("./context");

// What is not read: pictures small enough to be a logo or a tracking pixel,
// and anything past the size a mailbox allows an attachment.
const MAX_BYTES = 25 * 1024 * 1024;
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
    .filter((f) => f.key && f.size < MAX_BYTES && !(PICTURE.test(f.name) && f.size && f.size <= SMALL_PICTURE) && !(bulk && f.inline && PICTURE.test(f.name)));
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

// The words of a file's bytes: a document's text, a picture's words, what
// is said in sound or video. "" when it holds none.
async function readBytes(buffer, file, userId) {
  const kind = file.kind || (/^audio\//.test(file.mime) ? "audio" : /^video\//.test(file.mime) ? "video" : null);
  // A voice note is written out as one sent to Closedhand is (lib/voice.js);
  // a video's words are heard as File Search hears them (lib/video.js).
  if (kind === "audio") return String(await require("./voice").transcribeAudio(buffer, { userId }) || "");
  if (kind === "video") {
    const heard = await require("./video").hearMedia({ userId, buffer, name: file.name, video: true });
    return (heard?.said?.lines || []).map((l) => l.text).filter(Boolean).join(" ");
  }
  return (await require("./services/usi").extractAttachmentText(buffer, file.name, { maxChars: Infinity })) || "";
}

// Reads the unread files of these rows and keeps what it read on each row.
// Returns the rows, each with its file_texts as now kept. Fetching needs the
// person's connections, so it runs in their context, with their store.
async function readFor(userId, rows) {
  const due = (rows || []).filter((r) => unread(r).length);
  if (!due.length) return rows;
  const { UserStore } = require("../user-store");
  const store = await UserStore.load(userId).catch(() => null);
  if (!store) return rows;
  const { supabase } = require("./db");
  await ctx.runWithInheritedContext(async () => {
    require("./storage").swapToCloudStore(store, userId);
    const { attachmentBytes } = require("./services/data-access");
    for (const row of due) {
      const kept = Array.isArray(row.data.file_texts) ? [...row.data.file_texts] : [];
      for (const f of unread(row)) {
        const before = kept.find((t) => t.key === f.key);
        let entry;
        try {
          const got = await attachmentBytes(userId, { source: row.source, message_id: row.data.id || row.external_id, attachment_id: f.key, filename: f.name });
          if (got.error) throw Object.assign(new Error(got.error), { lasting: /^Unknown source|not yet implemented/.test(got.error) });
          const text = await readBytes(got.buffer, { ...f, name: got.filename || f.name, kind: f.kind || got.kind }, userId);
          entry = { key: f.key, name: f.name, text: require("./readable-text").readable(text).replace(/\s+/g, " ").trim() };
        } catch (e) {
          // A source with no way to fetch its files is not asked again. A
          // video waiting for the sandbox computer to be running keeps its
          // tries: it is read whenever the sandbox next is.
          const waiting = /sandbox computer, which isn't running/.test(e.message);
          entry = e.lasting ? { key: f.key, name: f.name, text: null, unreadable: true }
            : { key: f.key, name: f.name, text: null, tries: ((before && before.tries) || 0) + (waiting ? 0 : 1), tried: new Date().toISOString() };
          console.log(`[item-files] ${row.source} file not read yet: ${String(e.message).slice(0, 120)}`);
        }
        if (before) kept[kept.indexOf(before)] = entry; else kept.push(entry);
      }
      row.data = { ...row.data, file_texts: kept };
      const { error } = await supabase.from("data_cache").update({ data: row.data })
        .eq("user_id", userId).eq("source", row.source).eq("external_id", row.external_id);
      if (error) console.error(`[item-files] could not keep what was read: ${error.message}`);
    }
  });
  return rows;
}

// What an item's files said, for the index: name and whole text, read ones only.
function textsOf(data) {
  return (Array.isArray(data?.file_texts) ? data.file_texts : []).filter((t) => t && t.text).map((t) => ({ name: t.name, text: t.text }));
}

module.exports = { filesOf, unread, readBytes, readFor, textsOf, MAX_TRIES };
