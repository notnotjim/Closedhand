// Setup's hello: the counts it shows climbing, the three text effects it is
// made of, and where it hands the person on to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('webapp/server.js');

function helloRoute(records, conf = {}) {
  let handler;
  const db = { from(table) {
    const filters = []; let counting = false;
    const rows = () => (records[table] || []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const q = {
      select(cols, opts) { counting = !!(opts && opts.count); return q; },
      eq(k, v) { filters.push([k, v]); return q; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      then(resolve, reject) { return Promise.resolve(counting ? { count: rows().length, error: null } : { data: rows(), error: null }).then(resolve, reject); },
    };
    return q;
  } };
  const start = server.indexOf('app.get("/api/setup/hello",');
  const end = server.indexOf('\napp.', start + 1);
  vm.runInNewContext(server.slice(start, end), { app: { get(name, fn) { handler = fn; } }, supabase: db,
    requireSetupAccess: async () => true, getAdminUserId: () => 'owner', getRuntimeConf: async (k) => conf[k] });
  const res = { code: 200, set() { return this; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; } };
  return handler({}, res).then(() => res);
}

test('the hello counts what has been read so far, for its owner only', async () => {
  const row = (user_id, source, type) => ({ user_id, source, type });
  const res = await helloRoute({
    facts: [{ user_id: 'owner', key: 'profile-name', value: 'Mira Okafor' }],
    data_cache: [row('owner', 'gmail', 'email'), row('owner', 'outlook', 'email'), row('owner', 'gcal', 'event'),
      row('owner', 'whatsapp', 'message'), row('owner', 'whatsapp', 'message'), row('owner', 'slack', 'message'),
      row('other', 'gmail', 'email'), row('other', 'whatsapp', 'message')],
    connections: [{ user_id: 'owner', service: 'whatsapp_linked', metadata: { linked: true, welcome: { sentAt: '2026-10-24T12:00:00Z' } } }],
  }, { PHONE_PERMANENT_URL: 'https://amber-lake-12.closedhand.ai' });
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), {
    name: 'Mira', read: { mail: 2, events: 1, whatsapp: 2 }, url: 'https://amber-lake-12.closedhand.ai',
    whatsapp: { linked: true, sent: true },
  });
});

test('the hello greets them by the name they chose, as Settings does, then a Pinned Fact, then their sign-in', async () => {
  const chosen = await helloRoute({ profiles: [{ id: 'owner', display_name: 'Mira Okafor', settings: { preferred_name: 'Mimi' } }], facts: [{ user_id: 'owner', key: 'profile-name', value: 'Mira Okafor' }] });
  assert.equal(chosen.body.name, 'Mimi');
  const signedIn = await helloRoute({ profiles: [{ id: 'owner', display_name: 'Mira Okafor', settings: {} }] });
  assert.equal(signedIn.body.name, 'Mira', 'no Pinned Fact yet: the first name of the sign-in');
  const setup = read('webapp/views/setup.html');
  assert.match(setup, /var name = latest && latest\.name, greeting = name \? "Hi " \+ name : "Hello";/);
  assert.match(setup, /line\.append\("I've learned from "\);/);
  assert.match(setup, /\$\("#hello-url-link"\)\.href = latest\.url\.replace\(\/\\\/\$\/, ""\) \+ "\/dashboard";/, 'the address opens the dashboard');
  assert.match(setup, /appLink\(go, "WhatsApp", "\/logos\/whatsapp\.svg"\)/);
  assert.match(setup, /appLink\(go, "Telegram", "\/logos\/telegram\.svg"\)/);
  const css = read('webapp/public/welcome.css');
  assert.match(css, /@keyframes hello-breathe \{ 0%, 100% \{ transform: scale\(1\); \} 50% \{ transform: scale\(1\.06\); \} \}/, 'it breathes by size, never fading grey');
});

test('before anything is read or linked, the hello still answers', async () => {
  const res = await helloRoute({});
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { name: null, read: { mail: 0, events: 0, whatsapp: 0 }, url: null, whatsapp: { linked: false, sent: false } });
});

function motion(still) {
  const ctx = { setTimeout, clearTimeout, Promise, Intl, Math, performance: { now: () => Date.now() },
    matchMedia: () => ({ matches: still }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 1), cancelAnimationFrame: clearTimeout };
  ctx.window = ctx;
  vm.runInNewContext(read('webapp/public/text-motion.js'), ctx);
  return ctx.TextMotion;
}
const format = (n) => new Intl.NumberFormat().format(n);

test('with reduced motion, each effect shows its final text at once', async () => {
  const M = motion(true), el = { textContent: '' };
  await M.type(el, 'Hello, Mira.');
  assert.equal(el.textContent, 'Hello, Mira.');
  M.tick(el, 1284);
  assert.equal(el.textContent, format(1284));
  await M.unscramble(el, 'amber-lake-12.closedhand.ai');
  assert.equal(el.textContent, 'amber-lake-12.closedhand.ai');
});

test('typing lands on the exact words, and skipping finishes it at once', async () => {
  const M = motion(false), el = { textContent: '' };
  await M.type(el, 'Hello', { speed: 1 });
  assert.equal(el.textContent, 'Hello');
  let skip = false;
  const typing = M.type(el, ', Mira.', { speed: 50, skip: () => skip });
  skip = true;
  await typing;
  assert.equal(el.textContent, ', Mira.');
});

test('a count climbs to its number and carries on from where it got to', async () => {
  const M = motion(false), el = { textContent: '' };
  M.tick(el, 900, { duration: 20 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(el.textContent, format(900));
  M.tick(el, 1284, { duration: 20 });
  assert.ok(el._motionValue >= 900, 'starts from what it shows');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(el.textContent, format(1284));
});

test('an address settles out of scrambled characters with its dots and dashes in place', async () => {
  const M = motion(false), el = { textContent: '' }, host = 'amber-lake-12.closedhand.ai';
  const settling = M.unscramble(el, host, { duration: 30 });
  assert.equal(el.textContent.length, host.length);
  for (const i of [5, 10, 13, 24]) assert.equal(el.textContent[i], host[i]);
  await settling;
  assert.equal(el.textContent, host);
});

test('the hello plays once every step is done or skipped, and hands on to where the person will talk', () => {
  const setup = read('webapp/views/setup.html');
  assert.match(setup, /var complete = requiredDone && steps\.every\(function \(s\) \{ return s\.done \|\| !!skips\[s\.key\]; \}\);/);
  assert.match(setup, /if \(lastComplete === false && complete && !finishedBefore && !celebrated\(\)\) celebrate\(\);/, "never again once setup was finished, on any address");
  // A linked chat app is where the conversation already is; with none, the
  // answer goes to the web chat, carried in this tab and never in the address.
  assert.match(setup, /go\.href = "https:\/\/wa\.me\/" \+ num;/);
  assert.match(setup, /go\.href = "https:\/\/t\.me\/" \+ st\.botUsername \+ "\?start=hello";/);
  assert.match(setup, /sessionStorage\.setItem\("ch-first-words", words\)/);
  assert.match(read('webapp/views/index.html'), /firstWords = sessionStorage\.getItem\('ch-first-words'\); sessionStorage\.removeItem\('ch-first-words'\);/);
  assert.match(setup, /<script src="\/text-motion\.js"><\/script>/);
  // The phone is one scan away: a code of the personal URL, on computers only.
  assert.match(setup, /\$\("#hello-qr"\)\.src = "\/api\/setup\/qr\?target=phone";\n\s+show\(\$\("#hello-phone"\)\);/);
  assert.match(read('webapp/public/welcome.css'), /@media \(hover: hover\) and \(pointer: fine\) \{ \.hello-phone:not\(\[hidden\]\) \{ display: flex; \} \}/);
  assert.match(server, /if \(target === "phone"\) \{\n\s+const personal = String\(\(await getRuntimeConf\("PHONE_PERMANENT_URL"\)\) \|\| ""\)/);
  assert.match(server, /url = personal \+ "\/dashboard";/, 'the code opens the dashboard, as the line above it says');
  assert.match(setup, />Reach your dashboard from any device at </);
});

test('the dashboard tour runs once for each person, the first time the dashboard is opened plainly', () => {
  const dashboard = read('webapp/views/dashboard.html');
  assert.match(dashboard, /const tabOnly = \/\^#\?\(connections\|tasks\|projects\|pages\|brain\|settings\)\?\$\/\.test\(window\.location\.hash\);\n\s+if \(tabOnly && !inAccountPopup\(\) && !data\.toured\) \{\n\s+fetch\('\/api\/settings\/toured', \{ method: 'POST' \}\)/, "the first time, opened on any tab");
  const steps = [...dashboard.slice(dashboard.indexOf("const welcomeSteps = ["), dashboard.indexOf("];", dashboard.indexOf("const welcomeSteps = ["))).matchAll(/tab: '([a-z]+)'/g)].map((m) => m[1]);
  const tabs = [...dashboard.matchAll(/<button class="tab[^"]*" data-tab="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(steps, tabs, "every tab, left to right");
  assert.match(dashboard, /tab: 'connections', text: 'Your connected apps and skills live here\./);
  assert.match(fs.readFileSync(require.resolve("../webapp/public/welcome.css"), "utf8"), /:root\[data-theme="light"\] \.tour-top > img \{ filter: brightness\(0\.11\); \}/, "the fist shows on a light page");
  assert.doesNotMatch(dashboard, /ch-dashboard-toured/, 'kept for the person, not in one browser, so a new browser or an update never runs it again');
  assert.doesNotMatch(dashboard, /searchParams\.get\('welcome'\)/);
  const server = read('webapp/server.js');
  assert.match(server, /toured: !!profile\?\.settings\?\.dashboard_toured,/);
  assert.match(server, /app\.post\("\/api\/settings\/toured"[\s\S]{0,200}patchSettings\(supabase, userId, \{ set: \{ dashboard_toured: true \} \}\)/);
});

test('the tour box is solid, so the page under it never shows through its words', () => {
  const css = read('webapp/public/welcome.css');
  const rule = (sel) => (css.match(new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm')) || [])[1] || '';
  for (const sel of ['.tour-panel', '.dashboard-help-menu']) {
    assert.match(rule(sel), /background: var\(--raised\);/, sel);
    assert.match(rule(sel), /box-shadow: 0 0.5rem 1.75rem var\(--lift\);/, sel + ': a shadow that shows in both themes');
  }
  assert.match(css, /\.tour-panel p:focus \{ outline: none; \}/, 'no focus ring round the words');
});

test("the setup page has one way into Closedhand: the banner while optional steps remain, the All set card in its place once all are done, and no footer", () => {
  const setup = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "setup.html"), "utf8");
  assert.doesNotMatch(setup, /welcome-replay|See the welcome again|footer-open|self-host edition|<footer>/);
  assert.ok(setup.indexOf('id="finish"') < setup.indexOf('class="summary"'), "the All set card sits where the banner does");
  assert.match(setup, /\$\("#ready-banner"\)\.classList\.toggle\("is-on", requiredDone && doneCount !== steps\.length\);/);
  assert.match(setup, /home\.textContent = document\.documentElement\.dataset\.host === "railway"\n\s*\? "Closedhand runs day and night on your Railway server\."/);
});
