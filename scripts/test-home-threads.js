// The web chat has Chat, one general conversation, and each project's own,
// picked in the sidebar or under the home page's box. A message carries on
// the one that is open; nothing is split into threads by hand.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('the home page box carries on Chat, or the project that is open; older ones are picked under it', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /startFresh|\/api\/threads|startNewThread|switchToThread/, 'no new thread from the home page, and no threads to switch');
  assert.match(page, /if \(_openProject\) payload\.project = _openProject\.id;/, 'a message sent in a project is in it');
  assert.doesNotMatch(page, /heroContinuing|_homeContinue|Start fresh|drawEarlierMessages/, 'no "Continuing" line or quiet-hours carry-on');
  assert.doesNotMatch(page, /Pick up where you left off|hero-recent|hero-chip/, 'no drawer, pill or chips: the box carries on Chat');
  assert.match(page, /'<span class="hero-projects-label">or pick up a project<\/span>'/, 'the projects, under the box');
  assert.match(page, /var projects = \(data\.projects \|\| \[\]\)\.slice\(\)\.sort\(/, 'most recent first');
  assert.match(page, /openConversation\(b\.getAttribute\('data-conv'\)\);/);
  assert.match(page, /: _openProject && document\.body\.classList\.contains\('chat-active'\) \? 'Message ' \+ _openProject\.emoji \+ ' ' \+ _openProject\.name/, 'the box says which project it writes to');
  const conv = fs.readFileSync(path.join(root, 'lib', 'conversation.js'), 'utf8');
  assert.match(conv, /if \(!asked\.length && conversation\.filter\(m => m\.role === "user"\)\.length < 3\) return;/);
  const ws = fs.readFileSync(path.join(root, 'lib', 'web-chat-ws.js'), 'utf8');
  assert.match(ws, /const project = typeof msg\.project === "string" && \/\^\[0-9a-f-\]\{36\}\$\/i\.test\(msg\.project\) \? msg\.project : null;/);
});

test("a project's conversation and its card on the dashboard lead to each other", () => {
  const fs = require("fs"), path = require("path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const projects = read("webapp/public/projects.js");
  assert.match(projects, /btn\("goal-small", "Open conversation", \(\) => \{ window\.parent\.openConversation\(p\.id\); if \(window\.parent\.closeDashSlide\) window\.parent\.closeDashSlide\(\); \}\)/, "the card opens its conversation in the web chat");
  assert.match(projects, /location\.hash\.match\(\/\^#projects\\\/\(\[0-9a-f-\]\{36\}\)\(\\\/edit\)\?\$\/i\)/, "and #projects/<id> opens the tab at that card, /edit its form");
  assert.match(read("webapp/views/dashboard.html"), /\} else if \(\/\^projects\\\/\[0-9a-f-\]\{36\}\(\\\/edit\)\?\$\/i\.test\(resolved\)\) \{\n\s+\/\/ One project[^\n]*\n[^\n]*\n\s+switchTab\('projects'\);/);
  const chat = read("webapp/views/index.html");
  assert.match(chat, /window\.openDashSlide\('#projects\/' \+ _openProject\.id\)/, "the name above a project's conversation opens it on the dashboard");
  assert.match(chat, /head\.textContent = _openProject\.emoji \+ ' ' \+ _openProject\.name;/);
  assert.doesNotMatch(chat, /if \(projectId && !found && _conversations\) return;/, "a project made a moment ago still opens");
});
