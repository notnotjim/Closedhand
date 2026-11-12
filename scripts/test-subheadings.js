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
    for (const m of html.matchAll(/<(p|div)\s+[^>]*class="(?:lede|lead|section-desc|feat-mini-desc|mac-intro)"[^>]*>([\s\S]*?)<\/\1>/g)) {
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
