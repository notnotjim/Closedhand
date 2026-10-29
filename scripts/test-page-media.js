// A page is the one thing Closedhand makes, and it holds anything: words and
// tables, and pictures, charts, films, sounds and interactive pieces made on
// the sandbox computer, each shown as itself. Its PDF and Word document carry
// its words, tables and pictures, and say where the page is for anything only
// the page can show; Excel carries its tables. An interactive piece runs
// sandboxed, away from the page and the sign-in. Names invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const media = require("../lib/page-media");
const page = require("../webapp/report-page");

test("what a page can hold, and the names it knows them by", () => {
  assert.equal(media.partName("/workspace/out/Sales by Month.PNG"), "Sales-by-Month.png");
  assert.equal(media.partName("loan calculator.html"), "loan-calculator.html");
  assert.equal(media.partName("../../etc/passwd"), null, "never a path, and never a kind a page cannot hold");
  assert.equal(media.partName("notes.csv"), null);
  assert.deepEqual(media.namedParts("Intro\n![Sales](chart.png)\nsee ![inline](x.png) here\n![](tour.mp4)\n![](chart.png)\n![](data.csv)"), ["chart.png", "tour.mp4"], "only a line of its own, each once");
  assert.equal(media.partKey("u1", "p1", "chart.png"), "u1/pages/p1/chart.png", "in the person's own storage, which moves with them");
  assert.match(read("scripts/check-vendored-identical.js"), /\{ name: "page-media", copies: \["lib\/page-media\.js", "webapp\/page-media\.js"\] \},/);
  assert.equal(read("lib/page-media.js"), read("webapp/page-media.js"));
});

test("each piece shows as itself, and the downloads suit the page", () => {
  const md = "Intro\n\n![Sales by month](chart.png)\n\n![A walk round the flat](tour.mp4)\n\n![The landlord's voicemail](call.m4a)\n\n![Try a deposit](calc.html)\n\n| Month | Sales |\n| --- | --- |\n| Jan | 4 |";
  const html = page.bodyHtml(md, "T", (n) => `/page/p1/part/${n}`);
  assert.match(html, /<figure><img src="\/page\/p1\/part\/chart\.png" alt="Sales by month" loading="lazy"><figcaption>Sales by month<\/figcaption><\/figure>/);
  assert.match(html, /<video controls playsinline preload="metadata" src="\/page\/p1\/part\/tour\.mp4"><\/video>/);
  assert.match(html, /<audio controls preload="metadata" src="\/page\/p1\/part\/call\.m4a"><\/audio>/);
  assert.match(html, /<iframe src="\/page\/p1\/part\/calc\.html" title="Try a deposit" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" loading="lazy">/, "never allow-same-origin");
  assert.deepEqual(page.formats(md), { pdf: true, docx: true, xlsx: true }, "the film and the interactive piece stay on the page; the rest is in every file");
  assert.deepEqual(page.formats("Words\n\n![Chart](chart.png)"), { pdf: true, docx: true, xlsx: false }, "Word holds pictures as well as a PDF does");
  assert.deepEqual(page.formats("![Try a deposit](calc.html)"), { pdf: false, docx: false, xlsx: false }, "only something that works on the page: no file");
  assert.deepEqual(page.formats("Only words"), { pdf: true, docx: true, xlsx: false });
  const full = page.pageHtml({ id: "p1", title: "Flat hunt", content: "Words\n\n![Chart](chart.png)", created_at: new Date() });
  assert.match(full, /href="\/api\/pages\/p1\/pdf"[\s\S]*href="\/api\/pages\/p1\/docx"/);
  assert.doesNotMatch(full, /\/api\/pages\/p1\/xlsx/);
  assert.match(full, /<img src="\/page\/p1\/part\/chart\.png"/);
  // Each picture at its own size in the Word document, no wider than the text.
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(360, 16); png.writeUInt32BE(180, 20);
  assert.deepEqual(page.imageSize(png), { w: 360, h: 180, ext: "png" });
  const gif = Buffer.from("GIF89a\x40\x01\xc8\x00" + "x".repeat(20), "latin1");
  assert.deepEqual(page.imageSize(gif), { w: 320, h: 200, ext: "gif" });
  const src = read("webapp/report-page.js");
  assert.match(src, /const emu = 9525, scale = Math\.min\(1, \(6 \* 914400\) \/ \(size\.w \* emu\), \(8 \* 914400\) \/ \(size\.h \* emu\)\);/);
  assert.match(src, /<a:blip r:embed="rIdPic\$\{n\}"\/>/);
  assert.match(src, /const elsewhere = \(b, pageUrl\) => `\$\{b\.alt \|\| b\.name\} \(on the page\$\{pageUrl \? `: \$\{pageUrl\}` : ""\}\)`;/, "a piece a file cannot hold says where the page is");
  assert.match(read("webapp/run-pdf.js"), /writeInline\(doc, `\$\{piece\[1\] \|\| piece\[2\]\} \(on the page\$\{pageUrl \? `: \$\{pageUrl\}` : ""\}\)`, MARGIN, W\);/, "the PDF says it the same way");
});

test("pieces are served safely, refused when unsuited, and go with their page", () => {
  const server = read("webapp/server.js");
  const route = server.slice(server.indexOf('app.get("/page/:id/part/:name"'), server.indexOf("// GET /api/pages/:id/pdf"));
  assert.match(route, /const report = await ownReport\(req, res\);/, "only the page's own person");
  assert.match(route, /if \(!media\.namedParts\(report\.content\)\.includes\(name\)\) return res\.status\(404\)/, "only what the page names");
  assert.match(route, /"sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; default-src/);
  assert.match(route, /: "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"/, "a picture, an SVG included, can never run");
  assert.match(route, /res\.set\("X-Content-Type-Options", "nosniff"\);/);
  assert.match(route, /res\.status\(206\)\.set\("Content-Range"/, "a phone can play and seek a film");
  assert.match(server, /img-src 'self' data:; media-src 'self'; frame-src 'self'; form-action 'self'/);
  assert.match(server, /if \(!page\.formats\(report\.content\)\[kind\]\) return res\.status\(409\)/);
  assert.match(server, /return require\("\.\/run-pdf"\)\.runPdf\(page\.asRun\(report, parts, pageUrl\)\)\.pipe\(res\);/);
  assert.match(server, /res\.send\(kind === "docx" \? page\.docxBuffer\(report, parts, pageUrl\) : page\.xlsxBuffer\(report\)\);/);
  assert.match(read("webapp/run-pdf.js"), /doc\.image\(parts\[piece\[2\]\], \{ fit: \[W, 340\], align: "center" \}\);/);
  assert.match(server, /const keys = media\.namedParts\(page\.content\)\.map\(\(name\) => media\.partKey\(userId, page\.id, name\)\);/, "deleting a page deletes its pieces");
  assert.match(read("lib/page-expiry.js"), /media\.namedParts\(p\.content\)\.map\(\(name\) => media\.partKey\(p\.user_id, p\.id, name\)\)/, "and so does expiry");
  assert.match(read("closedhand-com/workers/edge/direct-routes.json"), /"\/page\/\*"/, "straight to the computer, never through the relay");
});

test("save_report puts the sandbox computer's files on the page", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const name = media\.partName\(file\.filename\);/);
  assert.match(handlers, /await supabase\.storage\.from\("attachments"\)\.upload\(media\.partKey\(userId, saved\.id, name\), buffer,/);
  assert.match(handlers, /if \(!media\.namedParts\(body\)\.includes\(name\)\) body \+= `\\n\\n!\[\]\(\$\{name\}\)`;/, "one the page forgot to place goes at the end");
  assert.match(handlers, /\.\.\.\(unplaced\.length \? \{ not_on_the_page: unplaced \} : \{\}\),/, "and the LLM hears what did not make it");
  assert.match(read("lib/tools/definitions.js"), /files: \{ type: "array", items: \{ type: "string" \}, description: "Sandbox paths of pictures, charts, films, sounds or interactive HTML for the page; put each in content on its own line: !\[caption\]\(file name\)" \}/);
});

test("a page goes into the chat as a file only when the person wants the file, and the file is not kept", () => {
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /name: "page_send_file",\n\s*groups: \["reports"\],\n\s*description: "Send one of the person's pages into this chat as a file: a PDF, a Word document, or an Excel file of its tables\. Only when they ask for the file itself or will pass it on \(to forward, print or attach\); otherwise share the page's link\. The file is not kept: the page is\.",/);
  assert.match(defs, /format: \{ type: "string", enum: \["pdf", "word", "excel"\]/);
  const handlers = read("lib/tools/handlers.js");
  const send = handlers.slice(handlers.indexOf('case "page_send_file": {'), handlers.indexOf('case "agent_report_read":'));
  assert.match(send, /\.eq\("id", id\)\.eq\("user_id", userId\)\.limit\(1\)/, "only the person's own page");
  assert.match(send, /if \(!kind \|\| !suits\[kind\]\) return \{ error: offered\.length \? `This page comes as \$\{offered\.join\(" or "\)\} only\.` :/, "never a file that does not suit the page");
  assert.match(send, /await sendDocument\(ctx\.activeChatId, buffer, filename, page\.FILE_TYPES\[kind\]\);/);
  assert.doesNotMatch(send, /saveAttachment|uploadFile/, "nothing kept");
  assert.match(read("lib/response-presentation.js"), /When they want the file itself \(to forward or print\), send it with page_send_file; never make a PDF, Word or Excel file yourself\./);
  assert.match(read("lib/engine.js"), /\[\/\^\(agent_report_\|page_send_file\$\)\/, "a run's saved result or a page: read, revise, send a page as a file"\],/);
  // The bot builds the same file the page offers, typeset in the same fonts.
  for (const name of ["report-page", "run-pdf"]) assert.equal(read(`lib/${name}.js`), read(`webapp/${name}.js`), name);
  assert.match(read("scripts/check-vendored-identical.js"), /\{ name: "run-pdf", copies: \["lib\/run-pdf\.js", "webapp\/run-pdf\.js"\] \},/);
  assert.match(read("lib/run-pdf.js"), /\[path\.join\(__dirname, "fonts"\), path\.join\(__dirname, "\.\.", "webapp", "fonts"\)\]/);
  assert.match(read(".dockerignore"), /\nwebapp\n!webapp\/fonts\n/);
  assert.match(read("package.json"), /"pdfkit": "\^0\.19\.1",/);
  const page = require("../lib/report-page");
  assert.equal(page.fileName({ title: "Saigon: packing list!", created_at: new Date("2026-10-06T08:00:00Z") }, "pdf"), "Closedhand - Saigon packing list - 2026-10-06.pdf", "the date reads as a date");
});
