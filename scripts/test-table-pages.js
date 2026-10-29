// A table Closedhand keeps is a page like everything else it makes: one page
// per table, always showing the table as it is now and downloading as Excel,
// never a new page per change. It never archives, and deleting it deletes the
// table. Tables are no longer a section of their own. Data invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const pages = require("../lib/table-pages");

test("the table as a page: its rows as they are now, one page however often it changes", async () => {
  const ds = { id: "d1", name: "Tennis kit orders", description: "Orders for the Kestrel club, newest last.", columns: [{ name: "Item" }, { name: "Qty" }, { name: "Note" }] };
  const rows = [{ data: { Item: "Racquet", Qty: 2, Note: "Grip | size 2" } }, { data: { Item: "Balls", Qty: 12, Note: "one\nline" } }];
  assert.equal(pages.tableMarkdown(ds, rows), [
    "Orders for the Kestrel club, newest last.", "",
    "| Item | Qty | Note |", "| --- | --- | --- |",
    "| Racquet | 2 | Grip / size 2 |", "| Balls | 12 | one line |",
  ].join("\n"), "a bar or a line break in a cell never breaks the table");
  assert.match(pages.tableMarkdown({ ...ds, description: "" }, []), /\| Item \| Qty \| Note \|\n\| --- \| --- \| --- \|\n\nNo rows yet\./);

  const reports = [];
  const db = { from: (table) => {
    const f = {}; let op = "select", set = null;
    const q = {
      select() { return q; }, eq(k, v) { f[k] = v; return q; }, order() { return q; }, limit() { return q; },
      update(v) { op = "update"; set = v; return q; }, insert(v) { op = "insert"; set = v; return q; },
      single() { return q.then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); },
      then(ok, bad) {
        let out;
        if (table === "datasets") out = { data: [ds] };
        else if (table === "dataset_rows") out = { data: rows };
        else if (op === "insert") { const made = { id: "p" + (reports.length + 1), ...set }; reports.push(made); out = { data: made }; }
        else if (op === "update") { Object.assign(reports.find((r) => r.id === f.id), set); out = { error: null }; }
        else out = { data: reports.filter((r) => r.dataset_id === f.dataset_id) };
        return Promise.resolve(out).then(ok, bad);
      },
    };
    return q;
  } };
  assert.equal(await pages.syncTablePage(db, "u1", "d1"), "p1");
  rows.push({ data: { Item: "Bag", Qty: 1 } });
  assert.equal(await pages.syncTablePage(db, "u1", "d1"), "p1", "the same page, brought up to date");
  assert.equal(reports.length, 1);
  assert.match(reports[0].content, /\| Bag \| 1 \|  \|$/);
  assert.equal(reports[0].title, "Tennis kit orders");
});

test("every change to a table updates its page, and the page lives with the table", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.equal((handlers.match(/await require\("\.\.\/table-pages"\)\.pageOf\(supabase, userId, (data|ds)\.id, toolInput\._platform \|\| ctx\.activePlatform\)/g) || []).length, 4, "made, added to, changed, rows deleted");
  assert.match(read("lib/tools/definitions.js"), /Each table is one page under Pages that always shows it as it is now and downloads as Excel; the result gives its link to share\. Add to the same table rather than making a new one\./);
  assert.match(read("migrations/074_table_pages.sql"), /ALTER TABLE reports ADD COLUMN IF NOT EXISTS dataset_id uuid REFERENCES datasets\(id\) ON DELETE CASCADE;/);
  assert.match(read("lib/page-expiry.js"), /\.lt\("last_opened_at", before\)\.is\("dataset_id", null\)/, "never archived away");
  const server = read("webapp/server.js");
  assert.match(server, /supabase\.from\("reports"\)\.select\(cols\)\.eq\("user_id", userId\)\.not\("dataset_id", "is", null\)\.order\("updated_at", \{ ascending: false \}\)/, "on the list, most recently changed first");
  assert.match(server, /page\.dataset_id\n\s*\? await supabase\.from\("datasets"\)\.delete\(\)/, "deleting the page deletes the table");
  assert.doesNotMatch(server, /app\.get\("\/api\/datasets/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /var changed = !!p\.updated_at && p\.updated_at !== p\.created_at;/, "any page that changed says Updated, a table or a revised page");
  assert.match(dash, /escapeHtml\(\(changed \? 'Updated ' : 'Made '\) \+ made\)/);
  assert.match(dash, /text: table \? 'Delete this table for good\?' : 'Delete this page for good\? The answer stays in the chat you asked in\.'/);
  const page = require("../webapp/report-page");
  assert.match(page.deletedHtml({ title: "Tennis kit orders", dataset_id: "d1" }), /The table "Tennis kit orders" is gone\./);
  assert.ok(page.hasTables(pages.tableMarkdown({ columns: [{ name: "Item" }] }, [{ data: { Item: "Bag" } }])), "so it downloads as Excel");
});
