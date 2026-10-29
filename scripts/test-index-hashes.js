// What is indexed already is read whole, however the database orders its
// rows. Read by offset in no order, the rows came back in a different order
// each time as a pass rewrote entries, and a third of 23,000 emails were never
// seen, looked new and were embedded again on every pass (usi.js readIndexed).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..");

// A table whose rows come back in a new order on every read unless sorted,
// as Postgres returns them while rows are being rewritten.
function shuffledTable(rows) {
  let seed = 7;
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { seed = (seed * 9301 + 49297) % 233280; const j = Math.floor((seed / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  return {
    from() {
      const f = [], q = { _order: null, _offset: 0, _limit: 1000 };
      Object.assign(q, {
        select: () => q,
        eq: (c, v) => (f.push((r) => r[c] === v), q),
        gt: (c, v) => (f.push((r) => r[c] > v), q),
        in: (c, vs) => (f.push((r) => vs.includes(r[c])), q),
        is: (c, v) => (f.push((r) => (c === "data->tombstone" ? r.data?.tombstone ?? null : r[c] ?? null) === v), q),
        lt: (c, v) => (f.push((r) => r[c] < v), q),
        not: (c, op, list) => { const vs = String(list).replace(/^\(|\)$/g, "").split(","); f.push((r) => !vs.includes(String(r[c]))); return q; },
        delete: () => ((q._delete = true), q),
        order: (c, o = {}) => ((q._order = c), (q._desc = o.ascending === false), q),
        limit: (n) => ((q._limit = n), q),
        range: (a, b) => ((q._offset = a), (q._limit = b - a + 1), q),
        then: (res, rej) => {
          if (q._delete) { for (let i = rows.length - 1; i >= 0; i--) if (f.every((p) => p(rows[i]))) rows.splice(i, 1); return Promise.resolve({ error: null }).then(res, rej); }
          let out = shuffle(rows.filter((r) => f.every((p) => p(r))));
          if (q._order) out.sort((a, b) => (a[q._order] < b[q._order] ? -1 : 1) * (q._desc ? -1 : 1));
          return Promise.resolve({ data: out.slice(q._offset, q._offset + q._limit), error: null }).then(res, rej);
        },
      });
      return q;
    },
  };
}

function syncWith(rows) {
  const store = require.resolve(path.join(root, "user-store.js"));
  require.cache[store] = { id: store, filename: store, loaded: true, exports: { supabase: shuffledTable(rows), UserStore: {} } };
  const sync = require.resolve(path.join(root, "lib/services/data-sync.js"));
  delete require.cache[sync];
  return require(sync);
}

function usiWith(rows) {
  const store = require.resolve(path.join(root, "user-store.js"));
  require.cache[store] = { id: store, filename: store, loaded: true, exports: { supabase: shuffledTable(rows) } };
  const usi = require.resolve(path.join(root, "lib/services/usi.js"));
  delete require.cache[usi];
  return require(usi);
}

const rows = Array.from({ length: 4500 }, (_, i) => ({
  id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
  user_id: "u1", service: "email", external_id: "msg-" + i,
  source_metadata: { _content_hash: "h" + i, source: "gmail" },
}));

test("every indexed email is seen, in pages of 1,000, whatever order the rows come back in", async () => {
  const { _readIndexed } = usiWith(rows);
  const all = await _readIndexed("u1", "email", null);
  assert.equal(Object.keys(all.hashes).length, 4500);
  assert.equal(all.hashes["msg-4499"], "h4499");
  const some = await _readIndexed("u1", "email", ["msg-3", "msg-4000", "msg-none"]);
  assert.deepEqual(some.hashes, { "msg-3": "h3", "msg-4000": "h4000" });
});

test("the daily passes over cached mail and calendar check their own page only", () => {
  const usi = fs.readFileSync(path.join(root, "lib/services/usi.js"), "utf8");
  assert.match(usi, /const result = await indexItems\(userId, "email", "email", items, \{ scoped: true \}\);/);
  assert.match(usi, /const result = await indexItems\(userId, "calendar", "event", items, \{ scoped: true \}\);/);
  assert.doesNotMatch(usi.slice(usi.indexOf("async function readIndexed"), usi.indexOf("async function indexItemsWithModels")), /\.range\(/, "never by offset");
});

test("the mail sync sees every email it has cached, whatever order the rows come back in", async () => {
  const cache = Array.from({ length: 3200 }, (_, i) => ({ id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"), user_id: "u1", source: "gmail", type: "email", external_id: "m" + i, data: i === 5 ? { tombstone: true } : {} }));
  const { fetchCachedIds } = syncWith(cache);
  const ids = await fetchCachedIds("u1", "gmail", "email");
  assert.equal(ids.size, 3199, "all but the tombstone");
});

test("the clean-up never deletes what the mailbox's own list just named, however old", async () => {
  const yearAgo = "2025-10-26T00:00:00.000Z";
  const cache = [
    ...Array.from({ length: 5000 }, (_, i) => ({ id: "a" + String(i).padStart(5, "0"), user_id: "u1", source: "gmail", type: "email", external_id: "new" + i, received_at: "2026-09-01T00:00:00.000Z" })),
    { id: "b1", user_id: "u1", source: "gmail", type: "email", external_id: "old-sent-listed", received_at: "2023-02-01T00:00:00.000Z" },
    { id: "b2", user_id: "u1", source: "gmail", type: "email", external_id: "old-unlisted", received_at: "2023-02-01T00:00:00.000Z" },
  ];
  const { evictOldItems } = syncWith(cache);
  await evictOldItems("u1", "gmail", "email", 5000, yearAgo, new Set(["old-sent-listed", "new3"]));
  const left = new Set(cache.map((r) => r.external_id));
  assert.ok(left.has("old-sent-listed"), "an old sent email still among the newest 300 stays");
  assert.ok(!left.has("old-unlisted"), "older than a year and not listed still goes");
  assert.equal(left.size, 5001);
});
