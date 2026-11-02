// A web page is read the way someone reading it sees it, by one reader for
// the plain fetch and the sandbox computer's browser alike, and nothing is
// cut: a long page comes in parts. Invented pages only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readPage, partOf } = require("../lib/page-reader");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("an article on its own, its table kept as a table, the site's menus and notices gone", () => {
  const html = `<html><head><title>Ferry fares rise | Northsea News</title></head><body>
    <header><nav><a href="/">Home</a> <a href="/news">News</a></nav></header>
    <div class="cookie-banner">We use cookies. <button>Accept all</button></div>
    <main><article><h1>Ferry fares to rise from April</h1><p>Northsea Ferries will raise fares on the Hull to Rotterdam crossing from 1 April. ${"Fuel and port charges have gone up across the industry this year. ".repeat(5)}</p>
    <table><thead><tr><th>Cabin</th><th>Old fare</th><th>New fare</th></tr></thead><tbody><tr><td>Two-berth outside</td><td>£109</td><td>£124</td></tr></tbody></table>
    <p>Bookings before 15 March keep the old fare. <a href="https://northsea.example/fares">See all fares</a>.</p></article></main>
    <aside class="sidebar">Most read: ten best beaches</aside><footer>© Northsea News · Privacy</footer></body></html>`;
  const page = readPage(html);
  assert.equal(page.how, "article");
  assert.match(page.text, /\| Two-berth outside \| £109 \| £124 \|/);
  assert.match(page.text, /\[See all fares\]\(https:\/\/northsea\.example\/fares\)/);
  assert.doesNotMatch(page.text, /cookies|Most read|Privacy|Home/);
});

test("any other page whole, a restaurant's menu included, a page wrapped in a form too", () => {
  const menu = readPage(`<html><head><title>Lune</title></head><body><nav>Book · Menu</nav><div id="cookie-consent">Cookies?</div><main><h1>Our menu</h1><div class="menu"><h2>Starters</h2><ul><li>Burrata, blood orange, £9</li></ul></div></main><footer>Lune, Leeds</footer></body></html>`);
  assert.equal(menu.how, "page");
  assert.match(menu.text, /Burrata, blood orange, £9/, "a menu is content");
  assert.doesNotMatch(menu.text, /Cookies\?|Lune, Leeds/);
  const bins = readPage(`<html><body><form id="aspnetForm"><h1>Bin collection days</h1><table><tr><td>Recycling</td><td>Tuesday 10 March</td></tr></table></form></body></html>`);
  assert.match(bins.text, /\| Recycling \| Tuesday 10 March \|/, "a table with no header row is rows of cells, not HTML");
  assert.equal(readPage("plain words").text, "plain words");
});

test("a long page comes whole, in parts that say how to read on", () => {
  const long = "word ".repeat(40000);
  const first = partOf(long, 1, { readOn: "web_fetch, part" });
  assert.ok(first.parts > 1);
  assert.match(first.text, /\[Part 1 of \d+\. Read on with web_fetch, part 2\.\]$/);
  const last = partOf(long, first.parts, { readOn: "web_fetch, part" });
  assert.match(last.text, /, the last\.\]$/);
  assert.ok(partOf(long, 1, { share: 4 }).text.length < first.text.length, "pages read together share one result");
  assert.equal(partOf("short").text, "short");
});

test("the plain fetch, the read-pages tool and the browser all go through the one reader", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const page = require\("\.\.\/page-reader"\)\.readPage\(body, toolInput\.url\);/);
  assert.doesNotMatch(handlers, /page was too long|text\.substring\(0, 8000\)/, "nothing cut");
  assert.match(handlers, /partOf\(p\.text, toolInput\.part, \{ share: read\.pages\.length, readOn: "read_pages for this page, part" \}\)/);
  const engine = read("lib/browse-engine.js");
  assert.match(engine, /if \(html\) \{ const r = require\("\.\/page-reader"\)\.readPage\(html, page\.url\);/);
  assert.doesNotMatch(engine, /slice\(0, 6000\)/);
  const helper = read("sandbox-image/agent/browser_helper.py");
  assert.match(helper, /"text": page\.inner_text\("body"\), "html": page\.content\(\)\}/);
  assert.doesNotMatch(helper, /inner_text\("body"\)\[:(6000|30000)\]/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /description: "Part of a long page, from 1\.",/);
});
