// What a form still needs is said at the field, in words, everywhere: one
// shared piece (webapp/public/needs-field.js; closedhand.com keeps the same
// copy) nudges the field and puts a note under it. A project could not be
// started without an emoji, and pressing Start project looked like nothing
// happened: the reason went to a line under the whole tab. A sweep found the
// same in thirty places, some with no word at all (an empty box and a button
// that did nothing), others in a toast or at the foot of a form.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Just enough of a page for needs-field.js: elements in a parent, with
// siblings, classes, listeners and focus.
function page() {
  let focused = null;
  const make = (tag, opts = {}) => {
    const listeners = {};
    const el = {
      tag, parent: null, children: [], classes: new Set(opts.classes || []), attrs: {}, textContent: "", focusable: !!opts.focusable, offsetWidth: 1,
      classList: { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c), contains: (c) => el.classes.has(c) },
      setAttribute: (k, v) => { el.attrs[k] = v; },
      get nextElementSibling() { const s = el.parent.children; return s[s.indexOf(el) + 1] || null; },
      insertAdjacentElement(where, node) { const s = el.parent.children; node.parent = el.parent; s.splice(s.indexOf(el) + 1, 0, node); },
      remove() { const s = el.parent.children; s.splice(s.indexOf(el), 1); },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
      fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn()),
      matches: () => el.focusable,
      querySelector: () => el.children.find((c) => c.focusable) || null,
      scrollIntoView() {}, focus() { focused = el; },
      append(...nodes) { nodes.forEach((n) => { n.parent = el; el.children.push(n); }); },
      get className() { return [...el.classes].join(" "); },
      set className(v) { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    };
    return el;
  };
  const document = { createElement: (tag) => make(tag), querySelectorAll: () => [] };
  const window = {};
  vm.runInNewContext(read("webapp/public/needs-field.js"), { window, document });
  return { make, window, focused: () => focused };
}

test("the note goes under the field, once, says what it wants, and goes when they type", () => {
  const { make, window, focused } = page();
  const form = make("form"), box = make("input", { focusable: true }), go = make("button", { focusable: true });
  form.append(box, go);
  window.needsField(box, "Give it a name.");
  const note = form.children[1];
  assert.ok(note.classes.has("field-needs"));
  assert.equal(note.textContent, "Give it a name.");
  assert.equal(note.attrs.role, "alert", "said aloud to screen readers too");
  assert.ok(box.classes.has("needs-nudge"));
  assert.equal(focused(), box);
  window.needsField(box, "Choose one emoji for it.");
  assert.equal(form.children.length, 3, "pressed again: the same note, never a second");
  assert.equal(form.children[1].textContent, "Choose one emoji for it.");
  box.fire("input");
  assert.deepEqual(form.children, [box, go], "typing takes it away");
});

test("a row (a box and its button) takes the note under it, and its box, or the one named, takes focus", () => {
  const { make, window, focused } = page();
  const card = make("div"), row = make("div"), pick = make("select", { focusable: true }), key = make("input", { focusable: true });
  card.append(row); row.append(pick, key);
  window.needsField(row, "Paste a key or a client ID first.");
  assert.equal(card.children[1].textContent, "Paste a key or a client ID first.", "under the row, not inside it");
  assert.equal(focused(), pick);
  window.needsField(row, "Paste a key or a client ID first.", key);
  assert.equal(focused(), key);
  row.fire("change");
  assert.equal(card.children.length, 1, "choosing takes it away as typing does");
});

test("one shared piece, on every page with a form; the dashboard keeps no copy of its own", () => {
  const dashboard = read("webapp/views/dashboard.html");
  assert.doesNotMatch(dashboard, /function needsField\(/);
  assert.match(dashboard, /<script src="\/needs-field\.js"><\/script>/);
  assert.match(read("webapp/views/setup.html"), /<script src="\/needs-field\.js"><\/script>/);
  assert.match(read("webapp/projects.js"), /<script src="\/needs-field\.js"><\/script><script src="\/project-context\.js" defer><\/script>/, "the project page's notes too");
  assert.match(read("webapp/public/interface.css"), /\.field-needs \{/);
});

test("projects, goals, notes and replies say what is missing at the field", () => {
  const projects = read("webapp/public/projects.js");
  assert.match(projects, /if \(!pick\.value\) return window\.needsField\(row, "Choose another project to merge into this one\."\);/);
  assert.match(projects, /if \(goal && goal\.missing\(\)\) return;/, "a goal half written is asked for, not dropped");
  const goals = read("webapp/public/goals.js");
  assert.match(goals, /if \(!input\.value\.trim\(\)\) return window\.needsField\(add, "Write the step first\."\);/);
  assert.match(goals, /if \(!chosen\.size\) return window\.needsField\(days, "Pick at least one day\."\);/, "Save with no day asks for one; Turn off is how check-ins stop");
  assert.match(goals, /window\.needsField\(title, "Write the goal first\."\);/);
  assert.match(read("webapp/public/project-context.js"), /if \(!body\.value\.trim\(\)\) return window\.needsField\(body, "Write the note first\."\);/);
  const email = read("webapp/public/assistant-email.js");
  assert.match(email, /if \(!purpose\.value\.trim\(\)\) return window\.needsField\(purpose, missing\);/);
  assert.match(email, /catch \(e\) \{ if \(\/people\|address\/i\.test\(e\.message\)\) return window\.needsField\(people, e\.message\); throw e; \}/);
});

test("the dashboard's forms say it at the field, never only in a toast or at the foot", () => {
  const d = read("webapp/views/dashboard.html");
  for (const [what, re] of [
    ["Connect anything", /if \(!input\) return needsField\(box\.closest\('\.mcp-pill'\), 'Paste an MCP server, skill or API key\.'\);/],
    ["a server's key", /return needsField\(keyBox\.parentElement, 'Paste a key or a client ID first\.', keyBox\);/],
    ["a connection's values", /if\(empty\)return needsField\(empty\.input,'Fill this in to connect\.'\);/],
    ["which service a key is for", /else needsField\(input, 'Say which service the key is for\.'\);/],
    ["a skill that is not there", /if \(res\.status < 500 && data\.error\) needsField\(document\.getElementById\('mcp-url-input'\)\.closest\('\.mcp-pill'\), data\.error\);/],
    ["a preference", /return needsField\(input\.parentElement, 'Write the preference first\.', input\);/],
    ["the name Closedhand calls them", /if \(!name\) return needsField\(el\.parentElement, 'Type the name you want to be called\.', el\);/],
    ["Bridge's code", /return needsField\(codeBox\.parentElement, 'Enter the 6-character code from Closedhand Bridge\.', codeBox\);/],
    ["the payment's box", /return needsField\(document\.getElementById\("my-agree"\), "Tick the box first: this payment starts straight away\.", agree\);/],
    ["a price", /return needsField\(wrong\.closest\('\.usage-price-row'\), 'Prices are per million tokens, from 0 to 1000\.', wrong\);/],
    ["the spending currency", /return needsField\(document\.getElementById\('sl-currency'\), 'Choose the currency\.'\);/],
    ["an address", /if \(data\.field\) return needsField\(document\.getElementById\('wa-' \+ data\.field\), data\.error\);/],
    ["a card", /if \(data\.field\) return needsField\(document\.getElementById\('wc-' \+ data\.field\), data\.error\);/],
    ["a chat app's key", /return needsField\(document\.getElementById\('chat-app-' \+ empty\.key\), 'Paste the '/],
    ["a note to an agent", /if \(!note\) return needsField\(area, 'Write what to tell it\.'\);/],
    ["a name already used", /if \(res\.status === 409\) \{ if \(_openTok !== 'name'\) openToken\('name'\); return needsField\(document\.getElementById\('auto-name-input'\), data\.error\); \}/],
    ["where results go", /return needsField\(document\.getElementById\('plan-where'\), 'Turn on '/],
  ]) assert.match(d, re, what);
  assert.doesNotMatch(d, /showToast\('Paste a key or a client ID first'|showToast\('Type the name you want to be called'|showToast\('Enter the 6-character code|showToast\("Tick the box first/);
  // An action that can't be undone waits for its word, in any case, and says
  // what to type when pressed early instead of ignoring the press.
  assert.match(d, /const CONFIRM_WORDS = \{ "clear-data": "WIPE", "delete-account": "DELETE", "plus-cancel": "CANCEL" \};/);
  assert.match(d, /needsField\(input\.parentElement, "Type " \+ word \+ " to confirm\.", input\);/);
  assert.match(d, /if \(!anyway && !confirmTyped\(action\)\) return;/);
  assert.match(d, /if \(cancel && !confirmTyped\("plus-cancel"\)\) return;/);
  const go = d.slice(d.indexOf("    .confirm-go {"), d.indexOf("    .confirm-go-danger {"));
  assert.doesNotMatch(go, /pointer-events/, "a dim button still answers a press");
});

test("the server names the field a refusal is about, in words people use", () => {
  const server = read("webapp/server.js");
  assert.match(server, /if \(!a\.name\) return \{ error: "Enter the name\.", field: "name" \};/);
  assert.match(server, /if \(bad\) return res\.status\(400\)\.json\(\{ error: bad, field \}\);/);
  assert.match(server, /error: "That card number does not look right\.", field: "number"/);
  assert.match(server, /if \(!v\) return res\.status\(400\)\.json\(\{ error: "Paste every key the app needs\.", field: k \}\);/, "never the setting's own name");
  assert.doesNotMatch(server, /is missing\.` \}/);
  assert.doesNotMatch(server, /error: "URL required"|error: "Empty file"|error: "An automation with that name already exists"/);
  const projects = read("webapp/projects.js");
  assert.match(projects, /if \(!emoji\) return fail\(res, needs\("emoji", "Choose one emoji for it\."\), 400\);/);
});

test("setup, model settings, the Terms box and closedhand.com say it the same way", () => {
  const setup = read("webapp/views/setup.html");
  assert.match(setup, /if \(gStep === 1 && !\$\("#g-project"\)\.value\.trim\(\)\) return needsField\(\$\("#g-project"\), "Paste the Project ID here first\."\);/, "Next answers, rather than sitting disabled");
  assert.doesNotMatch(setup, /next\.disabled = gStep === 1/);
  assert.match(setup, /if \(!id \|\| !secret\) return needsField\(\$\(id \? "#m-client-secret" : "#m-client-id"\), /);
  assert.match(setup, /if \(!\$\("#tg-token"\)\.value\.trim\(\)\) return needsField\(\$\("#tg-token"\), "Paste the token BotFather sent\."\);/);
  assert.match(setup, /if \(!\$\("#bring-url"\)\.value\.trim\(\)\) return needsField\(\$\("#bring-url"\), BRING_URL\);/);
  const models = read("webapp/public/model-settings.js");
  assert.match(models, /function stillMissing\(kind\) \{/);
  assert.match(models, /if \(missing && window\.needsField\) window\.needsField\(missing\.field, missing\.text\);/);
  // The Terms box's own glow and helper line were a second look for the same job.
  const claim = read("webapp/public/account-number-claim.js");
  assert.match(claim, /root\.needsField\(row, text \|\| 'Tick to agree to the Terms first\.', row\.querySelector\('input\[type=checkbox\]'\)\);/);
  for (const f of ["webapp/public/interface.css", "webapp/views/dashboard.html", "webapp/views/setup.html", "webapp/public/setup-personal-url.js"]) assert.doesNotMatch(read(f), /terms-nudge|is-nudged/, f);
  assert.equal(read("closedhand-com/public/needs-field.js"), read("webapp/public/needs-field.js"), "closedhand.com keeps the same copy");
  assert.match(read("closedhand-com/public/interface.css"), /\.field-needs \{/);
  assert.match(read("closedhand-com/public/message-us.js"), /if \(!message\) return window\.needsField\(text, 'Write your message first\.'\);/);
  assert.match(read("closedhand-com/public/account.js"), /needsField\(\$\('agree'\), 'Tick the box first: this payment starts straight away\.'\)/);
});
