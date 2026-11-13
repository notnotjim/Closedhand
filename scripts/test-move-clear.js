// A move is a move, not a copy (webapp/move-clear.js): once the new
// Closedhand answers at its address, the computer it left keeps nothing of
// it, and until then it keeps everything.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const clear = require("../webapp/move-clear");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const answer = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test("only the new Closedhand, running, counts as moved", async () => {
  const state = { state: "moved", to: "https://webapp-production-1.up.railway.app", url: "https://bright-fern-21.closedhand.ai" };
  assert.equal(await clear.newOneRuns(state, answer({ status: "ok", service: "closedhand-webapp" })), true);
  assert.equal(await clear.newOneRuns(state, answer({ status: "ok", service: "closedhand-webapp", move: "moved" })), false, "a moved one answering is not the new one");
  assert.equal(await clear.newOneRuns(state, answer({ error: "offline" }, 503)), false);
  assert.equal(await clear.newOneRuns(state, async () => ({ ok: true, status: 200, json: async () => { throw new Error("html"); } })), false, "an offline page is not it");
  assert.equal(await clear.newOneRuns(state, async () => { throw new Error("ECONNREFUSED"); }), false);
  assert.equal(await clear.newOneRuns({ state: "moved", to: "another computer" }, answer({ status: "ok" })), false, "nowhere to ask, nothing cleared");
  let asked = null;
  await clear.newOneRuns(state, async (url) => { asked = url; return { ok: true, json: async () => ({ status: "ok" }) }; });
  assert.equal(asked, "https://bright-fern-21.closedhand.ai/health", "asked where people reach it");
});

test("clearing empties every table but the record of updates, every file but the marker, the sandbox computer and the bot's folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-move-clear-"));
  fs.writeFileSync(path.join(dir, ".closedhand-move.json"), "{}");
  fs.mkdirSync(path.join(dir, "attachments", "u1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", "u1", "scan.pdf"), "x");
  fs.mkdirSync(path.join(dir, "wa-linked-session"));
  fs.writeFileSync(path.join(dir, "wa-linked-session", "creds.json"), "x");
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return /pg_class/.test(sql) ? { rows: [{ name: "conversations" }, { name: "schema_migrations" }, { name: "we\"ird" }] } : { rows: [] }; } };
  let sandboxCode = null, botCleared = false;
  const done = await clear.clearAll({ pool, storageDir: dir, markerName: ".closedhand-move.json",
    clearSandbox: async (code) => { sandboxCode = code; }, clearBot: async () => { botCleared = true; } });
  assert.equal(queries[1], 'TRUNCATE public."conversations", public."we""ird" CASCADE');
  assert.deepEqual(fs.readdirSync(dir), [".closedhand-move.json"]);
  assert.match(sandboxCode, /pkill -f -9 chrom/, "its browser stops writing to the profile first");
  assert.match(sandboxCode, /find \/workspace -mindepth 1 -maxdepth 1 -exec rm -rf \{\} \+/, "the workspace itself stays, its contents go");
  assert.equal(botCleared, true);
  assert.deepEqual(done, { tables: 2, files: 2, sandbox: true, bot: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nothing is cleared until the new one answers; then once, and the marker says so", async () => {
  const state = { state: "moved", to: "https://w.up.railway.app", url: "https://bright-fern-21.closedhand.ai", at: "2026-10-28T10:21:00Z" };
  let up = false, truncated = 0, written = null;
  const deps = {
    fetch: async () => up ? { ok: true, json: async () => ({ status: "ok" }) } : { ok: false, json: async () => ({}) },
    pool: { query: async (sql) => { if (/^TRUNCATE/.test(sql)) truncated++; return { rows: [{ name: "facts" }] }; } },
    storageDir: null, markerName: ".closedhand-move.json",
    marker: { write: (s) => { written = s; } },
    retryMs: 5,
  };
  const run = clear.whenMoved(state, deps);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(truncated, 0, "the new one not answering: everything stays");
  up = true;
  await new Promise((r) => setTimeout(r, 30));
  run.stop();
  assert.equal(truncated, 1);
  assert.equal(written.state, "moved");
  assert.equal(written.url, state.url);
  assert.match(written.cleared, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(clear.whenMoved({ ...state, cleared: written.cleared }, deps), null, "cleared once, never again");
  assert.equal(clear.whenMoved({ state: "moving" }, deps), null, "a move under way clears nothing");
});

test("the moved page says nothing is left once it is, and what to do about Railway's bill", () => {
  assert.equal(clear.leftWords({}, false), "Everything it kept on this computer is cleared as soon as it runs there.");
  assert.equal(clear.leftWords({ cleared: "2026-10-28T12:00:00Z" }, false), "Nothing of it is left on this computer.");
  assert.equal(clear.leftWords({ cleared: "2026-10-28T12:00:00Z" }, true), "Nothing of it is left on Railway. Delete the project there so Railway stops charging you.");
  assert.match(clear.leftWords({}, true), /Then delete the project on Railway so it stops charging you\.$/);
  const server = read("webapp/moved-server.js");
  assert.match(server, /: require\("\.\/move-clear"\)\.leftWords\(state, railway\)\);/);
  assert.doesNotMatch(server, /until you remove it|still on this computer/);
  assert.match(server, /if \(process\.env\.DATABASE_URL\) require\("\.\/move-clear"\)\.whenMoved\(state, clearDeps\(state\)\);/);
  const idle = read("lib/move-idle.js");
  assert.match(idle, /app\.post\("\/internal\/move-clear", \(req, res\) => \{\n\s*if \(!verifyToken\(req\.get\("x-closedhand-token"\)\)\) return res\.status\(401\)/, "only the dashboard may ask");
  assert.match(idle, /if \(\(marker\.read\(\) \|\| \{\}\)\.state !== "moved"\) return res\.status\(409\)/, "and only once moved");
});

// One Closedhand runs for an account. Set up afresh on another computer with
// the same account, the personal URL goes there; closedhand.com tells the
// computer it left, which stops as a moved one does and says where Closedhand
// runs now, keeping what it had: nothing came across, so nothing is cleared.
test("a Closedhand replaced by one set up afresh elsewhere stops, says where it runs now, and clears nothing by itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-replaced-"));
  const was = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const marker = require("../webapp/move-marker");
    marker.write({ state: "replaced", url: "https://amber-fox-42.closedhand.ai", at: "2026-11-13T18:00:00Z" });
    assert.equal(marker.read().state, "replaced", "read, so the bot starts nothing and the dashboard only says where");
    assert.equal(clear.whenMoved(marker.read(), {}), null, "nothing came across, so nothing is cleared by itself");
    const page = require("../webapp/moved-server").page(marker.read());
    assert.match(page, /<h1>Closedhand runs on another computer now<\/h1>/);
    assert.match(page, /Your personal URL, <a href="https:\/\/amber-fox-42\.closedhand\.ai">amber-fox-42\.closedhand\.ai<\/a>, opens it there, so it stopped running here\./);
    assert.match(page, /What it kept on this computer stays here, unused\./);
    assert.doesNotMatch(page, /<button|<form/, "nothing on this open page deletes anything");
  } finally {
    if (was === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read("index.js"), /if \(require\("\.\/lib\/move-marker"\)\.read\(\)\) return require\("\.\/lib\/move-idle"\)\.start\(\);/);
  assert.match(read("webapp/server.js"), /if \(\["moved", "replaced"\]\.includes\(\(require\("\.\/move-marker"\)\.read\(\) \|\| \{\}\)\.state\)\) return require\("\.\/moved-server"\)\.serve\(\);/);
  assert.match(read("webapp/server.js"), /moveMarker\.write\(\{ state: "replaced", url, at: new Date\(\)\.toISOString\(\) \}\);\n\s*await restartBot\(\)/, "the bot stops first");
  assert.match(read("lib/move-idle.js"), /\["moving", "moved", "replaced"\]\.includes\(sent\.state\)/);
  const registration = read("webapp/phone-registration.js");
  assert.match(registration, /if \(data\.state === 'replaced'\) \{\n\s*await forget\(\);\n\s*if \(validAddress\(data\.url\) && replacedHook\) await replacedHook\(data\.url\);/);
});

