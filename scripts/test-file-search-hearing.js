// Recordings and videos in File Search are heard after a folder is read, one
// at a time, the newest first, only while Closedhand is otherwise idle, and
// passed to the bot as they arrive, never held whole. Until then each is found
// by its name. A stand-in bot on a local port; invented files only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

function fakeDb(tables) {
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = [];
      let patch = null, one = false, removing = false, adding = null;
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        insert(r) { adding = Array.isArray(r) ? r : [r]; return q; },
        delete() { removing = true; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        single() { one = true; return q; },
        maybeSingle() { one = true; return q; },
        then(resolve, reject) {
          if (adding) { rows.push(...adding.map((r) => ({ ...r }))); return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (removing) { for (const r of hit) rows.splice(rows.indexOf(r), 1); return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
          if (patch) { for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(patch))); return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
          const data = hit.map((r) => JSON.parse(JSON.stringify(r)));
          return Promise.resolve({ data: one ? data[0] || null : data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

// The bot: says whether it is idle, hears what it is sent, embeds.
async function standInBot() {
  const bot = { idle: false, heard: [], at: 0, most: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/internal/idle") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ idle: bot.idle })); }
    let bytes = 0;
    const body = [];
    req.on("data", (c) => { bytes += c.length; if (url.pathname === "/internal/embed") body.push(c); });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/internal/embed") {
        const { texts } = JSON.parse(Buffer.concat(body).toString());
        return res.end(JSON.stringify({ vectors: texts.map(() => [0.1, 0.2]) }));
      }
      bot.at++; bot.most = Math.max(bot.most, bot.at);
      bot.heard.push({ name: url.searchParams.get("name"), bytes, chunked: !req.headers["content-length"] });
      await new Promise((r) => setTimeout(r, 15));
      bot.at--;
      if (/Silent/.test(url.searchParams.get("name"))) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Nothing is said in this recording." })); }
      res.end(JSON.stringify({ text: `[0:00] Welcome to ${url.searchParams.get("name")}.\n[1:05:10] Thanks for listening.`, frames: [], sound: [] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  bot.url = `http://127.0.0.1:${server.address().port}`;
  bot.close = () => server.close();
  return bot;
}

function loadFileSearch(tables, bot) {
  const stub = (rel, exports) => { const id = require.resolve(path.join("..", "webapp", rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub("db", { supabase: fakeDb(tables) });
  stub("bot-call", { BOT_INTERNAL_URL: bot.url, botToken: () => "test-token" });
  process.env.EMBED_MODEL = "local:test";
  const id = require.resolve("../webapp/rag-processor");
  delete require.cache[id];
  const rag = require("../webapp/rag-processor");
  // Files from the sandbox computer's folders, as File Search reads them.
  rag.init({ getSandboxInfo: async () => ({}), sandboxFetch: async (info, m, route, body) => ({ content: Buffer.from(`bytes of ${body.path}`).toString("base64") }) });
  return rag;
}

test("recordings and videos are heard only while Closedhand is idle, newest first, one at a time, and keep what they were", async () => {
  const bot = await standInBot();
  const doc = (id, name, type, modified, extra = {}) => ({ id, user_id: "u1", source_id: "s1", name, file_type: type, file_path: `/Videos/${name}`, origin: "cloud", status: "pending", metadata: { modified }, updated_at: "2026-11-01T00:00:00Z", ...extra });
  const tables = {
    rag_documents: [
      doc("d1", "Board call March.m4a", "m4a", "2026-03-02T10:00:00Z"),
      doc("d2", "Site walk.mov", "mov", "2026-10-30T10:00:00Z"),
      doc("d3", "Lease.pdf", "pdf", "2026-10-31T10:00:00Z"),
      doc("d4", "Interview.mp3", "mp3", "2026-10-31T09:00:00Z", { status: "error", metadata: { modified: "2026-10-31T09:00:00Z", hear_tries: 1 }, updated_at: new Date().toISOString() }),
      doc("d5", "Silent drone shot.mp4", "mp4", "2026-01-01T10:00:00Z"),
    ],
    rag_sources: [{ id: "s1", account: null }],
    profiles: [{ id: "u1", settings: {} }],
    rag_chunks: [],
  };
  const rag = loadFileSearch(tables, bot);
  try {
    await rag.hearWaiting();
    assert.deepEqual(bot.heard, [], "nothing while Closedhand is busy");
    bot.idle = true;
    await rag.hearWaiting();
    assert.deepEqual(bot.heard.map((h) => h.name), ["Site walk.mov", "Board call March.m4a", "Silent drone shot.mp4"], "newest first; a document is not heard, and a failed one waits its turn to be tried again");
    assert.equal(bot.most, 1, "one at a time");
    const d2 = tables.rag_documents.find((d) => d.id === "d2");
    assert.equal(d2.status, "ready");
    assert.equal(d2.metadata.modified, "2026-10-30T10:00:00Z", "when it was changed is kept, so the next scan does not take it for new");
    assert.ok(d2.metadata.word_count > 0);
    assert.ok(tables.rag_chunks.some((c) => c.document_id === "d2" && /Thanks for listening/.test(c.content)), "what is said is kept, searchable");
    const d5 = tables.rag_documents.find((d) => d.id === "d5");
    assert.deepEqual([d5.status, d5.metadata.hear_tries, d5.metadata.modified], ["error", 5, "2026-01-01T10:00:00Z"], "nothing said in it is its answer for good");
    assert.equal(tables.rag_documents.find((d) => d.id === "d4").status, "error", "tried again later, not now");
  } finally { bot.close(); }
});

test("a recording of any size goes to the bot as it arrives, never held whole", async () => {
  const bot = await standInBot();
  const rag = loadFileSearch({}, bot);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hear-")), "Keynote.mp4");
  fs.writeFileSync(file, Buffer.alloc(30 * 1024 * 1024, 3));
  try {
    const { Readable } = require("node:stream");
    const text = await rag.hearFile(Readable.toWeb(fs.createReadStream(file)), "Keynote.mp4", true, "u1");
    assert.match(text, /^What's said:\n\[0:00\] Welcome to Keynote\.mp4\./);
    assert.deepEqual(bot.heard.map((h) => [h.bytes, h.chunked]), [[30 * 1024 * 1024, true]]);
  } finally { bot.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test("a failed recording is tried again a few times, less often each time", () => {
  const rag = loadFileSearch({}, { url: "http://127.0.0.1:1" });
  const now = Date.parse("2026-11-03T12:00:00Z");
  const err = (tries, at) => ({ status: "error", metadata: { hear_tries: tries }, updated_at: at });
  assert.equal(rag.dueToHear({ status: "pending" }, now), true);
  assert.equal(rag.dueToHear(err(0, "2026-11-03T08:00:00Z"), now), false, "too soon");
  assert.equal(rag.dueToHear(err(1, "2026-11-03T05:00:00Z"), now), true);
  assert.equal(rag.dueToHear(err(2, "2026-11-03T05:00:00Z"), now), false, "twice as long after the second");
  assert.equal(rag.dueToHear(err(5, "2026-10-01T00:00:00Z"), now), false, "not after five");
  assert.equal(rag.dueToHear({ status: "ready" }, now), false);
});

test("a folder's reading leaves recordings and videos listed by name, and heard ones are not read again", () => {
  const rag = read("webapp/rag-processor.js");
  assert.match(rag, /if \(HEARD_TYPES\.has\(typeOf\(file\)\)\) \{\n\s+if \(existing && existing\.metadata\?\.modified !== file\.modified\) \{/);
  assert.match(rag, /metadata: \{ \.\.\.\(\(had && had\.metadata\) \|\| \{\}\), word_count:/, "a file's details are kept when it is read");
  assert.match(rag, /if \(!next \|\| _readingSources\.size \|\| !\(await botIdle\(next\.user_id\)\)\) return;/, "never while a folder is being read");
  assert.match(rag, /finally \{ _readingSources\.delete\(sourceId\); hearWaiting\(\)\.catch\(\(\) => \{\}\); \}/);
  assert.match(read("webapp/server.js"), /setInterval\(\(\) => ragProcessor\.hearWaiting\(\)\.catch\(\(\) => \{\}\), 5 \* 60 \* 1000\);/);
});

test("a folder on the sandbox computer or a Mac is read all the way down, and a Mac asleep is never taken for an empty folder", async () => {
  const rag = loadFileSearch({}, { url: "http://127.0.0.1:1" });
  const tree = {
    "/workspace/Plans": [{ name: "Brief.pdf", type: "file", modified: "2026-10-01" }, { name: "Site", type: "directory" }, { name: ".git", type: "directory" }, { name: "node_modules", type: "directory" }],
    "/workspace/Plans/Site": [{ name: "Survey.docx", type: "file", modified: "2026-10-30" }, { name: "Locked", type: "directory" }],
  };
  rag.init({
    getSandboxInfo: async () => ({}),
    sandboxFetch: async (info, method, route, body) => {
      if (body.path === "/workspace/Plans/Site/Locked") throw new Error("permission denied");
      if (!tree[body.path]) throw new Error("listed a folder it should not: " + body.path);
      return { files: tree[body.path] };
    },
    bridgeRequest: async () => { throw new Error("Bridge is not connected"); },
  });
  const files = await rag.scanFolder("u1", "cloud", "/workspace/Plans", { recursive: true });
  assert.deepEqual(files.map((f) => f.rel), ["Site/Survey.docx", "Brief.pdf", "Site", "Site/Locked"], "newest first, each with where it sits, folders by name; hidden and tool folders left out");
  assert.deepEqual(files.unlisted, ["Site/Locked"], "a folder that could not be listed is named, so what was read from it is kept");
  assert.deepEqual((await rag.scanFolder("u1", "cloud", "/workspace/Plans")).map((f) => f.name), ["Brief.pdf", "Site", ".git", "node_modules"], "browsing is still one folder");
  await assert.rejects(rag.scanFolder("u1", "bridge", "~/Documents", { recursive: true }), /Bridge is not connected/, "a Mac asleep fails the scan, never lists as empty");
  const src = read("webapp/rag-processor.js");
  assert.match(src, /return folderPath\.replace\(\/\\\/\$\/, ""\) \+ "\/" \+ \(file\.rel \|\| file\.name\);/, "a file underneath is fetched by its own path");
  assert.match(src, /if \(unlisted\.some\(\(at\) => filePath\.startsWith\(at\)\)\) continue;/);
});

test("every folder is checked for new and changed files every 15 minutes, and a check that cannot reach it leaves it as it was", () => {
  const src = read("webapp/rag-processor.js");
  assert.match(src, /\.in\("status", \["ready", "error"\]\);/);
  assert.match(src, /await processSource\(src\.id, src\.user_id, src\.origin, src\.path, src\.selected_files \|\| null, src\.account \|\| null, \{ scheduled: true \}\);/);
  assert.match(src, /if \(opts\.scheduled && existing && existing\.metadata\?\.modified === file\.modified && existing\.status === "error"\) return;/, "a file that could not be read waits for Update");
  assert.match(src, /update\(opts\.scheduled \? \{ status: "ready", updated_at: new Date\(\)\.toISOString\(\) \} : \{/);
  assert.match(read("webapp/server.js"), /setInterval\(\(\) => ragProcessor\.checkSources\(\)\.catch\(\(e\) => console\.error\("\[RAG\] Folder check failed:", e\.message\)\), 15 \* 60 \* 1000\);/);
});
