// The dashboard and web chat details from the walkthrough, each held in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dash = read('webapp/views/dashboard.html'), page = read('webapp/views/index.html'), server = read('webapp/server.js');

test('phones: the tab row says it scrolls, and pages keep a side margin', () => {
  assert.match(dash, /\.tab-bar\.more-right \{ -webkit-mask-image/);
  assert.match(dash, /bar\.classList\.toggle\('more-right', bar\.scrollLeft \+ bar\.clientWidth < bar\.scrollWidth - 4\)/);
  assert.match(dash, /@media \(max-width: 600px\) \{\n\s*\.dashboard-container \{ padding-left: 1rem !important; padding-right: 1rem !important; \}/);
});

test('a skill whose service is not connected says what it needs', () => {
  assert.match(dash, /'<span class="int-tag" title="Connect it below to use this skill">Needs ' \+ escHtml\(missingNames\.join\(' and '\)\)/);
  assert.match(dash, /if \(typeof renderConnectedSkills === 'function' && typeof _builtinSkills !== 'undefined' && _builtinSkills\.length\) renderConnectedSkills\(\);/);
});

test('the Computers tab does not call this computer offline', () => {
  assert.match(page, /var BRIDGE_PITCH = 'Closedhand Bridge gives your assistant access to the Mac it runs on, only to the files and apps you allow\.';/);
  assert.match(page, /<span id="monLocalStatusText">Not connected<\/span>/);
  assert.doesNotMatch(page, /Mac running Docker/);
});

test('usage shows a cost from public prices, or ones the person sets', () => {
  assert.match(server, /app\.post\("\/api\/usage\/prices"/);
  assert.match(server, /res\.json\(\{ days, rows, prices: \(prof && prof\.settings && prof\.settings\.model_prices\) \|\| \{\}, listed \}\);/);
  assert.match(dash, /function usageCost\(rows\)/);
  assert.doesNotMatch(dash, /Add your provider's prices below to see it\./, 'nothing to fill in first');
});

test('wallet currency starts from the browser region', () => {
  const start = dash.indexOf('var REGION_CURRENCY'); const end = dash.indexOf('    function updateSpendCurrency');
  const box = { navigator: { languages: ['en-GB', 'en'] } };
  vm.runInNewContext(dash.slice(start, end) + '\nthis.f = defaultCurrency;', box);
  assert.equal(box.f(), 'GBP');
  box.navigator = { languages: ['fr'] };
  assert.equal(box.f(), 'USD');
});

test('a bare /dashboard opens the dashboard, and a missing page has a way back', () => {
  assert.match(dash, /window\.location\.replace\("\/\?dash=" \+ encodeURIComponent\(inner \|\| "#connections"\)\);/);
  assert.match(read('webapp/report-page.js'), /function missingHtml\(\)/);
  assert.match(server, /res\.status\(404\)\.send\(assets\.withAppearance\(require\("\.\/report-page"\)\.missingHtml\(\)\)\);/);
});

test('goals, file search, progress lines, today and the Google card', () => {
  const goals = read('webapp/public/goals.js');
  // A goal is added from its project, asking what to achieve and how.
  assert.match(goals, /title\.placeholder = "What do you want to achieve\?"/);
  assert.match(goals, /title\.placeholder = h \? "What do you want to do regularly\?" : "What do you want to achieve\?";/);
  assert.match(page, /It recalls by meaning, not just keywords/);
  // One way to add any source, the same for every one: no Google-only shortcut.
  assert.doesNotMatch(page, /ragQuickDrive|Search your Google Drive/);
  const menu = page.slice(page.indexOf('async function ragAddSource() {'), page.indexOf('// Closedhand section', page.indexOf('async function ragAddSource() {')));
  assert.match(menu, /html \+= ready \+ offer;/, 'connected storage sorts above what can still be connected');
  assert.doesNotMatch(menu, /\bhtml \+= '<div class="rag-browse-item"/, 'every storage row goes to one of the two lists');
  assert.match(page, /\+ 'Local computer<\/div>';/, 'named as on the Computers tab');
  // Taking a whole drive or folder is File Search's add button, the same on
  // every drive, and says what it takes; the count it showed was only the
  // files at that level, while the whole tree is read.
  assert.match(page, /var addLabel = isAtRoot \? 'Add all of ' \+ \(origin === 'cloud' \? 'the sandbox computer' : label\) : 'Add this whole folder';/);
  assert.match(page, /html \+= '<button type="button" class="rag-upload-btn rag-browse-add" onclick="ragConnectSource\(/);
  assert.match(page, /addEl\.textContent = '\+ Add ' \+ count \+ ' selected file' \+ \(count === 1 \? '' : 's'\);/);
  assert.doesNotMatch(page, /indexable file|'Index all '/);
  assert.match(page, /#ragSelectActions \{ position:sticky; bottom:-1rem;/, 'adding the ticked files stays in view');
  // A source interrupted mid-read resumes with the files picked and the account chosen.
  const server = read('webapp/server.js');
  assert.match(server, /select\("id, user_id, origin, path, selected_files, account"\)\.eq\("status", "indexing"\)/);
  assert.match(server, /processSource\(src\.id, src\.user_id, src\.origin, src\.path, src\.selected_files \|\| null, src\.account \|\| null\)/);
  const defs = require('../lib/tools/definitions');
  const tool = (n) => defs.INTERNAL_TOOLS.find((t) => t.name === n);
  assert.equal(tool('web_fetch').activityDescription({ url: 'https://nominatim.openstreetmap.org/search' }), 'Looking at the map');
  assert.equal(tool('api_request').activityDescription({ url: 'https://router.project-osrm.org/route', method: 'GET' }), 'Working out the route');
  assert.equal(tool('web_fetch').activityDescription({ url: 'https://www.example.org/a' }), 'Reading www.example.org');
  assert.match(dash, /const listsAccounts = c\.service === "google" \|\| c\.service === "microsoft";/);
});

test('every page asks the same way before something it cannot undo, never with a browser pop-up', () => {
  const views = fs.readdirSync(path.join(root, 'webapp/views')).map((f) => 'webapp/views/' + f);
  const scripts = fs.readdirSync(path.join(root, 'webapp/public')).filter((f) => f.endsWith('.js')).map((f) => 'webapp/public/' + f);
  for (const file of views.concat(scripts)) {
    assert.doesNotMatch(read(file).replace(/^\s*\/\/.*$/gm, ''), /(^|[^.\w])(alert|confirm|prompt)\(/m, file + ' uses a browser pop-up');
  }
  for (const view of ['dashboard', 'index', 'setup']) assert.match(read('webapp/views/' + view + '.html'), /<script src="\/ask\.js"><\/script>/, view + ' loads the shared question');
  assert.doesNotMatch(dash, /id="disconnect-modal"|askDisconnect|agent-del-confirm|dataset\.confirm/, 'no second kind of question');

  // The question takes the button's place, says Cancel, and puts the button back.
  const made = [];
  const node = (tag) => {
    const el = { tag, children: [], style: {}, className: '', textContent: '', listeners: {}, parentElement: null,
      setAttribute() {}, appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? { textContent: c } : c)); },
      addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {},
      replaceWith(other) { const p = this.parentElement; p.children[p.children.indexOf(this)] = other; other.parentElement = p; } };
    made.push(el); return el;
  };
  const row = node('div'), button = node('button');
  row.appendChild(button);
  const ctx = { window: {}, document: { createElement: node, createTextNode: (t) => ({ textContent: t }) }, getComputedStyle: () => ({ display: 'flex' }) };
  vm.runInNewContext(read('webapp/public/ask.js'), ctx);
  const ask = (opts) => { const p = ctx.window.askFirst(button, opts); return { p, box: row.children[0] }; };
  return (async () => {
    let { p, box } = ask({ text: 'Delete this file for good?', yes: 'Delete' });
    assert.equal(box.className, 'ask');
    assert.equal(row.style.flexWrap, 'wrap', 'the question takes a line of its own');
    const buttons = box.children.find((c) => c.className === 'ask-actions').children;
    assert.deepEqual(buttons.map((b) => b.textContent), ['Delete', 'Cancel']);
    buttons[1].listeners.click();
    assert.equal(await p, false);
    assert.equal(row.children[0], button, 'Cancel puts the button back');
    ({ p, box } = ask({ text: 'Disconnect?', yes: 'Disconnect', check: 'Also delete what it kept' }));
    box.children.find((c) => c.className === 'ask-check').children[0].checked = true;
    box.children.find((c) => c.className === 'ask-actions').children[0].listeners.click();
    assert.deepEqual({ ...(await p) }, { checked: true });
    ({ p, box } = ask({ text: 'Archive or delete?', yes: 'Delete forever', other: 'Archive' }));
    const three = box.children.find((c) => c.className === 'ask-actions').children;
    assert.deepEqual(three.map((b) => b.textContent), ['Delete forever', 'Archive', 'Cancel']);
    three[1].listeners.click();
    assert.deepEqual({ ...(await p) }, { other: true });
  })();
});

test('Copy to the local computer puts the file in the folder open on that side, as a drag does', () => {
  assert.match(page, /<\/svg>Copy to the local computer<\/button>/);
  assert.doesNotMatch(page, />Copy to Local</);
  const fn = page.slice(page.indexOf('  async function monCopyLocal(p){'), page.indexOf('\n  }', page.indexOf('  async function monCopyLocal(p){')));
  assert.match(fn, /fetch\('\/api\/sandbox\/copy-to-local',\{method:'POST',headers:\{'Content-Type':'application\/json'\},body:JSON\.stringify\(\{sourcePath:p,destPath:folder\+'\/'\+name\}\)\}\)/);
  assert.match(fn, /var folder=_monLocalPath\.replace\(\/\\\/\$\/,''\)\|\|'~';/);
  assert.match(fn, /if\(state\.status!=='connected'\)\{chatNotice\('Connect a Mac on the Local computer side first\.',true\);return;\}/);
  assert.match(fn, /turn on Computer Control in /, 'says which switch lets it write on the Mac');
  assert.doesNotMatch(fn, /createObjectURL|a\.download/, 'Download is its own menu item');
});

// Nothing appears unasked: no milestone messages ("Power user unlocked"),
// no hidden mode behind a key sequence, and one confetti, the same every
// time, on every day and on every page that has it.
test("one confetti and no milestones or hidden modes", () => {
  const delight = read("webapp/public/delight.js");
  assert.doesNotMatch(delight, /checkMilestones|Power user|First connection made|Resistance|KONAMI|_getSeasonalConfig|Math\.random/);
  assert.doesNotMatch(read("webapp/public/delight.css"), /resistance-mode/);
  const dash = read("webapp/views/dashboard.html");
  assert.doesNotMatch(dash, /checkMilestones/);
  assert.match(dash, /function miniCelebration\(\) \{\n\s+if \(window\.Delight\) Delight\.confetti\(\);\n\s+\}/);
  assert.match(delight, /particleCount: 90,\n\s+angle: 90,\n\s+spread: 65,\n\s+origin: \{ x: 0\.5, y: 0\.7 \},\n\s+colors: \["var\(--accent\)", "var\(--accent\)", "var\(--warn\)", "var\(--accent\)", "var\(--slate\)", "var\(--accent\)"\],/);
  const page = read("webapp/views/index.html");
  assert.match(page, /window\.confetti\(\{ particleCount: 90, angle: 90, spread: 65, origin: \{ x: 0\.5, y: 0\.7 \}, colors: \[col\('--accent'\), col\('--accent'\), col\('--warn'\), col\('--accent'\), col\('--slate'\), col\('--accent'\)\], disableForReducedMotion: true \}\);/, "the web chat's matches the dashboard's");
  assert.equal((page.match(/window\.confetti\(/g) || []).length, 1);
});
