// File Search finds a file by its name as soon as its source is scanned,
// close spellings included (migrations/079_rag_name_search.sql), and still
// finds exact words where Postgres has no trigram matching (an older Mac app).
// Run: DATABASE_URL=postgres://... node --test scripts/test-name-search.js
// It makes a database of its own, so it runs beside the other database tests.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { _internals } = require("../lib/migrations");

const ADMIN = process.env.DATABASE_URL;
const DB = "name_search_test";
let pool;
const ME = "11111111-1111-1111-1111-111111111111";

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "079_rag_name_search.sql"), "utf8");
  for (const stmt of _internals.splitStatements(sql)) if (stmt.replace(/--[^\n]*/g, "").trim()) await pool.query(stmt);
}
const find = async (q) => (await pool.query("SELECT name, status, file_type, score FROM search_rag_documents_by_name($1, $2, 10)", [ME, q])).rows;

before(async () => {
  const admin = new Pool({ connectionString: ADMIN });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const u = new URL(ADMIN); u.pathname = "/" + DB;
  pool = new Pool({ connectionString: u.href });
  await pool.query(`CREATE TABLE rag_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL,
    file_type text NOT NULL, status text NOT NULL DEFAULT 'pending', origin text, file_path text, updated_at timestamptz DEFAULT now())`);
  await pool.query(`INSERT INTO rag_documents (user_id, name, file_type, status, origin, file_path) VALUES
    ($1, 'Harbor Labs Ltd - Registration Certificate.pdf', 'pdf', 'pending', 'gdrive', 'f1'),
    ($1, 'Certificate of Incorporation', 'folder', 'listed', 'gdrive', 'f2'),
    ($1, 'Beach photo 0042.jpg', 'jpg', 'ready', 'gdrive', 'f3'),
    ($1, 'Invoice March.pdf', 'pdf', 'error', 'gdrive', 'f4'),
    ($1, 'Parent letter.pdf', 'pdf', 'ready', 'gdrive', 'f5'),
    ('22222222-2222-2222-2222-222222222222', 'Someone Else Certificate.pdf', 'pdf', 'ready', 'gdrive', 'x1')`, [ME]);
  await migrate();
});

after(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: ADMIN });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.end();
});

test("names are found before anything is read, folders and files that failed included, typos and all", async () => {
  const names = async (q) => (await find(q)).map((r) => r.name);
  assert.deepEqual((await names("certificate")).sort(), ["Certificate of Incorporation", "Harbor Labs Ltd - Registration Certificate.pdf"]);
  assert.deepEqual((await names("certifcate")).sort(), ["Certificate of Incorporation", "Harbor Labs Ltd - Registration Certificate.pdf"], "a letter missing");
  assert.deepEqual(await names("invoce"), ["Invoice March.pdf"], "a file that couldn't be read is still found by name");
  assert.deepEqual(await names("0042"), ["Beach photo 0042.jpg"]);
  assert.deepEqual(await names("incorporation"), ["Certificate of Incorporation"]);
  assert.deepEqual((await names("cert")).sort(), ["Certificate of Incorporation", "Harbor Labs Ltd - Registration Certificate.pdf"], "the start of a word, as it is typed");
  assert.deepEqual(await names("rent"), [], "not inside another word (\"parent\", \"registration\")");
  assert.deepEqual(await names("beach phot"), ["Beach photo 0042.jpg"]);
  assert.ok(!(await names("certificate")).includes("Someone Else Certificate.pdf"), "only the person's own");
  assert.deepEqual(await names("   "), []);
  const exact = await find("registration certificate");
  assert.equal(exact[0].name, "Harbor Labs Ltd - Registration Certificate.pdf", "the closest name first");
  assert.equal(exact[0].score, 1);
});

test("without trigram matching, typed words are still found at the start of words in names", async () => {
  await pool.query("DROP EXTENSION IF EXISTS pg_trgm CASCADE");
  assert.deepEqual((await find("certificate")).map((r) => r.name).sort(), ["Certificate of Incorporation", "Harbor Labs Ltd - Registration Certificate.pdf"]);
  assert.deepEqual(await find("certifcate"), [], "no close spellings, and no error");
  await migrate(); // the migration runs again cleanly, and brings matching back
  assert.equal((await find("certifcate")).length, 2);
});
