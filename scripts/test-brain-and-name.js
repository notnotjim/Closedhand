// Context Brain opens on the list with readable labels; projects are named
// without em dashes; the person can say what they are called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dash = fs.readFileSync(path.join(root, 'webapp', 'views', 'dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');

test('the list is the default view and profile facts are labelled by what they are', () => {
  assert.match(dash, /var _brainViewMode = 'list';/);
  assert.match(dash, /<button onclick="switchBrainView\('list'\)" class="brain-view-btn active"/);
  const labels = dash.slice(dash.indexOf('var PROFILE_LABELS'), dash.indexOf('\n', dash.indexOf('var PROFILE_LABELS')));
  const from = dash.indexOf('function isAboutSelf(n)'), fn = dash.indexOf('function factLabel(n)');
  const box = { window: { _selfNames: ['Sam', 'Sam F-K'] } };
  vm.runInNewContext(labels + '\n' + dash.slice(from, dash.indexOf('\n    }\n', fn) + 6) + '\nthis.f = factLabel; this.self = isAboutSelf;', box);
  assert.equal(box.f({ key: 'profile-name', subject: 'Sam Fixture' }), 'Name');
  assert.equal(box.f({ key: 'profile-email', subject: 'Sam Fixture' }), 'Email');
  assert.equal(box.f({ key: 'person-mei', subject: 'Mei' }), 'Mei');
  // A note about the person filed under People is theirs: About you, by what it is about.
  assert.equal(box.f({ key: 'health-knee-surgery', subject: 'Sam Fox-Kerr', category: 'person' }), 'Health knee surgery');
  assert.equal(box.self({ subject: 'Sam Fox-Kerr' }), true, 'the surname spelled out, known by its initials');
  assert.equal(box.self({ subject: 'sam' }), true);
  assert.equal(box.self({ subject: 'Sam Lee' }), false, 'another Sam');
  assert.equal(box.self({ subject: 'Mei' }), false);
  const { isOwnName } = require('../lib/own-name');
  assert.equal(isOwnName('Sam Fox-Kerr', ['Sam', 'Sam F-K']), true);
  assert.equal(isOwnName('Sam Lee', ['Sam', 'Sam F-K']), false);
  assert.equal(isOwnName('', ['Sam']), false);
  assert.match(dash, /var gc = isAboutSelf\(gf\) \? 'profile' : gf\.category \|\| 'topic';/);
  assert.doesNotMatch(dash, /n\.accessCount === 1 \? ' time'/, "how often a fact was used is not shown (AGENTS.md, Visual system)");
});

test('a project the background pass names is saved without em dashes, and goals are not offered as projects', () => {
  const projects = fs.readFileSync(path.join(root, 'lib', 'projects.js'), 'utf8');
  assert.match(projects, /const name = cleanText\(t\.name, 80\);/);
  assert.match(projects, /A personal goal or habit the user is setting for themselves \(getting fit, learning a language\) is not a new one: those are kept as goals\./);
});

test('the name Closedhand uses can be changed in Preferences', () => {
  assert.match(dash, /<label for="preferred-name">Closedhand calls you<\/label>/);
  assert.match(dash, /fetch\('\/api\/settings\/preferred-name'/);
  assert.match(server, /app\.post\("\/api\/settings\/preferred-name"/);
  assert.match(server, /if \(!name \|\| name\.length > 40\)/);
});

test('Pin a fact and changing one happen in the panel; a Context Note opens with its summary; no stock emoji', () => {
  assert.match(dash, /<form id="fact-form" class="fact-form" hidden onsubmit="saveFact\(event\)">/);
  assert.match(dash, /function openAddPinnedNote\(\) \{ openFactForm\(null\); \}/);
  assert.match(dash, /: await fetch\('\/api\/notes\/pin', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ text: text \}\) \}\);/, 'a new fact is filed by Closedhand, as in chat');
  assert.doesNotMatch(dash, /id="fact-about"/, 'nobody has to say where it goes');
  assert.doesNotMatch(dash, /note-modal|saveNoteFromModal|editCurrentNote/, 'nothing left of the modal');
  assert.match(dash, /onclick="openBrainNode\(\\'' \+ escapeAttr\(node\._external_id \|\| node\.title\) \+ '\\'\)"/, 'opened by its id, as the server keeps it');
  assert.match(dash, /if \(preview && preview !== node\.title\) html \+= '<div class="preview-lines">'/, 'the start of the summary in the list');
  const nt = dash.indexOf('function noteText(content)');
  const notes = {};
  vm.runInNewContext(dash.slice(nt, dash.indexOf('\n    }\n', nt) + 6) + '\nthis.noteText = noteText;', notes);
  assert.equal(notes.noteText('[Thread: Trip to Hue] [5 Oct 2026]\nSam asked about [[Hue]] trains.'), 'Sam asked about Hue trains.', 'no filing header');
  assert.match(dash, /<button type="submit" class="cta" id="fact-save">Pin it<\/button>/, 'the main action, as everywhere');
  assert.match(dash, /\(about \? '<div class="preview-lines">' \+ escapeHtml\(about\.slice\(0, 600\)\) \+ '<\/div>' : ''\)/, 'a file says what it holds the way a Context Note does');
  assert.doesNotMatch(dash, /note-preview|title="You sent this"/);
  assert.match(dash, /getElementById\('brain-panel-ways'\)\.style\.display = form \? 'none' : 'flex';/, 'Edit and Delete out of the way of the form');
  const brain = dash.slice(dash.indexOf('<div class="tab-content" id="tab-brain">'), dash.indexOf('<!-- My Account:'));
  assert.doesNotMatch(brain, /&#128204;|&#128465;|&#129504;|&#128279;/, 'no stock emoji in Context Brain');
  assert.doesNotMatch(dash, /&#128465;/, 'every delete button draws the same icon');
  assert.match(dash, /var TRASH_ICON = '<svg class="ui-icon"/);
  const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');
  assert.match(server, /if \(parsed\) \{ category = category \|\| parsed\.category \|\| null; subject = subject \|\| parsed\.subject \|\| null; \}/, 'an edit keeps its group and subject');
  const tools = fs.readFileSync(path.join(root, 'lib', 'tools', 'handlers.js'), 'utf8');
  assert.match(tools, /const category = aboutThem \? "profile" : toolInput\.category/, 'a note about the person is About you');
});

test('a fact typed on the dashboard is filed as chat files one: into the fact about the same person, or as a new one in its group', async () => {
  const { fileFact } = require('../webapp/pin-fact');
  const facts = [{ key: 'family-wife-mei', value: "Sam's wife is Mei. She is Canadian.", subject: 'Mei', category: 'person' }];
  const asked = [];
  const answer = (input) => async (selected, body) => { asked.push(body); return { content: [{ type: 'tool_use', name: 'file_fact', input }] }; };
  const llm = { model: 'fast-model' };

  const joined = await fileFact("Mei's birthday is 4 March.", facts, ['Sam', 'Sam F-K'], llm,
    { request: answer({ key: 'family-wife-mei', subject: 'Mei', category: 'person', value: "Sam's wife is Mei. She is Canadian. Her birthday is 4 March." }) });
  assert.deepEqual(joined, { key: 'family-wife-mei', value: "Sam's wife is Mei. She is Canadian. Her birthday is 4 March.", subject: 'Mei', category: 'person', merged: true });
  assert.match(asked[0].messages[0].content, /family-wife-mei \| Mei \| person \| Sam's wife is Mei\. She is Canadian\./, 'the LLM sees what is pinned');
  assert.match(asked[0].messages[0].content, /They are called: Sam, Sam F-K/);
  assert.equal(asked[0].tool_choice.name, 'file_fact');

  const fresh = await fileFact('Ravi is my accountant.', facts, ['Sam'], llm,
    { request: answer({ key: 'Work Accountant Ravi', subject: 'Ravi', category: 'nonsense', value: "Ravi is Sam's accountant." }) });
  assert.deepEqual(fresh, { key: 'work-accountant-ravi', value: "Ravi is Sam's accountant.", subject: 'Ravi', category: 'topic', merged: false }, 'a new key as a label, an unknown group as topic');

  const offline = await fileFact('Ravi is my accountant.', facts, ['Sam'], null);
  assert.deepEqual(offline, { key: 'ravi-is-my-accountant', value: 'Ravi is my accountant.', subject: null, category: 'topic', merged: false }, 'no LLM: pinned as typed');
  const failed = await fileFact('Ravi is my accountant.', facts, ['Sam'], llm, { request: async () => { throw new Error('down'); } });
  assert.equal(failed.merged, false);
  assert.equal(failed.value, 'Ravi is my accountant.', 'an LLM that fails never loses what was typed');

  const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');
  assert.match(server, /const category = require\("\.\/own-name"\)\.isOwnName\(filed\.subject, names\) \? "profile" : filed\.category;/, 'about the person themself: About you');
  assert.match(server, /res\.json\(\{ success: true, key, recall: await saveFact\(userId, key, value\) \}\);/, 'changing a fact keeps its group and subject');
});
