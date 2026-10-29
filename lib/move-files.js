// The bot's own files from a Closedhand that moved here (webapp/move.js), such
// as its WhatsApp session, so WhatsApp stays linked. They arrive in the
// database, the one place the dashboard and the bot share on every host, and
// the bot writes them into its storage folder just before it restarts.
const fs = require("fs");
const path = require("path");

const BUCKET = "_moved-bot-files"; // as webapp/move.js names it

// Where the bot keeps its files: the same folder whatsapp-linked.js uses.
function base() {
  return path.resolve(process.env.STORAGE_DIR || path.resolve(__dirname, "../storage"));
}

async function restore(pool = require("./db").supabase._pool) {
  if (!pool) return 0;
  const { rows } = await pool.query("SELECT key, data FROM storage_objects WHERE bucket = $1", [BUCKET]);
  const root = base();
  for (const { key, data } of rows) {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) continue; // never outside the folder
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  if (rows.length) {
    await pool.query("DELETE FROM storage_objects WHERE bucket = $1", [BUCKET]);
    console.log(`[move] wrote ${rows.length} file(s) that came with the move`);
  }
  return rows.length;
}

// The other way: moving away from a host where the bot's folder is its own
// (Railway), its files go into the database first, where the move takes them
// with everything else, and the new computer's bot writes them out (restore).
const FOLDERS = ["wa-linked-session"]; // as webapp/move.js BOT_FOLDERS
function filesUnder(dir, prefix, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name), key = `${prefix}/${e.name}`;
    if (e.isDirectory()) filesUnder(full, key, out);
    else if (e.isFile()) out.push({ key, full });
  }
  return out;
}
async function stash(pool = require("./db").supabase._pool) {
  if (!pool) return 0;
  const root = base();
  const files = FOLDERS.flatMap((folder) => filesUnder(path.join(root, folder), folder, []));
  await pool.query("DELETE FROM storage_objects WHERE bucket = $1", [BUCKET]);
  for (const { key, full } of files) {
    await pool.query("INSERT INTO storage_objects (bucket, key, data) VALUES ($1, $2, $3)", [BUCKET, key, fs.readFileSync(full)]);
  }
  if (files.length) console.log(`[move] put ${files.length} of the bot's own file(s) where the move takes them`);
  return files.length;
}

module.exports = { restore, stash, BUCKET };
