// Moving a Closedhand to another computer, such as one on Railway that is on
// all the time. Everything it holds is one database and the files in its
// storage folder, so a move sends both, in parts, to a new Closedhand that
// isn't set up yet, which takes them in one transaction.
//
// The source (this side, started from Settings):
//   1. Says hello with the new Closedhand's setup code, which only the person's
//      account at the host shows, and checks both run the same release.
//   2. Marks itself as moving (move-marker.js): its bot restarts and sits
//      still, so nothing changes or gets answered twice from here on.
//   3. Sends every row and file, read in one snapshot, in parts.
//   4. Once the other side has taken it all, stops its personal URL tunnel,
//      marks itself moved and tells the other side to start. From then on
//      this computer shows only a page saying where Closedhand went.
// Anything that fails before step 4 undoes step 2, and Closedhand carries on
// here as before.
//
// The destination (a Closedhand with SETUP_CODE and no password yet) keeps the
// parts in a temporary folder, then empties its own tables and fills them in
// one transaction, so it either has everything or nothing.
//
// Stored secrets never travel under either computer's own key: the source
// opens each one and seals it again under a one-time key sent with the last
// call, and the destination seals it under its own.
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { decryptString, encryptString, sealWith, openWith, PREFIX } = require("./crypto-tokens");

// Not carried across: signed-in browsers (the new computer signs in for
// itself), the record of database updates (each keeps its own) and a Mac
// paired with Closedhand Bridge (Bridge reaches Closedhand on its own Mac,
// which stops running it; the new home pairs a Mac of its own).
const LEFT_BEHIND = new Set(["dashboard_sessions", "schema_migrations", "user_bridges"]);
// Settings about this computer rather than the person: how far its local
// models got downloading. The new computer downloads its own.
const SETTINGS_LEFT_BEHIND = ["LOCAL_MODELS_STATUS"];
// What the storage folder holds that moves: the person's files (the buckets
// the app keeps), and the bot's own WhatsApp session, so WhatsApp stays
// linked. Its local models and tool servers' scratch space stay behind.
const BUCKETS = ["attachments", "logos"];
const BOT_FOLDERS = ["wa-linked-session"];
// The bot's files wait in the database until the new bot writes them into its
// own storage folder, just before it restarts (lib/move-files.js).
const BOT_FILES_BUCKET = "_moved-bot-files";
const SEALED = new RegExp(PREFIX.replace(/[:]/g, "\\$&") + "[A-Za-z0-9+/]+=*", "g");
const ROWS_PER_FETCH = 500;
const ROWS_PER_INSERT = 200;
const PART_CHARS = 16 * 1024 * 1024; // before compression
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// The newest database update this computer has applied. Two Closedhands on
// the same release have the same one.
async function latestUpdate(pool) {
  const { rows } = await pool.query("SELECT max(filename) AS latest FROM schema_migrations");
  return rows[0].latest || null;
}

async function tablesToMove(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  return rows.map((r) => r.name).filter((t) => !LEFT_BEHIND.has(t));
}

// "https://name.up.railway.app" from whatever was pasted. Only https, apart
// from this computer's own names for trying a move locally.
function cleanAddress(value) {
  let text = String(value || "").trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = "https://" + text;
  let u;
  try { u = new URL(text); } catch (_) { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return u.origin;
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

// Every row of every table, then every stored file, one per line, read in one
// snapshot. Rows stay as Postgres wrote them (row_to_json), never parsed, so
// large numbers keep every digit; sealed secrets are swapped in the text.
//   R <tab> table <tab> row as JSON
//   F <tab> {"bucket","key"} <tab> base64   a file the app keeps
//   B <tab> {"path"} <tab> base64           one of the bot's own files
async function* exportLines(pool, { storageDir, transferKey, tally = null }) {
  const reseal = (text) => text.replace(SEALED, (sealed) => {
    const plain = decryptString(sealed, "a secret being moved");
    return typeof plain === "string" ? sealWith(plain, transferKey) : sealed;
  });
  // A file that is itself a sealed secret (the bot's WhatsApp session,
  // lib/sealed-auth-state.js) is resealed like one; any other goes as it is.
  const resealFile = (data) => {
    const text = data.toString("utf8");
    return text.startsWith(PREFIX) ? Buffer.from(reseal(text), "utf8") : data;
  };
  const client = await pool.connect();
  let ended = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of await tablesToMove(client)) {
      // The bot's own files waiting in the database (lib/move-files.js
      // stash, on a host whose bot keeps its folder to itself) go as its
      // files below, resealed, not as rows.
      const only = table === "storage_objects" ? ` WHERE t.bucket <> '${BOT_FILES_BUCKET}'` : "";
      await client.query(`DECLARE move_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS r FROM ${ident(table)} t${only}`);
      for (;;) {
        const { rows } = await client.query(`FETCH ${ROWS_PER_FETCH} FROM move_rows`);
        if (!rows.length) break;
        for (const { r } of rows) {
          if (tally) tally.rows[table] = (tally.rows[table] || 0) + 1;
          yield `R\t${table}\t${reseal(r)}`;
        }
      }
      await client.query("CLOSE move_rows");
    }
    if ((await tablesToMove(client)).includes("storage_objects")) {
      const { rows: waiting } = await client.query("SELECT key, data FROM storage_objects WHERE bucket = $1 ORDER BY key", [BOT_FILES_BUCKET]);
      for (const { key, data } of waiting) {
        if (tally) tally.fileBytes += data.length;
        yield `B\t${JSON.stringify({ path: key })}\t${resealFile(data).toString("base64")}`;
      }
    }
    await client.query("COMMIT");
    ended = true;
  } finally {
    // Also when sending stopped part way: the snapshot ends before the
    // connection goes back to the pool.
    if (!ended) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  if (storageDir) {
    for (const bucket of BUCKETS) {
      for await (const { key, full } of filesUnder(path.join(storageDir, bucket))) {
        const data = await fsp.readFile(full);
        if (tally) tally.fileBytes += data.length;
        yield `F\t${JSON.stringify({ bucket, key })}\t${data.toString("base64")}`;
      }
    }
    for (const folder of BOT_FOLDERS) {
      for await (const { key, full } of filesUnder(path.join(storageDir, folder))) {
        const data = await fsp.readFile(full);
        if (tally) tally.fileBytes += data.length;
        yield `B\t${JSON.stringify({ path: `${folder}/${key}` })}\t${resealFile(data).toString("base64")}`;
      }
    }
  }
}

// How much a move has to send, measured before it starts: each table's rows
// and size on disk, and the files' size. As the parts go, what has gone of
// each (tally, counted by exportLines) gives how far along it is; it says
// 100 only once the move is done.
async function exportSize(pool, storageDir) {
  const tables = new Map();
  let total = 0;
  const client = await pool.connect();
  try {
    for (const table of await tablesToMove(client)) {
      const { rows: [r] } = await client.query(`SELECT count(*)::bigint AS n, pg_table_size($1::regclass) AS bytes FROM ${ident(table)}`, [ident(table)]);
      const rows = Number(r.n), bytes = Number(r.bytes);
      if (rows > 0) { tables.set(table, { rows, bytes }); total += bytes; }
    }
  } finally { client.release(); }
  if (storageDir) {
    for (const folder of [...BUCKETS, ...BOT_FOLDERS]) {
      for await (const { full } of filesUnder(path.join(storageDir, folder))) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return { tables, total };
}
function percentOf(size, tally) {
  if (!size || !size.total) return null;
  let done = tally.fileBytes;
  for (const [table, { rows, bytes }] of size.tables) done += bytes * Math.min(1, (tally.rows[table] || 0) / rows);
  return Math.min(99, Math.floor((done / size.total) * 100));
}

// Every file under a folder, as a path inside it ("u1/note.txt").
async function* filesUnder(dir, prefix = "") {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const key = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) yield* filesUnder(full, key);
    else if (e.isFile()) yield { key, full };
  }
}

// Gathers lines into parts of about PART_CHARS and hands each over gzipped.
async function sendInParts(lines, sendPart, onProgress = () => {}) {
  let part = [], size = 0, n = 0, sent = 0;
  const flush = async () => {
    if (!part.length) return;
    await sendPart(n, zlib.gzipSync(Buffer.from(part.join("\n"), "utf8")));
    n += 1; sent += size; part = []; size = 0;
    onProgress({ parts: n, chars: sent });
  };
  for await (const line of lines) {
    part.push(line);
    size += line.length + 1;
    if (size >= PART_CHARS) await flush();
  }
  await flush();
  return n;
}

let outbound = null; // the one move this computer is making: { step, error, url, ... }

function outboundStatus() {
  if (!outbound) return { step: "idle" };
  // A move code nobody used in its hour has simply gone.
  if (outbound.step === "waiting" && (!offer || offer.expires < Date.now())) { offer = null; outbound = null; return { step: "idle" }; }
  const { step, error, url, parts, chars, code, expires, home, railway, percent } = outbound;
  return { step, error: error || null, url: url || null, parts: parts || 0, sentMb: Math.round((chars || 0) / 1e6),
    percent: step === "done" ? 100 : Number.isInteger(percent) ? percent : null,
    ...(code ? { code, expires } : {}), ...(home ? { home: true } : {}), ...(railway ? { railway: true } : {}) };
}

// deps: pool, storageDir, marker, restartBot(), botMoveState(), stopTunnel(),
// personalUrl(), exitSoon(), fetch. Returns at once; status() follows it.
function startMove({ address, code }, deps) {
  if (outbound && !["done", "failed"].includes(outbound.step)) throw new Error("A move is already under way.");
  const to = cleanAddress(address);
  if (!to) throw new Error("Paste the web address Railway gave your new Closedhand, starting https://.");
  if (!String(code || "").trim()) throw new Error("Paste its setup code too.");
  if (!deps.marker.available()) throw new Error("This Closedhand can't move from here: it has no storage folder.");
  outbound = { step: "checking" };
  run(to, String(code).trim(), deps).catch(() => {});
  return outboundStatus();
}

async function run(to, code, deps) {
  const doFetch = deps.fetch || fetch;
  const call = async (route, { method = "POST", body, headers = {}, token } = {}) => {
    const r = await doFetch(to + route, {
      method,
      headers: { ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...(token ? { "x-move-token": token } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `The new Closedhand answered ${r.status}.`), { said: !!j.error });
    return j;
  };
  let paused = false;
  try {
    // 1. Hello, and the same release on both sides.
    let hello;
    try { hello = await call("/api/move/hello", { body: { code } }); }
    catch (e) { throw new Error(e.said ? e.message : "Couldn't reach the new Closedhand at that address. Check it and try again."); }
    const ours = await latestUpdate(deps.pool);
    if (hello.latest !== ours) {
      throw new Error(String(hello.latest) < String(ours)
        ? "The new Closedhand is on an older release than this one. Redeploy it on Railway, then try again."
        : "This Closedhand is on an older release than the new one. Update it first, then try again.");
    }
    const token = hello.token;

    // 2. The bot here sits still from now on.
    outbound.step = "pausing";
    deps.marker.write({ state: "moving", to, at: new Date().toISOString() });
    paused = true;
    await deps.restartBot();
    const stillBy = Date.now() + 90000;
    while ((await deps.botMoveState().catch(() => null)) !== "moving") {
      if (Date.now() > stillBy) throw new Error("Closedhand here didn't stop in time, so nothing moved. Try again.");
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 3. Everything, in parts.
    outbound.step = "sending";
    const transferKey = crypto.randomBytes(32);
    const size = await exportSize(deps.pool, deps.storageDir).catch(() => null);
    const tally = { rows: {}, fileBytes: 0 };
    outbound.percent = size ? 0 : null;
    const parts = await sendInParts(
      exportLines(deps.pool, { storageDir: deps.storageDir, transferKey, tally }),
      async (n, gz) => {
        for (let attempt = 1; ; attempt++) {
          try { return await call(`/api/move/part?n=${n}`, { body: gz, token, headers: { "Content-Type": "application/octet-stream" } }); }
          catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
        }
      },
      (p) => Object.assign(outbound, p, { percent: percentOf(size, tally) }));
    outbound.step = "importing";
    await call("/api/move/commit", { body: { parts, key: transferKey.toString("base64") }, token });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await call("/api/move/progress", { method: "GET", token }).catch(() => ({ state: "importing" }));
      if (p.state === "imported") break;
      if (p.state === "failed") throw new Error(p.error || "The new Closedhand couldn't take everything in.");
    }

    // 4. Hand over: the personal URL goes with it.
    outbound.step = "handing-over";
    outbound.url = (await deps.personalUrl().catch(() => null)) || to;
    deps.stopTunnel();
    deps.marker.write({ state: "moved", to, url: outbound.url, at: new Date().toISOString() });
    deps.restartBot().catch(() => {});
    paused = false;
    await call("/api/move/finish", { token }).catch((e) => console.error("[move] the new Closedhand didn't confirm starting:", e.message));
    outbound.step = "done";
    console.log("[move] moved to " + to);
    deps.exitSoon();
  } catch (e) {
    console.error("[move] stopped:", e.message);
    outbound.error = e.message;
    outbound.step = "failed";
    if (paused) {
      deps.marker.clear();
      await deps.restartBot().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

let inbound = null; // { tokenHash, expires, dir, state, error }

function tokenOk(token) {
  if (!inbound || inbound.expires < Date.now() || typeof token !== "string") return false;
  const given = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(given, inbound.tokenHash);
}

// deps: setupCode, passwordConfigured(), pool. Throws with a status for the reply.
async function hello(code, deps) {
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  if (!deps.setupCode.enabled) throw refuse(404, "Not found");
  if (await deps.passwordConfigured()) throw refuse(409, "That Closedhand is already set up, so it can't take another one's data. Deploy a new one on Railway.");
  if (!deps.setupCode.matches(code)) {
    await new Promise((r) => setTimeout(r, 1000));
    throw refuse(401, "That isn't its setup code. Copy SETUP_CODE from the webapp service's Variables on Railway.");
  }
  if (inbound && inbound.state === "importing") throw refuse(409, "A move into this Closedhand is already under way.");
  if (inbound && inbound.dir) await fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {});
  const token = crypto.randomBytes(32).toString("base64url");
  inbound = {
    tokenHash: crypto.createHash("sha256").update(token).digest(),
    expires: Date.now() + TOKEN_TTL_MS,
    dir: await fsp.mkdtemp(path.join(os.tmpdir(), "closedhand-move-")),
    state: "receiving",
    error: null,
  };
  return { token, latest: await latestUpdate(deps.pool) };
}

async function receivePart(n, body) {
  if (!Number.isInteger(n) || n < 0 || n > 100000 || !Buffer.isBuffer(body) || !body.length) throw Object.assign(new Error("No part to take."), { status: 400 });
  if (inbound.state !== "receiving") throw Object.assign(new Error("This move has stopped taking parts."), { status: 409 });
  await fsp.writeFile(path.join(inbound.dir, `part-${n}`), body);
}

// Starts taking everything in and returns at once; progress() follows it.
function commit({ parts, key }, deps) {
  const transferKey = Buffer.from(String(key || ""), "base64");
  if (!Number.isInteger(parts) || parts < 1 || transferKey.length !== 32) throw Object.assign(new Error("That move is incomplete."), { status: 400 });
  if (inbound.state !== "receiving") throw Object.assign(new Error("This move has already been taken in."), { status: 409 });
  inbound.state = "importing";
  importParts(deps.pool, { dir: inbound.dir, parts, transferKey, storage: deps.storage })
    .then(() => { inbound.state = "imported"; console.log("[move] everything taken in"); })
    .catch((e) => { inbound.state = "failed"; inbound.error = e.message; console.error("[move] taking it in failed, nothing changed:", e.message); })
    .finally(() => fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {}));
}

function progress() {
  return { state: inbound.state, error: inbound.error };
}

// After everything is in: start again, reading it all afresh, with the
// personal URL, chat apps and schedules that came with it.
function finish(deps) {
  if (inbound.state !== "imported") throw Object.assign(new Error("Nothing has been taken in yet."), { status: 409 });
  inbound.state = "finished";
  deps.restartBot().catch(() => {});
  deps.exitSoon();
}

// storage: "pg" puts files in storage_objects in the same transaction; a
// folder path writes them there once it commits.
async function importParts(pool, { dir, parts, transferKey, storage }) {
  let opened = 0, unopened = 0;
  const reseal = (text) => text.replace(SEALED, (sealed) => {
    let plain;
    try { plain = openWith(sealed, transferKey); } catch (_) { unopened += 1; return sealed; }
    opened += 1;
    return encryptString(plain);
  });
  const client = await pool.connect();
  const filesAfter = [];
  try {
    await client.query("BEGIN");
    // Rows go in as they were, so the order of tables doesn't matter: no
    // foreign key or trigger runs until the transaction ends.
    await client.query("SET LOCAL session_replication_role = replica");
    const tables = await tablesToMove(client);
    const known = new Set(tables);
    const { rows: colRows } = await client.query(
      `SELECT table_name, column_name, is_generated, identity_generation FROM information_schema.columns WHERE table_schema = 'public'`);
    const columns = new Map();
    for (const c of colRows) {
      if (!columns.has(c.table_name)) columns.set(c.table_name, { insertable: new Set(), identityAlways: new Set() });
      const info = columns.get(c.table_name);
      if (c.is_generated !== "ALWAYS") info.insertable.add(c.column_name);
      if (c.identity_generation === "ALWAYS") info.identityAlways.add(c.column_name);
    }
    await client.query(`TRUNCATE ${tables.map(ident).join(", ")} CASCADE`);

    const pending = new Map(); // table -> raw row texts
    const columnList = new Map(); // table -> the columns both sides have
    const flush = async (table) => {
      const rows = pending.get(table);
      if (!rows || !rows.length) return;
      pending.set(table, []);
      if (!columnList.has(table)) {
        const info = columns.get(table);
        columnList.set(table, Object.keys(JSON.parse(rows[0])).filter((c) => info.insertable.has(c)));
      }
      const cols = columnList.get(table);
      const list = cols.map(ident).join(", ");
      const overriding = cols.some((c) => columns.get(table).identityAlways.has(c)) ? " OVERRIDING SYSTEM VALUE" : "";
      await client.query(
        `INSERT INTO ${ident(table)} (${list})${overriding} SELECT ${list} FROM json_populate_recordset(null::${ident(table)}, $1::json)`,
        ["[" + rows.join(",") + "]"]);
    };

    for (let n = 0; n < parts; n++) {
      let text;
      try { text = zlib.gunzipSync(await fsp.readFile(path.join(dir, `part-${n}`))).toString("utf8"); }
      catch (_) { throw new Error(`Part ${n + 1} of ${parts} didn't arrive whole.`); }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const kind = line.slice(0, 2);
        const second = line.indexOf("\t", 2);
        if (kind === "R\t") {
          const table = line.slice(2, second);
          if (!known.has(table)) continue;
          // A host that keeps files in its database (Railway) sends them as
          // rows; where this computer keeps them in a folder, they go there.
          // The bot's own files stay rows for its bot to write out.
          if (table === "storage_objects" && storage !== "pg") {
            const row = JSON.parse(line.slice(second + 1));
            if (!String(row.bucket || "").startsWith("_") && typeof row.data === "string" && row.data.startsWith("\\x")) {
              filesAfter.push({ bucket: row.bucket, key: row.key, data: Buffer.from(row.data.slice(2), "hex") });
              continue;
            }
          }
          if (!pending.has(table)) pending.set(table, []);
          pending.get(table).push(reseal(line.slice(second + 1)));
          if (pending.get(table).length >= ROWS_PER_INSERT) await flush(table);
        } else if (kind === "F\t") {
          const { bucket, key } = JSON.parse(line.slice(2, second));
          const data = Buffer.from(line.slice(second + 1), "base64");
          if (storage === "pg") {
            await client.query(
              `INSERT INTO storage_objects (bucket, key, data) VALUES ($1, $2, $3)
               ON CONFLICT (bucket, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [bucket, key, data]);
          } else filesAfter.push({ bucket, key, data });
        } else if (kind === "B\t") {
          const { path: where } = JSON.parse(line.slice(2, second));
          // Sealed for the move, sealed again under this computer's key.
          let data = Buffer.from(line.slice(second + 1), "base64");
          const text = data.toString("utf8");
          if (text.startsWith(PREFIX)) data = Buffer.from(reseal(text), "utf8");
          await client.query("INSERT INTO storage_objects (bucket, key, data) VALUES ($1, $2, $3)",
            [BOT_FILES_BUCKET, where, data]);
        }
      }
    }
    for (const table of pending.keys()) await flush(table);
    if (unopened && !opened) throw new Error("The stored secrets couldn't be opened, so nothing changed.");

    for (const name of SETTINGS_LEFT_BEHIND) {
      await client.query(`UPDATE profiles SET settings = settings #- $1::text[] WHERE settings ? 'self_host_config'`, [["self_host_config", name]]);
    }
    // Counters carry on from the highest id that came across.
    const { rows: seqs } = await client.query(
      `SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
       FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
       JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       WHERE s.relkind = 'S' AND n.nspname = 'public'`);
    for (const { seq, tbl, col } of seqs) {
      await client.query(`SELECT setval($1::regclass, COALESCE((SELECT max(${ident(col)}) FROM ${ident(tbl)}), 0) + 1, false)`, [ident(seq)]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (filesAfter.length && typeof storage === "string" && storage !== "pg") {
    const { safeJoin } = require("./storage-driver-local");
    for (const f of filesAfter) {
      const full = safeJoin(path.resolve(storage), f.bucket, f.key);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, f.data);
    }
  }
  if (unopened) console.log(`[move] ${unopened} value(s) that looked sealed didn't open, and came across as they were.`);
}

// ---------------------------------------------------------------------------
// Moving to a computer of the person's own, such as a Mac mini left on
// ---------------------------------------------------------------------------
//
// There is no host to set Closedhand up on, and a new Closedhand at home has
// no address anyone can reach, so the new computer fetches everything from
// this one, through this one's personal URL:
//   1. My Account here shows a move code: 20 characters, for one hour, once.
//   2. Setup on the new computer takes the personal URL and the code. Each
//      side proves it knows the code without sending it (HKDF, HMAC), and
//      both make the same keys from it and a random value from each side.
//   3. Closedhand here sits still (the same marker as a move to Railway),
//      then hands over every part, sealed (AES-256-GCM), so nothing that
//      carries the personal URL can read one without the code; every call
//      after the first is signed and numbered, so none can be replayed.
//   4. Once the new computer has taken it all in, this one stops its
//      personal URL and marks itself moved, and the new one starts with it.
// A new computer that goes quiet for ten minutes, or anything failing before
// step 4, leaves Closedhand carrying on here as before.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 60 * 60 * 1000;
const CODE_TRIES = 5;
const QUIET_MS = 10 * 60 * 1000;

const codeOf = (typed) => String(typed || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const shownCode = (code) => code.match(/.{1,4}/g).join("-");
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const unb64 = (text) => Buffer.from(String(text || ""), "base64url");
function derive(code, salt, info) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(codeOf(code)), salt, "closedhand move: " + info, 32));
}
const mac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
// What each side shows the other: the new computer that it has the code,
// this one that it gave it.
const helloProof = (code, theirs) => mac(derive(code, theirs, "hello"), "hello");
const replyProof = (code, theirs, ours) => mac(derive(code, Buffer.concat([theirs, ours]), "reply"), "reply");
function keysFor(code, theirs, ours) {
  const salt = Buffer.concat([theirs, ours]);
  return { seal: derive(code, salt, "parts"), sign: derive(code, salt, "calls") };
}
function seal(key, label, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(label));
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function unseal(key, label, data) {
  if (!Buffer.isBuffer(data) || data.length < 28) throw new Error("A part arrived broken.");
  const d = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  d.setAAD(Buffer.from(label));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}
const callLabel = (step, seq, n) => `${step}:${seq}:${n === undefined ? "" : n}`;

// One part at a time from the export to whoever asks: the export waits until
// the part before has been taken, so only one is ever held.
function oneAtATime() {
  let item = null, putWaiting = null, takeWaiting = null, stopped = null;
  const wake = (w) => w && w();
  return {
    async put(value) {
      while (item && !stopped) await new Promise((r) => { putWaiting = r; });
      if (stopped) throw stopped;
      item = value;
      const t = takeWaiting; takeWaiting = null; wake(t);
    },
    async take(ms) {
      if (!item && !stopped) {
        await new Promise((r) => { takeWaiting = r; setTimeout(r, ms).unref?.(); });
      }
      if (stopped) throw stopped;
      if (!item) return null;
      const value = item; item = null;
      const p = putWaiting; putWaiting = null; wake(p);
      return value;
    },
    stop(error) { stopped = error; wake(putWaiting); wake(takeWaiting); putWaiting = takeWaiting = null; },
  };
}

let offer = null; // a code shown here: { code, expires, tries }
let giving = null; // the move out to a computer of the person's own

// My Account: a new code, which ends any earlier one.
async function offerCode(deps) {
  if (outbound && !["done", "failed"].includes(outbound.step)) throw new Error("A move is already under way.");
  if (!deps.marker.available()) throw new Error("This Closedhand can't move from here: it has no storage folder.");
  const url = await deps.personalUrl().catch(() => null);
  if (!url) throw new Error("Claim your personal URL first: the other computer finds Closedhand through it.");
  const code = [...crypto.randomBytes(20)].map((b) => CODE_ALPHABET[b % 32]).join("");
  offer = { code, expires: Date.now() + CODE_TTL_MS, tries: 0 };
  outbound = { step: "waiting", url, code: shownCode(code), expires: new Date(offer.expires).toISOString() };
  return { code: shownCode(code), url, expires: outbound.expires };
}
function withdrawOffer() {
  offer = null;
  if (outbound && outbound.step === "waiting") outbound = null;
}

// Back to carrying on here: the new computer stopped, failed or went quiet.
async function giveUp(deps, message) {
  if (!giving) return;
  const was = giving;
  giving = null;
  clearTimeout(was.quiet);
  was.parts.stop(new Error(message));
  if (was.paused) {
    deps.marker.clear();
    await deps.restartBot().catch(() => {});
  }
  outbound = { step: "failed", error: message, home: true };
  console.log("[move] " + message);
}

// The new computer's first call: { nonce, proof }. Answers with this side's
// nonce and proof, a session id and this release.
async function giveHello(body, deps) {
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  if (!offer || offer.expires < Date.now()) throw refuse(404, "There's no move code waiting on that Closedhand. Get a new one in its My Account.");
  if (giving) throw refuse(409, "A move from that Closedhand is already under way.");
  const theirs = unb64(body && body.nonce);
  if (theirs.length !== 16 || !same(unb64(body.proof), helloProof(offer.code, theirs))) {
    offer.tries += 1;
    if (offer.tries >= CODE_TRIES) withdrawOffer();
    await new Promise((r) => setTimeout(r, 1000));
    throw refuse(401, "That isn't the move code that Closedhand shows. Check it and try again.");
  }
  const ours = crypto.randomBytes(16);
  const code = offer.code;
  offer = null; // once
  const session = b64(crypto.randomBytes(18));
  giving = { session, keys: keysFor(code, theirs, ours), seq: 0, next: 0, last: null, paused: false, parts: oneAtATime(), quiet: null, sent: 0 };
  outbound = { step: "checking", url: outbound && outbound.url, home: true };
  const quiet = () => { clearTimeout(giving.quiet); giving.quiet = setTimeout(() => giveUp(deps, "The other computer stopped asking, so Closedhand carries on here."), QUIET_MS); giving.quiet.unref?.(); };
  giving.touch = quiet;
  quiet();
  // Where it comes from, for the new computer to draw: Railway or a computer.
  return { nonce: b64(ours), proof: b64(replyProof(code, theirs, ours)), session, latest: await latestUpdate(deps.pool), from: deps.railway ? "railway" : "computer" };
}

// Every later call: { session, seq, mac } over (step, seq, n), seq rising.
function signedCall(step, { session, seq, sig, n }) {
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  if (!giving || session !== giving.session) throw refuse(401, "This move has ended. Start it again.");
  const number = Number(seq);
  if (!Number.isInteger(number) || number <= giving.seq || !same(unb64(sig), mac(giving.keys.sign, callLabel(step, number, n)))) {
    throw refuse(401, "This move has ended. Start it again.");
  }
  giving.seq = number;
  giving.touch();
}

// start: Closedhand here sits still, then the export begins.
async function giveStart(deps) {
  outbound.step = "pausing";
  deps.marker.write({ state: "moving", to: outbound.url || "another computer", at: new Date().toISOString() });
  giving.paused = true;
  await deps.restartBot();
  const stillBy = Date.now() + 90000;
  while ((await deps.botMoveState().catch(() => null)) !== "moving") {
    if (Date.now() > stillBy) { await giveUp(deps, "Closedhand here didn't stop in time, so nothing moved. Try again."); throw Object.assign(new Error("Closedhand there didn't stop in time. Try again."), { status: 409 }); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // A bot whose folder this side can't read (Railway) puts its own files,
  // such as its WhatsApp session, in the database first, to go along.
  if (!deps.storageDir && deps.stashBotFiles) await deps.stashBotFiles().catch((e) => console.error("[move] the bot's own files stay behind:", e.message));
  outbound.step = "sending";
  const now = giving;
  now.transferKey = crypto.randomBytes(32);
  const size = await exportSize(deps.pool, deps.storageDir).catch(() => null);
  const tally = { rows: {}, fileBytes: 0 };
  outbound.percent = size ? 0 : null;
  sendInParts(exportLines(deps.pool, { storageDir: deps.storageDir, transferKey: now.transferKey, tally }), (n, gz) => now.parts.put({ n, gz, percent: percentOf(size, tally) }),
    (p) => { if (giving === now) Object.assign(outbound, p, { percent: percentOf(size, tally) }); })
    .then((parts) => now.parts.put({ done: true, parts }))
    .catch((e) => { if (giving === now) giveUp(deps, "The move stopped here: " + e.message + " Closedhand carries on here."); });
}

// part n, sealed, or { done } once there are no more. Asking again for the
// part just sent sends it again.
async function givePart(n) {
  const now = giving;
  if (now.last && now.last.n === n) return now.last.body;
  if (n === now.next && now.total !== undefined) return null;
  if (n !== now.next) throw Object.assign(new Error("Parts are asked for in order."), { status: 409 });
  const item = await now.parts.take(60000);
  if (!item) throw Object.assign(new Error("The next part isn't ready yet. Ask again."), { status: 503 });
  if (item.done) { now.total = item.parts; return null; }
  const body = seal(now.keys.seal, "part:" + item.n, item.gz);
  now.last = { n: item.n, body, percent: item.percent };
  now.next = item.n + 1;
  return body;
}
// How far along the part just sent took the move, for the new computer.
function givenPercent() {
  return giving && giving.last && Number.isInteger(giving.last.percent) ? giving.last.percent : null;
}

// key: how many parts, and the one-time key the secrets are sealed under.
function giveKey() {
  if (giving.total === undefined) throw Object.assign(new Error("Not every part has been sent yet."), { status: 409 });
  return seal(giving.keys.seal, "key", Buffer.from(JSON.stringify({ parts: giving.total, key: giving.transferKey.toString("base64") })));
}

// finish: the new computer has everything. It hears so first; then the
// personal URL stops here, Closedhand here marks itself moved and stops.
function giveFinish(deps) {
  const now = giving;
  clearTimeout(now.quiet);
  outbound.step = "handing-over";
  setTimeout(() => {
    deps.stopTunnel();
    deps.marker.write({ state: "moved", to: outbound.url || "another computer", url: outbound.url, at: new Date().toISOString() });
    // The bot keeps its own copy of the marker where its folder is its own.
    deps.restartBot().catch(() => {});
    outbound = { step: "done", url: outbound.url, home: true, ...(deps.railway ? { railway: true } : {}) };
    giving = null;
    console.log("[move] moved to a computer of the person's own");
    deps.exitSoon();
  }, 2000).unref?.();
}

// ---- The new computer: fetching everything from the old one --------------

let fetching = null; // { step, error, receivedMb }
let handoverAgain = null; // after an unconfirmed end: ask the old computer to let go again

function fetchStatus() { return fetching ? { ...fetching } : { step: "idle" }; }

// deps: pool, storage, passwordConfigured(), restartBot(), exitSoon, fetch.
async function startFetch({ address, code }, deps) {
  if (fetching && !["failed", "idle"].includes(fetching.step)) throw new Error("A move is already under way.");
  if (await deps.passwordConfigured()) throw new Error("This Closedhand is already set up, so it can't take another one's. Bring it to a computer where Closedhand is new.");
  const from = cleanAddress(address);
  if (!from) throw new Error("Type the other Closedhand's personal URL, like name.closedhand.ai.");
  if (codeOf(code).length !== 20) throw new Error("Type the 20-character move code its My Account shows.");
  fetching = { step: "checking", receivedMb: 0 };
  fetchAll(from, codeOf(code), deps).catch(() => {});
  return fetchStatus();
}

async function fetchAll(from, code, deps) {
  const doFetch = deps.fetch || fetch;
  let keys = null, session = null, seq = 0, started = false, lastPercent = null;
  const signed = async (step, { n, timeout = 120000 } = {}) => {
    seq += 1;
    const sig = b64(mac(keys.sign, callLabel(step, seq, n)));
    const r = await doFetch(`${from}/api/move/out/${step}${n === undefined ? "" : "?n=" + n}`, {
      method: "POST",
      headers: { "x-move-session": session, "x-move-seq": String(seq), "x-move-sig": sig },
      signal: AbortSignal.timeout(timeout),
    });
    if (r.status === 204) return null;
    const told = Number(r.headers && r.headers.get && r.headers.get("x-move-percent"));
    lastPercent = Number.isInteger(told) && told >= 0 && told <= 100 ? told : lastPercent;
    const body = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      let said = null;
      try { said = JSON.parse(body.toString("utf8")).error; } catch (_) {}
      throw Object.assign(new Error(said || `The other Closedhand answered ${r.status}.`), { status: r.status });
    }
    return body;
  };
  try {
    // 1. Hello: each side shows it knows the code, and the same release.
    const theirs = crypto.randomBytes(16);
    let hello;
    try {
      const r = await doFetch(from + "/api/move/out/hello", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: b64(theirs), proof: b64(helloProof(code, theirs)) }), signal: AbortSignal.timeout(30000),
      });
      hello = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(hello.error || `It answered ${r.status}.`), { said: !!hello.error });
    } catch (e) { throw new Error(e.said ? e.message : "Couldn't reach Closedhand at that personal URL. Check it, and that the other computer is on, then try again."); }
    const ours = unb64(hello.nonce);
    if (ours.length !== 16 || !same(unb64(hello.proof), replyProof(code, theirs, ours))) throw new Error("That personal URL didn't answer as the Closedhand the code came from, so nothing moved.");
    keys = keysFor(code, theirs, ours);
    session = String(hello.session || "");
    fetching.from = hello.from === "railway" ? "railway" : "computer";
    const mine = await latestUpdate(deps.pool);
    if (hello.latest !== mine) {
      await signed("cancel").catch(() => {});
      throw new Error(String(hello.latest) < String(mine)
        ? "The other computer runs an older release of Closedhand. Update it first, then try again."
        : "This computer runs an older release of Closedhand. Update it first, then try again.");
    }

    // 2. Closedhand there sits still.
    fetching.step = "pausing";
    await signed("start");
    fetching.from = fetching.from || "computer";
    started = true;

    // 3. Every part, opened and kept until all are here.
    fetching.step = "receiving";
    if (inbound && inbound.dir) await fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {});
    inbound = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), "closedhand-move-")), state: "receiving", error: null };
    let received = 0;
    for (let n = 0; ; n++) {
      let body;
      for (let attempt = 1; ; attempt++) {
        try { body = await signed("part", { n }); break; }
        catch (e) { if (attempt >= 4 || (e.status && e.status < 500)) throw e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
      }
      if (body === null) break;
      const gz = unseal(keys.seal, "part:" + n, body);
      await receivePart(n, gz);
      received += gz.length;
      fetching.receivedMb = Math.round(received / 1e6);
      if (Number.isInteger(lastPercent)) fetching.percent = lastPercent;
    }
    const { parts, key } = JSON.parse(unseal(keys.seal, "key", await signed("key")).toString("utf8"));

    // 4. Taken in whole, or not at all.
    fetching.step = "importing";
    commit({ parts, key }, deps);
    while (inbound.state === "importing") await new Promise((r) => setTimeout(r, 1000));
    if (inbound.state !== "imported") throw new Error(inbound.error || "This computer couldn't take everything in, so nothing changed.");

    // 5. The old computer lets go of the personal URL; then this one starts.
    fetching.step = "handing-over";
    for (let attempt = 1; ; attempt++) {
      try { await signed("finish"); break; }
      catch (e) {
        if (attempt >= 10) {
          fetching = { step: "unconfirmed", error: "Everything is here, but the other computer didn't answer at the end. Keep it on and press Try again." };
          handoverAgain = () => letGo(signed, deps);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    fetching.step = "done";
    finish(deps);
  } catch (e) {
    console.error("[move] fetching stopped:", e.message);
    if (started) await signed("cancel").catch(() => {});
    if (inbound && inbound.state === "receiving") { await fsp.rm(inbound.dir, { recursive: true, force: true }).catch(() => {}); inbound = null; }
    fetching = { step: "failed", error: e.message };
  }
}
async function letGo(signed, deps) {
  fetching = { step: "handing-over" };
  try { await signed("finish"); handoverAgain = null; fetching.step = "done"; finish(deps); }
  catch (_) { fetching = { step: "unconfirmed", error: "The other computer still didn't answer. Check it's on and online, then press Try again." }; }
}
function retryHandover() {
  if (!fetching || fetching.step !== "unconfirmed" || !handoverAgain) throw new Error("There's nothing to try again.");
  handoverAgain();
  return { step: "handing-over" };
}

module.exports = {
  cleanAddress, startMove, outboundStatus,
  hello, tokenOk, receivePart, commit, progress, finish,
  offerCode, withdrawOffer, giveHello, signedCall, giveStart, givePart, givenPercent, giveKey, giveFinish, giveUp,
  startFetch, fetchStatus, retryHandover,
  BOT_FILES_BUCKET,
  _internals: { exportLines, exportSize, percentOf, sendInParts, importParts, latestUpdate, tablesToMove, filesUnder, LEFT_BEHIND, keysFor, helloProof, replyProof, seal, unseal, codeOf },
};
