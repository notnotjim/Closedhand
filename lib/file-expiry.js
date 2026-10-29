// lib/file-expiry.js: the copies Closedhand keeps of files, deleted on time.
//
// A file the person sends Closedhand is kept so it can read it again, and is
// deleted 90 days after Closedhand last used it: the stored copy, its record
// and the copy on this computer's disk. Its description stays in the
// conversation, so Closedhand still knows what it was. A working copy (a file
// fetched from the person's mail, Drive or a chat, or one too big to push
// through the web chat) is kept a day: the original stays where it came from
// and can be fetched again. A file a project holds (added on the dashboard or
// sent with its emoji) is kept for as long as the project is. A copy on disk
// whose record is gone (deleted on the dashboard) goes on the next pass.

const fs = require("fs");
const path = require("path");

const SENT_KEPT_MS = 90 * 86400000;
const WORKING_COPY_MS = 86400000;
const EVERY_MS = 6 * 3600000;

async function deleteOldFiles(db = require("./db").supabase, now = Date.now(), dir = require("./attachments").ATTACHMENTS_DIR) {
  const cols = "user_id, attachment_id, storage_path";
  const sent = await db.from("attachments").select(cols).eq("direction", "in").lt("last_used_at", new Date(now - SENT_KEPT_MS).toISOString());
  const working = await db.from("attachments").select(cols).neq("direction", "in").lt("created_at", new Date(now - WORKING_COPY_MS).toISOString());
  if (sent.error || working.error) throw sent.error || working.error;
  const { data: projects, error: projErr } = await db.from("projects").select("context");
  if (projErr) throw projErr;
  const held = new Set((projects || []).flatMap((p) => (Array.isArray(p.context) ? p.context : []).filter((c) => c && c.kind === "file").map((c) => c.id)));
  const old = [...(sent.data || []), ...(working.data || [])].filter((r) => !held.has(r.attachment_id));
  if (old.length) {
    const paths = old.map((r) => r.storage_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) await db.storage.from("attachments").remove(paths.slice(i, i + 100));
    const ids = old.map((r) => r.attachment_id);
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await db.from("attachments").delete().in("attachment_id", ids.slice(i, i + 100));
      if (error) throw error;
    }
    console.log(`[files] deleted ${old.length} kept file(s) past their time`);
  }
  // The copies on this computer's disk that no record names any more.
  const { data: kept, error } = await db.from("attachments").select("attachment_id");
  if (error) throw error;
  const live = new Set((kept || []).map((r) => r.attachment_id));
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { /* no folder yet */ }
  for (const name of names) {
    if (live.has(name.replace(/\.[^.]*$/, ""))) continue;
    const file = path.join(dir, name);
    try {
      // A file just sent is on disk a moment before its record is written.
      if (now - fs.statSync(file).mtimeMs > 3600000) fs.unlinkSync(file);
    } catch (_) { /* next pass */ }
  }
  return old.length;
}

function start() {
  const run = () => deleteOldFiles().catch((e) => console.error("[files] old files not deleted:", e.message));
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, EVERY_MS).unref?.();
}

module.exports = { deleteOldFiles, start, SENT_KEPT_MS, WORKING_COPY_MS };
