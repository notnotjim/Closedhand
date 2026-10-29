// File Search finds files by name from the moment a source is scanned
// (lib/services/doc-search.js name arm, migrations/079): name hits join the
// name tier of a full search, come back alone while the person types, and
// File Search's page searches as they type with no button.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { docSearch } = require("../lib/services/doc-search");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Chunks for the read documents; names for every listed one.
function fakeDb({ docs, chunks, names }) {
  const asked = [];
  return {
    asked,
    rpc: async (fn, args) => {
      asked.push(fn);
      if (fn === "search_rag_documents_by_name") return { data: names.filter((n) => n.name.toLowerCase().includes(args.query.slice(0, 4).toLowerCase())), error: null };
      if (fn === "match_rag_chunks") return { data: chunks, error: null };
      return { data: [], error: null };
    },
    from() {
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        then(resolve) { return Promise.resolve({ data: docs.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

const docs = [
  { id: "d1", user_id: "u1", status: "ready", name: "Holiday budget.xlsx" },
  { id: "d2", user_id: "u1", status: "ready", name: "Harbor Labs Ltd - Registration Certificate.pdf" },
];
const chunks = [
  { id: "c1", document_id: "d1", chunk_index: 0, content: "Flights, hotels and a certificate of insurance for the trip.", metadata: {}, similarity: 0.5 },
];
const names = [
  { id: "d2", name: "Harbor Labs Ltd - Registration Certificate.pdf", origin: "gdrive", file_path: "f2", file_type: "pdf", status: "ready", score: 1 },
  { id: "d3", name: "Certificate of Incorporation", origin: "gdrive", file_path: "f3", file_type: "folder", status: "listed", score: 1 },
  { id: "d4", name: "Certificate scan.tif", origin: "gdrive", file_path: "f4", file_type: "tif", status: "pending", score: 0.6 },
];

test("files found by name join the name tier, folders and files not read yet included, each once", async () => {
  const db = fakeDb({ docs, chunks, names });
  const rerank = async (q, list) => list.map((d) => ({ ...d, _rerank_score: 0.4 }));
  const { results, no_strong_matches } = await docSearch({ supabase: db, embed: async () => [1], rerank }).searchDocuments("u1", "certificate");
  assert.deepEqual(results.map((r) => r.document_name), ["Harbor Labs Ltd - Registration Certificate.pdf", "Certificate of Incorporation", "Certificate scan.tif", "Holiday budget.xlsx"]
    .filter((n) => results.some((r) => r.document_name === n)));
  const folder = results.find((r) => r.document_id === "d3");
  assert.deepEqual([folder.name_only, folder.file_type, folder.not_read_yet, folder._name_match, folder.content], [true, "folder", true, true, ""]);
  assert.equal(results.filter((r) => r.document_id === "d2").length, 1, "a file found both ways shows once");
  assert.ok(results.findIndex((r) => r.document_id === "d3") < results.findIndex((r) => r.document_id === "d1"), "a name match before a passage that mentions the word");
  assert.equal(no_strong_matches, false);
});

test("while typing, names alone: one lookup, no embedding, no reranking", async () => {
  const db = fakeDb({ docs, chunks, names });
  let modelCalls = 0;
  const search = docSearch({ supabase: db, embed: async () => { modelCalls++; return [1]; }, rerank: async (q, l) => { modelCalls++; return l; } });
  const { results } = await search.searchNames("u1", "certif");
  assert.equal(results.length, 3);
  assert.equal(modelCalls, 0);
  assert.deepEqual(db.asked, ["search_rag_documents_by_name"]);
  assert.deepEqual((await search.searchNames("u1", "c")).results, [], "one letter is not a search");
});

test("passive recall in chat weighs passages, so it leaves names out", async () => {
  const db = fakeDb({ docs, chunks, names });
  await docSearch({ supabase: db, embed: async () => [1], rerank: async (q, l) => l }).searchDocuments("u1", "certificate", { candidatesOnly: true });
  assert.ok(!db.asked.includes("search_rag_documents_by_name"));
});

test("File Search's page searches as the person types, names first, with no Find button", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /<input type="search" id="ragSearchInput"[^>]*oninput="ragSearchTyped\(\)" onkeydown="if\(event\.key==='Enter'\)ragSearch\(\)"/);
  assert.doesNotMatch(page, /rag-query-btn|>Find<\/button>/);
  assert.match(page, /_ragNamesTimer = setTimeout\(function \(\) \{ ragSearchNames\(q\); \}, 150\);\n\s*if \(q\.length >= 3\) _ragFullTimer = setTimeout\(ragSearch, 700\);/);
  assert.match(page, /fetch\('\/api\/rag\/search\?names=1&q=' \+ encodeURIComponent\(q\)\)/);
  assert.match(page, /if \(seq !== _ragSeq\) return;/, "an older answer never replaces a newer one");
  assert.match(page, /if \(origin === 'gdrive' && filePath && fileType === 'folder'\) return 'https:\/\/drive\.google\.com\/drive\/folders\/'/);
  const server = read("webapp/server.js");
  assert.match(server, /if \(req\.query\.names === "1"\) \{\n\s*if \(query\.length < 2\) return res\.json\(\{ results: \[\] \}\);\n\s*try \{ return res\.json\(await _docSearch\.searchNames\(userId, query\)\); \}/);
  const body = (f) => read(f).split("\n").slice(1).join("\n"); // each copy names itself on its first line
  assert.equal(body("lib/services/doc-search.js"), body("webapp/doc-search.js"), "the bot and the dashboard search alike");
});

test("a scan lists every file and folder by name before reading any, documents before photos and video", () => {
  const rag = read("webapp/rag-processor.js");
  assert.match(rag, /supported\.sort\(\(a, b\) => \(MEDIA_TYPES\.has\(typeOf\(a\)\) \? 1 : 0\) - \(MEDIA_TYPES\.has\(typeOf\(b\)\) \? 1 : 0\)/);
  assert.match(rag, /status: "listed", metadata:/);
  assert.match(rag, /for \(const file of listedOnly\) processedPaths\.add\(pathOf\(file\)\);/, "listed files are not cleaned away as gone");
  assert.doesNotMatch(rag, /await supabase\.from\("rag_documents"\)\.delete\(\)\.eq\("id", existing\.id\);/, "re-reading a file keeps its row, so its name stays findable");
  assert.match(rag, /out\.push\(entry\); \/\/ the browser shows folders; indexing lists them by name/);
  assert.match(read("desktop/pg.sh"), /make -s -C contrib\/pg_trgm install/, "the Mac app's Postgres has close-spelling matches too");
});

test("Tesseract keeps only lines it is sure of: a photo's shapes read as letters give no text", () => {
  const { sureText } = require("../lib/file-reader");
  const line = (confidence, text) => ({ confidence, text });
  // Measured: print and screenshots 82 to 96, leaves and textures 0 to 41.
  const data = { text: "raw", blocks: [{ paragraphs: [{ lines: [
    line(96, "CERTIFICATE OF INCORPORATION\n"), line(41, "NAT A) AATANN NAT TI r A) DYATT)"), line(7, "MOITTAD) yy OTH INT"), line(88, "Harbor Labs Ltd, 2024/123456/07"), line(90, "~ :"),
  ] }] }] };
  assert.equal(sureText(data), "CERTIFICATE OF INCORPORATION\nHarbor Labs Ltd, 2024/123456/07");
  assert.equal(sureText({ text: "plain", blocks: null }), "plain", "a Tesseract that gives no lines keeps its text");
  const reader = read("lib/file-reader.js");
  assert.match(reader, /return sureText\(\(await worker\.recognize\(file, \{\}, \{ text: true, blocks: true \}\)\)\.data\);/);
  const rag = read("webapp/rag-processor.js");
  assert.match(rag, /const readWell = !MEDIA_TYPES\.has\(typeOf\(file\)\) \|\| existing\?\.metadata\?\.read_by === PICTURE_READER;/, "pictures read the old way are read again, once");
});

test("the dashboard ranks with the bot's local model, as it embeds with it", async () => {
  const express = { json: () => (req, res, next) => next() };
  const routes = {};
  const app = { post: (p, body, fn) => { routes[p] = fn; } };
  require("../lib/rerank-route").register(app, { verifyToken: (t) => t === "ok", body: express.json(), localModels: { localRerankScores: async (q, texts) => texts.map((t) => (t.includes(q) ? 0.9 : 0.01)) } });
  const call = async (token, body) => { let out; await routes["/internal/rerank"]({ get: () => token, body }, { status(c) { this.code = c; return this; }, json(j) { out = { code: this.code || 200, ...j }; } }); return out; };
  assert.equal((await call("bad", { query: "q", texts: ["a"] })).code, 401);
  assert.deepEqual((await call("ok", { query: "certificate", texts: ["a certificate", "a car"] })).scores, [0.9, 0.01]);
  assert.equal((await call("ok", { query: "", texts: [] })).code, 400);
  const reranker = read("webapp/reranker.js");
  assert.match(reranker, /if \(_localScorer && !localRerankAvailable\(\)\) return _localScorer\(query, texts\);\n\s*return require\("\.\/local-models"\)\.localRerankScores\(query, texts\);/);
  assert.match(read("webapp/server.js"), /require\("\.\/reranker"\)\.setLocalScorer\(async \(query, texts\) => \{[\s\S]{0,200}\/internal\/rerank/);
  assert.match(read("index.js"), /require\("\.\/lib\/rerank-route"\)\.register\(ctx\.expressApp\);/);
});

test("sources end with a dashed tile in their own shape, never a button inside the Sources toggle; one reading at a time", () => {
  const page = read("webapp/views/index.html");
  const toggle = page.slice(page.indexOf('<button class="rag-sources-toggle"'), page.indexOf('<div id="ragSourceList"'));
  assert.doesNotMatch(toggle, /<button[^>]*rag-upload-btn/, "a button inside a button is pushed out of it, onto the first source");
  assert.match(page, /html \+= '<button type="button" class="rag-source rag-source-add" onclick="ragAddSource\(\)">'/);
  assert.match(page, /\+ 'Add a source<\/button>';\n\s*listEl\.innerHTML = html;/, "after the last source, where the new one appears");
  assert.doesNotMatch(page, /chunks so far|' - indexed '/, "plain words, not the index's machinery");
  assert.match(page, /var statusWord = s\.status === 'ready' \? 'Ready' : s\.status === 'error' \? 'Stopped'/);
  assert.match(page, /\+ \(reading \? '' : '<span class="rag-status ' \+ statusClass \+ '">' \+ statusWord \+ '<\/span>'\)/, "said once while reading");
  assert.match(read("webapp/rag-processor.js"), /if \(_readingSources\.has\(sourceId\)\) \{ console\.log\(`\[RAG\] Source \$\{sourceId\} is already being read`\); return; \}/);
});

test("a result row is the file: its name opens it, the matched passage shows with the searched words picked out, and no score", () => {
  const page = read("webapp/views/index.html");
  const fn = (name) => page.slice(page.indexOf(`function ${name}(`), page.indexOf("\n}\n", page.indexOf(`function ${name}(`)) + 2);
  const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ragPassage = new Function("escapeHtml", fn("ragPassage") + "return ragPassage;")(escapeHtml);
  const text = "Opening remarks about the weather. ".repeat(8) + "This certificate confirms that Harbor Labs <Ltd> was incorporated.";
  const out = ragPassage(text, ["certificate"]);
  assert.match(out, /^…/, "starts near the match, not at the top of the file");
  assert.match(out, /This <mark>certificate<\/mark> confirms/);
  assert.match(out, /Harbor Labs &lt;Ltd&gt;/, "the text is escaped before marking");
  assert.equal(ragPassage("A plain note.", ["zebra"]), "A plain note.", "a match by meaning shows the opening");
  const render = fn("ragRenderResults");
  assert.doesNotMatch(render, /% match|Name match|Chunk |rag-result-btn/);
  assert.match(render, /<div class="rag-result-name">' \+ \(openUrl \? '<a href="' \+ openUrl \+ '" target="_blank" rel="noopener">' \+ name \+ '<\/a>' : name\)/);
  assert.match(render, /class="quiet-link" onclick="ragAskAbout\(' \+ i \+ '\)">Ask Closedhand<\/button>/);
});

test("routes that take big bodies (pictures to embed, passages to rank, speech) parse their own, past the bot's 100 KB JSON parser", () => {
  const bot = read("index.js");
  assert.match(bot, /const OWN_BODY = new Set\(\["\/internal\/embed", "\/internal\/rerank", "\/internal\/hear", "\/internal\/dictation"\]\);/);
  assert.match(bot, /ctx\.expressApp\.use\(\(req, res, next\) => \(OWN_BODY\.has\(req\.path\) \? next\(\) : jsonBody\(req, res, next\)\)\);/);
  for (const [file, route] of [["lib/embed-route.js", "/internal/embed"], ["lib/rerank-route.js", "/internal/rerank"], ["lib/hear-route.js", "/internal/hear"], ["lib/dictation.js", "/internal/dictation"]])
    assert.match(read(file), new RegExp(`app\\.post\\("${route.replace(/\//g, "\\/")}", body,`), `${route} brings its own parser`);
});

test("the sandbox computer's activity asks for automation_runs' real columns, and the policies say what the licence is", () => {
  const server = read("webapp/server.js");
  assert.match(server, /\.from\("automation_runs"\)\n\s*\.select\("id, status, model, triggered_by, started_at, completed_at"\)\n\s*\.eq\("user_id", userId\)\n\s*\.order\("started_at", \{ ascending: false \}\)/);
  for (const f of ["webapp/views/privacy.html", "webapp/views/terms.html", "closedhand-com/views/privacy.html", "closedhand-com/views/terms.html"]) {
    assert.match(read(f), /&copy; 2026 Closedhand\. Open source under the Apache License 2\.0\./, f);
    assert.doesNotMatch(read(f), /All rights reserved/, f);
  }
});

test("File Search's rows draw their file type with the Computers tab's icons, which it can reach, in the one neutral", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /window\.monIcon = monIcon;/, "the icon is reachable outside the file manager");
  assert.match(page, /return window\.monIcon\(r\.document_name \|\| '', r\.file_type === 'folder', 36\);/);
  const icon = page.slice(page.indexOf("  function monIcon(name, isDir, size) {"), page.indexOf("  function monImgIcon("));
  assert.doesNotMatch(icon, /var\(--accent\)/, "a file type is never drawn in Closedhand's own colour");
});

test("a source's note about files it couldn't read names the Update button and sits in the neutral, not the accent", () => {
  const rag = read("webapp/rag-processor.js"), page = read("webapp/views/index.html");
  assert.doesNotMatch(rag + page, /Re-index to retry/);
  assert.match(rag, /couldn't be read, so File Search can't find/);
  assert.match(rag, /error_message: "Reading it was cut off\. Update reads it again\." \}/);
  const sources = page.slice(page.indexOf("Completion notes (budget reached"), page.indexOf("rag-source-actions"));
  assert.doesNotMatch(sources, /accent-rgb/);
});

test("a PDF with no words goes into File Search as a picture of its first page, so a logo is found by what it shows", () => {
  const rag = read("webapp/rag-processor.js");
  assert.match(rag, /if \(read\.kind === "pdf" && !String\(read\.text \|\| ""\)\.trim\(\) && media\) \{\n\s*const page = await reader\.pdfPicture\(buffer\);\n\s*if \(page\) media\.push\(\{ modality: "image", buffer: page, label: "\(picture\)" \}\);/);
});
