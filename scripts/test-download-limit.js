// A download past what any file is read at is refused as it arrives, never
// held whole: a video on a calendar event, larger than a string can hold,
// stopped the bot whenever its files were read. Google and Microsoft alike.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const store = { getConnection: () => ({ tokens: { access_token: "test-token", expiry: Date.now() + 3600000 } }) };

// https.request answering with these chunks and headers.
function answer(chunks, headers = {}) {
  const real = https.request;
  https.request = (opts, onResponse) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = headers;
      onResponse(res);
      for (const c of chunks) { if (req.destroyed) break; res.emit("data", c); }
      if (!req.destroyed) res.emit("end");
    });
    return req;
  };
  return () => { https.request = real; };
}

for (const [name, mod, fn] of [["Google", "../lib/services/google", "googleApiRequest"], ["Microsoft", "../lib/services/microsoft", "microsoftApiRequest"]]) {
  const request = require(mod)[fn];

  test(`${name}: a file said to be too large is refused before it downloads`, async () => {
    const done = answer([Buffer.alloc(10)], { "content-length": String(600 * 1024 * 1024) });
    try { await assert.rejects(request("GET", "https://files.example/v1/f?alt=media", null, store), /too large to read \(over 50 MB\)/); }
    finally { done(); }
  });

  test(`${name}: one that grows past the limit is stopped as it arrives`, async () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 1);
    const done = answer(Array.from({ length: 20 }, () => chunk));
    try { await assert.rejects(request("GET", "https://files.example/v1/f?alt=media", null, store), /too large to read/); }
    finally { done(); }
  });

  test(`${name}: a file within it comes back whole, as bytes; JSON as JSON`, async () => {
    let done = answer([Buffer.from("%PDF-1.7 "), Buffer.from([0xff, 0xfe, 0x00])]);
    try {
      const r = await request("GET", "https://files.example/v1/f?alt=media", null, store);
      assert.equal(r._binary, true);
      assert.equal(r.raw.length, 12);
    } finally { done(); }
    done = answer([Buffer.from('{"items":'), Buffer.from("[1,2]}")]);
    try { assert.deepEqual(await request("GET", "https://api.example/v1/list", null, store), { items: [1, 2] }); }
    finally { done(); }
  });
}

test("a file too large to read is not fetched again, and calendar files say so on the first account", () => {
  const fs = require("node:fs");
  const files = fs.readFileSync(require.resolve("../lib/item-files"), "utf8");
  assert.match(files, /lasting: \/\^Unknown source\|not yet implemented\|too large to read\/\.test\(got\.error\)/);
  assert.match(files, /got\.buffer\.length >= MAX_BYTES\) throw Object\.assign\(new Error\("too large to read"\), \{ lasting: true \}\)/);
  const access = fs.readFileSync(require.resolve("../lib/services/data-access"), "utf8");
  assert.match(access, /if \(\/too large to read\/\.test\(e\.message\)\) return \{ error: e\.message \};/);
});
