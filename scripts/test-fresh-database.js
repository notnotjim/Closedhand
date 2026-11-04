// A database that starts empty (Railway's, a managed Postgres) gets the whole
// schema from the bot, as Docker's first-start scripts give it: the baseline,
// then every runner-managed migration, and nothing twice.
// Run: DATABASE_URL=postgres://... (with pgvector) node --test scripts/test-fresh-database.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { runPendingMigrations, _internals } = require("../lib/migrations");

let pool;
before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});
after(async () => { await pool?.end(); });

const tables = async () => (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;

test("an empty database gets the baseline and every migration, once", async () => {
  assert.equal(await tables(), 0);
  await runPendingMigrations(pool);
  assert.ok((await pool.query("SELECT to_regclass('public.profiles') IS NOT NULL AS ok")).rows[0].ok, "baseline tables exist");
  const managed = fs.readdirSync(path.join(__dirname, "..", "migrations")).filter(_internals.runnerManaged).sort();
  const applied = (await pool.query("SELECT filename FROM schema_migrations ORDER BY filename")).rows.map(r => r.filename);
  assert.deepEqual(applied, managed, "every runner-managed migration is recorded");
  const count = await tables();
  await runPendingMigrations(pool);
  assert.equal(await tables(), count, "a second boot changes nothing");
});

test("a database that already has the schema is left as it is", async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS marker (id int)");
  await _internals.ensureBaseline(pool);
  assert.ok((await pool.query("SELECT to_regclass('public.marker') IS NOT NULL AS ok")).rows[0].ok);
});

test("files kept in the database: saved, read back, replaced and removed, and paths can't climb out", async () => {
  const { createPgStorage } = require("../lib/storage-driver-pg");
  const files = createPgStorage({ pool, baseUrl: "https://example.test" }).from("attachments");
  assert.equal((await files.upload("u1/note.txt", Buffer.from("first"), { contentType: "text/plain", upsert: true })).error, null);
  assert.equal((await files.upload("u1/note.txt", Buffer.from("second"), { contentType: "text/plain", upsert: true })).error, null);
  const got = await files.download("u1/note.txt");
  assert.equal(Buffer.from(await got.data.arrayBuffer()).toString(), "second");
  assert.equal(got.data.type, "text/plain");
  assert.equal((await files.download("u1/missing.txt")).error.message, "Object not found");
  for (const bad of ["../logos/x", "/abs", "a//b", "a/./b", ""]) assert.match((await files.upload(bad, Buffer.from("x"))).error.message, /Invalid/, bad);
  await files.remove(["u1/note.txt"]);
  assert.equal((await files.download("u1/note.txt")).error.message, "Object not found");
  assert.equal(createPgStorage({ pool }).from("logos").getPublicUrl("a.svg").data.publicUrl, "/storage/logos/a.svg");
});

test("the word search finds the words inside an email or web address, not the mail provider's", async () => {
  // Invented items: an agency's address and its site, each alone in a message,
  // and an email whose only addresses are in its From and To lines.
  const me = "33333333-3333-3333-3333-333333333333";
  await pool.query(`INSERT INTO data_cache (user_id, source, type, external_id, data, received_at) VALUES
    ($1, 'whatsapp', 'message', 'wa-1', $2, now()), ($1, 'whatsapp', 'message', 'wa-2', $3, now()), ($1, 'gmail', 'email', 'e-1', $4, now())`,
    [me, { text: "office@harbour-homes.example" }, { text: "https://www.harbour-homes.example/team" }, { from: "Sam Fixture <sam.fixture@gmail.com>", to: "me@outlook.com", body: "See you Friday" }]);
  const found = async (words) => (await pool.query("SELECT external_id FROM search_data_cache_lexical($1, $2, 20)", [me, words])).rows.map((r) => r.external_id).sort();
  assert.deepEqual(await found(["harbour", "homes"]), ["wa-1", "wa-2"], "the agency by its name, from its address and its link");
  assert.deepEqual(await found(["office@harbour-homes.example"]), ["wa-1"], "the whole address still");
  assert.deepEqual(await found(["gmail"]), [], "a free mail provider's name says nothing about whose address it is");
  assert.deepEqual(await found(["www"]), []);
  assert.deepEqual(await found(["fixture"]), ["e-1"], "the sender by name, as before");
});
