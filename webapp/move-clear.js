// What a Closedhand that has moved leaves on the computer it left: nothing.
// A move is a move, not a copy. Once the new Closedhand answers at its
// address, running, everything here goes: every table emptied (their shapes
// stay, with the record of database updates), every file in the storage
// folder but the move marker, the sandbox computer's files and browser
// sign-ins, and the bot's own folder where it keeps one (Railway). Until the
// new one answers, nothing is touched, so a move that went wrong after the
// handover still has everything here. Started by moved-server.js, again on
// every start until it is done, so a restart halfway finishes the job.
const fs = require("fs");
const path = require("path");

const KEEP_TABLES = new Set(["schema_migrations"]);
const RETRY_MS = 5 * 60 * 1000;

// The new Closedhand, running: its dashboard answers at the address the move
// went to, and is not itself a moved one.
async function newOneRuns(state, fetchFn = fetch) {
  const base = state.url || state.to;
  let u;
  try { u = new URL("/health", base); } catch (_) { return false; }
  try {
    const r = await fetchFn(u.href, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    return !!body && body.status === "ok" && !body.move;
  } catch (_) { return false; }
}

async function emptyTables(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  const tables = rows.map((r) => r.name).filter((t) => !KEEP_TABLES.has(t));
  if (!tables.length) return 0;
  await pool.query("TRUNCATE " + tables.map((t) => "public." + '"' + t.replace(/"/g, '""') + '"').join(", ") + " CASCADE");
  return tables.length;
}

// Everything in a storage folder but the marker that says where it went.
function emptyFolder(dir, keep) {
  if (!dir) return 0;
  let gone = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const name of names) {
    if (name === keep) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    gone++;
  }
  return gone;
}

// The sandbox computer: its browser first, so it writes no more to the
// profile, then its whole workspace. Its supervisor starts a fresh browser.
const SANDBOX_CLEAR = "pkill -f -9 chrom || true; find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +; echo cleared";

async function clearAll(deps) {
  const done = {};
  done.tables = await emptyTables(deps.pool);
  done.files = emptyFolder(deps.storageDir, deps.markerName);
  if (deps.clearSandbox) done.sandbox = await deps.clearSandbox(SANDBOX_CLEAR).then(() => true, (e) => { console.error("[move] the sandbox computer's files:", e.message); return false; });
  if (deps.clearBot) done.bot = await deps.clearBot().then(() => true, (e) => { console.error("[move] the bot's folder:", e.message); return false; });
  return done;
}

// Waits for the new Closedhand to run, then clears, once.
function whenMoved(state, deps) {
  if (!state || state.state !== "moved" || state.cleared) return null;
  let timer = null;
  const attempt = async () => {
    try {
      if (!(await newOneRuns(state, deps.fetch))) {
        console.log("[move] the new Closedhand doesn't answer yet; this computer keeps everything until it does");
        timer = setTimeout(attempt, deps.retryMs || RETRY_MS);
        return;
      }
      const done = await clearAll(deps);
      deps.marker.write({ ...state, cleared: new Date().toISOString() });
      console.log(`[move] the new Closedhand runs; cleared this computer (${done.tables} tables, ${done.files} files${done.sandbox === false ? ", sandbox computer not reached" : ""})`);
      if (deps.onCleared) deps.onCleared();
    } catch (e) {
      console.error("[move] clearing this computer:", e.message);
      timer = setTimeout(attempt, deps.retryMs || RETRY_MS);
    }
  };
  attempt();
  return { stop: () => clearTimeout(timer) };
}

// What the moved page says is left where it was: nothing, once the new one
// runs. On Railway the old one is a project that costs money while it stays.
function leftWords(state, railway) {
  if (!state.cleared) return railway ? "Everything it kept on Railway is cleared as soon as it runs there. Then delete the project on Railway so it stops charging you."
    : "Everything it kept on this computer is cleared as soon as it runs there.";
  return railway ? "Nothing of it is left on Railway. Delete the project there so Railway stops charging you."
    : "Nothing of it is left on this computer.";
}

module.exports = { whenMoved, newOneRuns, emptyTables, emptyFolder, clearAll, leftWords, SANDBOX_CLEAR };
