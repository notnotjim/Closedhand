// The line under a heading says what the page or section is for in one short
// sentence, never a paragraph (AGENTS.md, Visual system): people read it at a
// glance, and anything longer belongs in the body below it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "..");
const LONGEST = 115;
const pages = ["closedhand-com/views", "webapp/views"].flatMap((dir) =>
  fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".html")).map((f) => path.join(dir, f)));
const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "x").replace(/\s+/g, " ").trim();

test("every line under a heading is one short sentence", () => {
  const long = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    for (const m of html.matchAll(/<(p|div)\s+[^>]*class="(?:lede|lead|section-desc|feat-mini-desc|mac-intro)(?: [a-z-]+)*"[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = plain(m[2]);
      if (text.length > LONGEST) long.push(`${page}: ${text.length} characters: ${text.slice(0, 80)}…`);
    }
  }
  assert.deepEqual(long, [], "too long for the line under a heading");
});

test("a page's lines set by its script are short too", () => {
  const confirm = fs.readFileSync(path.join(root, "closedhand-com/public/assistant-email-confirm.js"), "utf8");
  const line = /\$\('lede'\)\.textContent = ('[^']*' \+ name \+ '[^']*')/.exec(confirm);
  assert.ok(line && line[1].length - 18 <= LONGEST);
});

// The line under a page's heading is Fraunces at the size it is read, upright
// and regular, one shared piece on the site and in the app; a plain sans there
// read as basic beside the heading.
test("the line under a page's heading is the heading's typeface, set for reading", () => {
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const rule = ".ch-lede { font-family: var(--font-brand); font-weight: 400; font-variation-settings: 'SOFT' 30; }";
  for (const css of ["closedhand-com/public/interface.css", "webapp/public/interface.css"]) assert.ok(read(css).includes(rule), css);
  const wrong = [];
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/<(?:p|div)\s+[^>]*class="((?:lede|lead|hero-heading-sub)\b[^"]*)"/g)) {
      if (!/\bch-lede\b/.test(m[1])) wrong.push(page + ": " + m[1]);
    }
    if (/\bch-lede\b/.test(html) && /family=Fraunces:[^"&]*wght,SOFT@9\.\.144,500,/.test(html)) wrong.push(page + ": fetches no regular weight");
  }
  assert.deepEqual(wrong, []);
  assert.match(read("closedhand-com/views/home.html"), /<div class="hero-heading-sub ch-lede">Uncensored personal AI, with no company in between<\/div>/);
  // The app's own pages title in the sans (interface.css), so their lines stay in it.
  assert.match(read("webapp/views/setup.html"), /<h1>Bring Closedhand <em>to life<\/em><\/h1>\n\s+<p data-railway=/);
});

