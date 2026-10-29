// A page leaves the Pages list for Archived after a week and is deleted three
// months after that: it is a laid-out copy of an answer that stays in the
// chat. Archived projects are not touched. Archived pages say so where they
// are shown.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const expiry = require("../lib/page-expiry");

test("pages archived three months ago are deleted, and only pages", async () => {
  const DAY = 86400000, now = Date.UTC(2026, 9, 24);
  const seen = [];
  const db = { from: (table) => {
    const q = { delete() { seen.push(["table", table]); return q; }, lt(col, val) { seen.push([col, val]); return q; }, is(col, val) { seen.push([col, val]); return q; }, select: async () => ({ data: [{ id: "p1" }, { id: "p2" }], error: null }) };
    return q;
  } };
  assert.equal(await expiry.deleteOldPages(db, now), 2);
  assert.deepEqual(seen, [["table", "reports"], ["last_opened_at", new Date(now - 97 * DAY).toISOString()], ["dataset_id", null]], "a week on the list after its last use, then three months in Archived; a table's page is kept as long as the table");
  assert.match(read("index.js"), /require\("\.\/lib\/page-expiry"\)\.start\(\);/);
  assert.match(read("webapp/views/dashboard.html"), /\(_archivedPages \? '<p class="auto-card-meta" style="padding:0 0.25rem;">Archived pages are deleted three months after they move here\.<\/p>' \+ _archivedPages\.map\(renderPageCard\)/);
});
