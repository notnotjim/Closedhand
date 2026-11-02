// An answer held in memory past 50 MB is refused as it arrives, never held
// whole: a video on a calendar event, larger than a string can hold, stopped
// the bot whenever its files were read. A file's own bytes, of any size, are
// written to disk as they arrive instead. Google and Microsoft alike.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

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

test("a file's bytes of any size are written to disk as they arrive, through a redirect, and a refusal says why", async () => {
  const http = require("node:http");
  const os = require("node:os");
  const path = require("node:path");
  const dl = require("../lib/download-file");
  const MB = 1024 * 1024;
  let auth = [];
  const server = http.createServer((req, res) => {
    auth.push([req.url, req.headers.authorization || null]);
    if (req.url === "/moved") { res.writeHead(302, { location: "/file" }); return res.end(); }
    if (req.url === "/gone") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"File not found: f9"}'); }
    res.writeHead(200, { "content-type": "video/mp4" });
    let sent = 0;
    const more = () => { while (sent < 70 * MB) { sent += MB; if (!res.write(Buffer.alloc(MB, 7))) return res.once("drain", more); } res.end(); };
    more();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dest = dl.tempPath("Ceremony full.mp4");
  try {
    assert.match(path.basename(path.dirname(dest)), /^closedhand-file-/);
    assert.equal(path.extname(dest), ".mp4", "named like the original");
    const got = await dl.downloadTo(`${base}/moved`, { Authorization: "Bearer test-token" }, dest, "Google API");
    assert.deepEqual(got, { size: 70 * MB, type: "video/mp4" }, "past the 50 MB an answer may hold");
    assert.equal(fs.statSync(dest).size, 70 * MB);
    await assert.rejects(dl.downloadTo(`${base}/gone`, {}, dest, "Google API"), /^Error: Google API 404: \{"error":"File not found: f9"\}/);
    assert.equal(fs.existsSync(dest), false, "a refused download leaves nothing behind");
    dl.removeTemp(dest);
    assert.equal(fs.existsSync(path.dirname(dest)), false, "and its folder goes");
    const outside = path.join(os.tmpdir(), "not-closedhand.txt");
    fs.writeFileSync(outside, "keep");
    dl.removeTemp(outside);
    assert.equal(fs.existsSync(outside), true, "only its own files are ever removed");
    fs.rmSync(outside);
  } finally { server.close(); dl.removeTemp(dest); }
});

test("calendar Drive files and large Outlook attachments come to disk; one too large to hold comes back as the file", () => {
  const access = fs.readFileSync(require.resolve("../lib/services/data-access"), "utf8");
  assert.match(access, /size = \(await googleDownload\(`https:\/\/www\.googleapis\.com\/drive\/v3\/files\/\$\{attachment_id\}\$\{how\}`, dest, null, key\)\)\.size;/);
  assert.match(access, /if \(\/too large to read\/\.test\(e\.message\)\) \{\n\s+try \{ await outlookRaw\(url \+ "\/\$value", key\); break; \}/);
  assert.match(access, /if \(size > IN_MEMORY\) return \{ path: file, size, filename, kind, googleKey \};/);
  assert.match(access, /if \(got\.path\) \{ got\.buffer = require\("fs"\)\.readFileSync\(got\.path\); require\("\.\.\/download-file"\)\.removeTemp\(got\.path\); \}/);
  const files = fs.readFileSync(require.resolve("../lib/item-files"), "utf8");
  assert.doesNotMatch(files, /too large to read/, "no file is ever given up on for its size");
  const tools = fs.readFileSync(require.resolve("../lib/tools/handlers"), "utf8");
  assert.doesNotMatch(tools, /too big to read here/, "chat reads a Drive or OneDrive file of any size");
  assert.equal((tools.match(/content = await require\("\.\.\/item-files"\)\.readBytes\(\{ path: dest \}, \{ name: meta\.name, mime: mime \|\| "" \}, ctx\.activeUserId\)/g) || []).length, 2);
});
