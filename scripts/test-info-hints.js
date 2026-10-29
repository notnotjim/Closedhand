// Every "i" in Closedhand is the one from llm-hint.js: a drawn letter in a
// thin circle, opened on hover, focus or tap, written in pages as
// <span data-info="…">. Context Brain says which part is Pinned Facts and
// which Context Notes, keeps each fact its own row and each "used" tag whole,
// and shows no machinery tags. Skill tiles never cut a learned skill's name
// off, and every skill wears the one skill icon and a name that says what it
// does, so none is mistaken for the app's connection.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("one i everywhere: no other kind left in any page", () => {
  for (const page of ["webapp/views/index.html", "webapp/views/dashboard.html", "webapp/views/setup.html"]) {
    const html = read(page);
    assert.doesNotMatch(html, /class="mon-info"|class="scope-info"|&#9432;|ⓘ<|auto-tooltip|memory-info-pop/, page);
    assert.match(html, /<script src="\/llm-hint\.js"><\/script>/, page + " loads it");
  }
  const roles = read("webapp/public/model-settings.js");
  assert.match(roles, /term\.append\(window\.infoHint\(tips\[label\] \+ \(label === "Recall" && local \? LOCAL_RECALL : ""\), "About " \+ label\)\);/, "the model roles' i is the same one");
  assert.doesNotMatch(roles + read("webapp/public/model-settings.css"), /showTip|floating|tip-mark|data-tip/, "with no note of their own");
  const css = read("webapp/public/interface.css");
  assert.match(css, /\.llm-hint \{ position: relative; display: inline-block; width: 1rem; height: 1rem; margin-left: 0.375rem; border-radius: 50%; overflow: hidden; line-height: 0; vertical-align: calc\(0\.36em - 0.5rem\); align-self: center; flex: none; \}/, "centred on the capitals beside it, at any text size");
  assert.match(css, /\.info-hint-mark, \.llm-hint > \.info-hint-mark \{ display: block; box-sizing: border-box; width: 1rem; height: 1rem; min-width: 0; min-height: 0; margin: 0; padding: 0; border: 0;/, "round even where a page pads every button");
  assert.match(read("webapp/public/llm-hint.js"), /var I = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7\.3" fill="none" stroke="currentColor" stroke-width="1\.2"\/><circle cx="8" cy="4\.85" r="1\.05" fill="currentColor"\/><rect x="7\.2" y="7" width="1\.6" height="5"/, "circle and i one drawing, the i in its middle (3.8 to 12)");
  assert.match(css, /\.llm-hint-tip \{[^}]*white-space: pre-line;/, "a blank line in the text stays");
  assert.match(css, /\.info-hint-mark, \.llm-hint > \.info-hint-mark \{[^}]*color: var\(--muted\);/, "one colour, whatever the text beside it");
});

test("each i sits in the flow of the words it explains, 0.375rem after them and centred on them, never alone on a line", () => {
  // A row that spaces its items with a gap would put it 14px away and centre
  // it on the row, not the words: the words and their i are one item.
  const chat = read("webapp/views/index.html"), dash = read("webapp/views/dashboard.html");
  assert.match(chat, /<span>Sandbox computer<span data-info="[^"]*" data-info-label="About the sandbox computer"><\/span><\/span>/);
  assert.match(chat, /<span>Local computer<span data-info="[^"]*" data-info-label="About the local computer"><\/span><\/span>/);
  assert.match(dash, /<span><button class="memory-filter" data-filter="knowledge"[^>]*>Context Notes<\/button><span data-info="[^"]*" data-info-label="About Context Notes"><\/span><\/span>/);
  assert.match(dash, /<span><label for="auto-urgent-check" style="display:inline;[^"]*">Urgent<\/label><span data-info="[^"]*" data-info-label="About Urgent"><\/span><\/span>/, "inline, as the form makes labels blocks");
  assert.match(dash, /' needs reconnecting<span data-info="Not yet allowed to: ' \+ escapeHtml\(what\) \+ '" data-info-label="What it is not allowed to do yet"><\/span><\/span>'/);
  assert.doesNotMatch(chat + dash, /data-info="[^"]*"[^>]*style=/, "no colour or place of its own");
  const roles = read("webapp/public/model-settings.css");
  assert.match(roles, /\.model-role-list \{ display: grid; grid-template-columns: max-content minmax\(0,1fr\);/, "a role's name never pushes its i onto a line alone");
  assert.doesNotMatch(roles, /minmax\(8.125rem, 11.25rem\)/);
});

test("a page's data-info becomes the i where it stands, with its text as text", () => {
  const made = [];
  const node = (tag) => {
    const n = { tag, attrs: {}, children: [], className: "", textContent: "", innerHTML: "", parentNode: null,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      append(...c) { c.forEach((x) => { x.parentNode = this; this.children.push(x); }); },
      replaceWith(x) { made.push({ was: this, now: x }); },
      matches: () => false, querySelectorAll: () => [], closest: () => null };
    return n;
  };
  const old = node("span"); old.attrs["data-info"] = "Line one.\n\nLine two <b>"; old.attrs["data-info-label"] = "About it"; old.className = "mon-info-phone"; old.parentNode = {};
  const body = node("body"); body.querySelectorAll = () => [old]; body.append = () => {};
  const document = { readyState: "complete", body, documentElement: {}, createElement: node, querySelectorAll: () => [], addEventListener() {} };
  const window = { addEventListener() {}, innerWidth: 400, innerHeight: 800 };
  vm.runInNewContext(read("webapp/public/llm-hint.js"), { window, document, MutationObserver: class { observe() {} }, setTimeout });
  assert.equal(made.length, 1);
  const hint = made[0].now, mark = hint.children[0];
  assert.equal(hint.className, "llm-hint mon-info-phone", "it keeps its place's classes");
  assert.equal(mark.className, "info-hint-mark");
  assert.match(mark.innerHTML, /^<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8"/, "the circle and the i are drawn as one");
  assert.equal(mark.attrs["aria-label"], "About it");
  assert.equal(hint.llmTip.textContent, "Line one.\n\nLine two <b>", "text, never markup");
});

test("Context Brain: which is which in All, each fact its own row, no machinery tags and no use counts", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /if \(both\) html \+= '<div class="memory-group-label">Pinned Facts<\/div>';/);
  assert.match(dash, /if \(both && \(organic\.length > 0 \|\| pulseNodes\.length > 0\)\) html \+= '<div class="memory-group-label">Context Notes<\/div>';/);
  assert.match(dash, /\.pinned-note-list \{ display:grid; grid-template-columns:1fr; gap:0.375rem;/);
  assert.match(dash, /\.pinned-note-row \{[^}]*border-radius:0.375rem; background:rgba\(var\(--fg-rgb\),0\.035\);/);
  assert.doesNotMatch(dash, /access-badge|accessCount === 1 \? ' time'/, "how often a fact was used is bookkeeping, not something to act on");
  assert.match(dash, /var tags = '';/, "thread_summary and the like are never shown");
});

test("skills: a name says what it does and wraps rather than running off, never an app's logo; Intelligence Loop is gone", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /'<span class="int-name wraps" title="' \+ escHtml\(skill\.name\) \+ '">'/);
  assert.match(dash, /\(missing\.length \? 'opacity:0\.55;' : ''\) \+ '">' \+\n\s+MCP_GENERIC_ICON \+/, "the one skill icon");
  assert.doesNotMatch(dash, /getMcpLogo\(skill\.name/, "never the app's logo, which is the connection's");
  assert.match(dash, /\.int-card \.int-name\.wraps \{ white-space: normal;[^}]*-webkit-line-clamp: 2;/);
  const builtin = JSON.parse(read("webapp/public/builtin-skills.json"));
  assert.deepEqual(builtin.map((s) => s.name), ["Comment on Instagram posts", "Manage Meta ad campaigns", "Check Shopify sales and stock", "Read and post in Slack"]);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "skills", "intelligence-loop")));
  assert.match(read("lib/skill-learning.js"), /"name":"the kind of task in 2 to 5 words, starting with a verb, under 36 characters, as a tile's title/);
});
