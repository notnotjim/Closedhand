// lib/page-expiry.js: a page leaves the Pages list for Archived a week after
// it was last used (opened, downloaded, read or sent; webapp/server.js) and
// is deleted three months after that. A page is a
// laid-out copy of an answer, which stays in the chat it was given in. A
// project's own page is part of the project, not one of these, and an
// archived project is kept until the person deletes it. A table's page
// (lib/table-pages.js) is the table, kept for as long as the table is.

const ARCHIVED_AFTER_MS = 7 * 86400000;
const KEPT_ARCHIVED_MS = 90 * 86400000;
const EVERY_MS = 6 * 3600000;

async function deleteOldPages(db = require("./db").supabase, now = Date.now()) {
  const before = new Date(now - ARCHIVED_AFTER_MS - KEPT_ARCHIVED_MS).toISOString();
  const { data, error } = await db.from("reports").delete().lt("last_opened_at", before).is("dataset_id", null).select("id, user_id, content");
  if (error) throw error;
  // The pictures and other pieces each page held go with it (lib/page-media.js).
  const media = require("./page-media");
  const keys = (data || []).flatMap((p) => media.namedParts(p.content).map((name) => media.partKey(p.user_id, p.id, name)));
  for (let i = 0; i < keys.length; i += 100) await db.storage.from("attachments").remove(keys.slice(i, i + 100)).catch(() => {});
  if (data?.length) console.log(`[pages] deleted ${data.length} page(s) archived over three months ago`);
  return data?.length || 0;
}

function start() {
  const run = () => deleteOldPages().catch((e) => console.error("[pages] old pages not deleted:", e.message));
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, EVERY_MS).unref?.();
}

module.exports = { deleteOldPages, start, ARCHIVED_AFTER_MS, KEPT_ARCHIVED_MS };
