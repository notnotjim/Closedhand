// closedhand.com on phones: the smoke ring with a question only you can read
// inside it and your world drifting in, in place of the fist the header
// already shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const home = read('closedhand-com/views/home.html');

test('the film is the smoke alone, and nothing still points at the fist film', () => {
  for (const f of ['smoke.webm', 'smoke.mov', 'smoke-poster.png']) {
    assert.ok(fs.existsSync(path.join(root, 'closedhand-com/public/orb', f)), f);
    assert.ok(home.includes('/orb/' + f), 'the page plays ' + f);
  }
  assert.doesNotMatch(home, /ring-glass/);
  assert.doesNotMatch(read('scripts/brand.py'), /ring-glass|ring-video\/fist\.svg/, 'the film is not part of a mark any more');
  assert.doesNotMatch(read('closedhand-com/tools/ring-video/film.html'), /fist/i);
});

test('questions only you can read resolve out of noise, starting where the page does, each fitting a small ring', () => {
  const questions = vm.runInNewContext('(' + home.match(/var QUESTIONS = (\[[\s\S]*?\]);/)[1] + ')');
  assert.ok(questions.length >= 5);
  // No script shows the page's own words: the first question.
  assert.ok(home.includes('<span class="orb-line" id="orbLine">' + questions[0] + '</span>'));
  for (const q of questions) assert.ok(q.length <= 56, 'fits the ring: ' + q);
  // Each letter keeps its width as noise turns to words, so nothing jolts.
  assert.match(home, /\.orb-noise \{ position: absolute;/);
  assert.match(home, /\.orb-ch\.on \.orb-real \{ opacity: 1; filter: none; transform: none; \}/);
  // The icons drift behind the smoke, in a band that keeps clear of the words.
  assert.match(home, /<span class="orb-stage" aria-hidden="true">\s*<span class="orb-drift" id="orbDrift"><\/span>\s*<span class="orb-body">/);
});

test('only phones and tablets get it, it opens the dashboard once this phone has, and it says the same in words', () => {
  // A link only once this phone has opened its Closedhand: until then the
  // ring is the demo and the steps below say what to do.
  assert.match(home, /<a class="orb-open handheld-only" id="orbOpen">\s*<span class="orb-stage" aria-hidden="true">/);
  assert.match(home, /\.orb-open:not\(\[href\]\) \.orb-label \{ display: none; \}/);
  assert.match(home, /try \{ opens\(localStorage\.getItem\('closedhand-personal-url'\)\); \}/, 'a typed address counts too');
  assert.match(home, /<p class="orb-said handheld-only">Ask Closedhand what other assistants won’t answer, like “What really happened in Tiananmen Square\?”/);
  assert.match(home, /if \(!smoke \|\| !link \|\| !document\.documentElement\.classList\.contains\('handheld'\)\) return;/);
  // Still for reduced motion; otherwise moving only while on screen.
  assert.match(home, /build\(QUESTIONS\[0\]\);\n  if \(still\) \{\n    chars\.forEach\(function \(c\) \{ c\.open = true; c\.el\.classList\.add\('on'\); \}\);/);
  assert.match(home, /function paused\(\) \{ return !onScreen \|\| document\.hidden; \}/);
  assert.match(home, /if \(!paused\(\)\) left -= now - last;/);
});

test('a phone sees the two steps in order and nothing that looks like a download', () => {
  assert.match(home, /<p class="first-steps-lead"><strong>Download Closedhand on a computer<\/strong>Your assistant runs on a computer, so it can't be downloaded on a phone\.<\/p>/, "a phone is told plainly it can't download it");
  assert.match(home, /<li><span class="first-step-n" aria-hidden="true">1<\/span><span><strong>On your computer<\/strong>Go to <span class="first-step-site">closedhand\.com<\/span> to download and set it up<\/span><\/li>/);
  assert.match(home, /<li><span class="first-step-n" aria-hidden="true">2<\/span><span><strong>On this phone<\/strong>Once setup is complete, talk to Closedhand in the chat apps you already use\.<\/span><\/li>/);
  assert.match(home, /\.first-steps-lead \{ margin: 0 0 \.25rem; text-align: center;/, "the lead sits in the middle of the screen");
  assert.match(home, /<a class="first-steps-have" href="\/open\?next=%2Fdashboard">Already set up\? Sign in<\/a>/);
  assert.match(home, /link\.href = url \+ '\/dashboard';/, 'Open dashboard opens the dashboard');
  assert.doesNotMatch(home, /data-get=|get-sheet|Send link/, 'no Mac app or Docker buttons on a phone, no send sheet');
  assert.doesNotMatch(home.replace(/<!--[\s\S]*?-->/g, ''), /\bInstall Closedhand\b/, 'set up, never install');
});

test("every page's header says Sign in, or Open dashboard and Sign out, and Sign out forgets the address", async () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const views = fs.readdirSync(path.join(__dirname, '..', 'closedhand-com/views')).filter((v) => v.endsWith('.html') && v !== 'insights.html');
  for (const v of views) {
    const html = read('closedhand-com/views/' + v);
    assert.doesNotMatch(html, />My Closedhand</, v + ': one name for signing in');
    if (/class="nav-cta"/.test(html)) {
      assert.match(html, /href="\/open" class="nav-cta" data-account>Sign in<\/a>/, v);
      assert.match(html, /<script src="\/account-nav\.js" defer><\/script>/, v);
    }
  }
  assert.match(read('closedhand-com/views/home.html'), /Already set up\? Sign in<\/a>/);
  const script = read('closedhand-com/public/account-nav.js');
  async function header({ kept = null, account = null }) {
    const store = new Map(kept ? [['closedhand-personal-url', kept]] : []);
    const made = [], appended = [];
    const link = { href: '/open', textContent: 'Sign in', hidden: false, attrs: { 'aria-current': 'page' }, removeAttribute(k) { delete this.attrs[k]; },
      after(n) { made.push(n); }, parentNode: { append(n) { appended.push(n); } } };
    const node = (tag) => ({ tag, children: [], listeners: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }, addEventListener(t, fn) { this.listeners[t] = fn; } });
    const all = () => [...made, ...appended];
    vm.runInNewContext(script, {
      document: { querySelector: () => link, getElementById: (id) => all().find((n) => n.id === id) || null, createElement: node, addEventListener() {} },
      location: { pathname: '/insights' },
      localStorage: { getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) },
      fetch: async () => ({ ok: true, json: async () => account || { signedIn: false } }),
    });
    await new Promise((r) => setTimeout(r, 0));
    const menu = appended[0];
    const list = menu && menu.children[1];
    const find = (tag) => list && list.children.find((c) => c.tag === tag);
    return { link, signIn: made[0], menu, who: find('p'), mine: find('a'), out: find('form'), store };
  }
  const out = await header({});
  assert.equal(out.link.textContent, 'Sign in');
  assert.equal(out.menu, undefined, 'signed out: no account menu');
  assert.equal(out.signIn, undefined);
  const signedIn = await header({ account: { signedIn: true, email: 'mira@example.com', url: 'https://amber-fox-42.closedhand.ai' } });
  assert.equal(signedIn.link.textContent, 'Open dashboard');
  assert.equal(signedIn.link.href, 'https://amber-fox-42.closedhand.ai/dashboard');
  assert.equal(signedIn.menu.tag, 'details', 'the account menu, last in the header');
  assert.equal(signedIn.who.textContent, 'mira@example.com', 'it says who is signed in');
  assert.equal(signedIn.mine.href, '/account');
  assert.equal(signedIn.mine.textContent, 'My Account');
  assert.equal(signedIn.out.action, '/logout');
  assert.equal(signedIn.out.children[0].textContent, 'Sign out');
  assert.equal(signedIn.signIn, undefined);
  const number = await header({ account: { signedIn: true, email: null, url: 'https://amber-fox-42.closedhand.ai' } });
  assert.equal(number.who, undefined, 'an account number has no email to show');
  const kept = await header({ kept: 'https://amber-fox-42.closedhand.ai' });
  assert.equal(kept.link.textContent, 'Open dashboard', 'an address this browser keeps opens too');
  assert.equal(kept.menu, undefined, 'nobody signed in: no Sign out');
  assert.equal(kept.signIn.textContent, 'Sign in');
  assert.equal(kept.signIn.href, '/account?then=%2Finsights', 'and signing in comes back to this page');
  const account = read('closedhand-com/public/account.js');
  assert.match(account, /a\.href = a\.getAttribute\('href'\)\.replace\('return_to=%2Faccount', 'return_to=' \+ encodeURIComponent\(path\)\)/, 'the account page passes it on to the sign-in');
  const keptSignedIn = await header({ kept: 'https://amber-fox-42.closedhand.ai', account: { signedIn: true, email: 'mira@example.com', url: 'https://amber-fox-42.closedhand.ai' } });
  keptSignedIn.out.listeners.submit();
  assert.equal(keptSignedIn.store.has('closedhand-personal-url'), false, 'Sign out forgets it');
  const unset = await header({ account: { signedIn: true, email: 'mira@example.com', url: null } });
  assert.equal(unset.link.hidden, true, 'signed in with no address: only the account menu');
  assert.equal(unset.out.children[0].textContent, 'Sign out');
  assert.match(read('closedhand-com/public/account.js'), /querySelector\('form\[action\^="\/logout"\]'\)\.addEventListener\('submit'/, "the Account page's Sign out forgets it too");
});

test("signing in to find a Closedhand never makes an account: the other provider's sign-in says so", async () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const { findOwner, ownerFor } = require('../closedhand-com/lib/owners');
  const rows = [{ id: 'o1', provider: 'google', subject: 'g-123' }];
  const db = { async query(sql, params) {
    if (/^UPDATE owners SET email = \$3/.test(sql)) { const r = rows.find((x) => x.provider === params[0] && x.subject === params[1]); return { rows: r ? [{ id: r.id }] : [] }; }
    if (/^UPDATE owners SET subject/.test(sql)) return { rows: [] };
    if (/^UPDATE owner_sign_ins/.test(sql)) return { rows: [] };
    if (/^INSERT INTO owners/.test(sql)) { const r = { id: 'o' + (rows.length + 1), provider: params[0], subject: params[1] }; rows.push(r); return { rows: [{ id: r.id }] }; }
    throw new Error('unexpected ' + sql);
  } };
  assert.equal(await findOwner(db, { provider: 'google', subject: 'g-123', email: 'mira@example.com' }), 'o1');
  assert.equal(await findOwner(db, { provider: 'microsoft', subject: 't:o', email: 'mira@example.com' }), null, 'the same email under Microsoft is not this account');
  assert.equal(rows.length, 1, 'and nothing was made for it');
  assert.equal(await ownerFor(db, { provider: 'microsoft', subject: 't:o', email: 'mira@example.com' }), 'o2', 'claiming still makes one');
  const signin = read('closedhand-com/lib/signin.js');
  assert.match(signin, /const finding = \/\^\\\/\(open\|account\|carry-on\|subscribe\|assistant-email\\\/confirm\)\(\?=\[\?#\]\|\$\)\/\.test\(back\);\n\s*const owner = finding \? await findOwner\(db, identity\) : await ownerFor\(db, identity\);\n\s*if \(!owner\) return res\.redirect\(navigation\.noAccount\(back, key\)\);/);
  const nav = require('../closedhand-com/public/entry-navigation');
  assert.equal(nav.noAccount('/open?next=%2Fdashboard', 'microsoft'), '/open?next=%2Fdashboard&none=microsoft');
  assert.equal(nav.noAccount('/account', 'google'), '/account?none=google');
  for (const f of ['closedhand-com/public/open.js', 'closedhand-com/public/account.js']) {
    assert.match(read(f), /'No Closedhand account uses this ' \+ providerName\(none\) \+ ' sign-in\. If you set up with ' \+ other \+ ', sign in with ' \+ other \+ ' instead\.'/, f);
  }
  const open = read('closedhand-com/views/open.html');
  assert.match(open, /<p>Sign in with the account you set Closedhand up with\.<\/p>/);
  assert.match(open, /<button class="have-it" id="type-it" type="button" hidden>Type your personal URL instead<\/button>/, 'typing is offered only when signing in cannot help');
  assert.match(read('closedhand-com/public/open.js'), /if \(failedSignIn \|\| !data\.available\) offerTyping\(\);/);
  assert.match(read('closedhand-com/public/open.js'), /\$\('title'\)\.textContent = screen === 'find' \? 'Sign in' : 'Open your Closedhand';/);
  assert.match(read('closedhand-com/public/site.css'), /\.have-it \{ display: block; margin: \.25rem auto 0;/, 'centred');
});

test("the light theme's ring is toned once, in its own film, never darkened again on the page", () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'closedhand-com/views/home.html'), 'utf8');
  assert.doesNotMatch(home, /\.orb-film \{ filter:/, "a filter here made the light ring heavy and dark");
  assert.match(home, /return light \? src\.replace\('\/smoke', '\/smoke-light'\) : src;/, "the light film is its own");
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'closedhand-com/tools/ring-video/film.html'), 'utf8'), /The light tone: CSS brightness\(0\.45\) contrast\(1\.8\) saturate\(1\.3\)/, "toned when it was made");
});

// closedhand.com/account, run as a browser runs it: the account's home is My
// Account in the person's dashboard, so it opens there whenever their
// Closedhand answers, and shows what closedhand.com holds only when it can't.
async function accountPage({ account, answers, search = '' }) {
  const elements = {}, asked = [];
  const el = (id) => elements[id] ||= { id, hidden: false, textContent: '', style: {}, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, append() {} };
  let opened = null;
  const box = {
    URLSearchParams, AbortSignal, Date, Math, JSON,
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }), createElement: () => ({}) },
    location: { search, replace: (u) => { opened = u; } },
    localStorage: { removeItem() {} },
    fetch: async (u, opts = {}) => {
      if (u === '/api/account') return { ok: true, json: async () => account };
      asked.push([u, opts.credentials]);
      return answers ? { ok: true, json: async () => ({ pick: 'light', at: 1 }) } : { ok: false, json: async () => ({}) };
    },
  };
  vm.runInNewContext(read('closedhand-com/public/account.js'), box);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { opened, asked, el };
}

test("closedhand.com/account opens My Account in the person's dashboard when their Closedhand answers", async () => {
  const account = { signedIn: true, provider: 'google', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai', address: 'amber-fox-42.closedhand.ai', signIns: [] };
  const there = await accountPage({ account, answers: true });
  assert.deepEqual(there.asked, [['https://amber-fox-42.closedhand.ai/api/theme-pick', 'omit']], 'asked without a cookie');
  assert.equal(there.opened, 'https://amber-fox-42.closedhand.ai/dashboard#account');
  assert.equal((await accountPage({ account, answers: true, search: '?plus=welcome' })).opened, 'https://amber-fox-42.closedhand.ai/dashboard#account/welcome', 'back from Polar, said there');
  const off = await accountPage({ account, answers: false });
  assert.equal(off.opened, null, 'its computer off: what closedhand.com holds, here');
  assert.equal(off.el('details').hidden, false);
  const stranger = await accountPage({ account: { ...account, url: 'https://evil.example.com' }, answers: true });
  assert.deepEqual([stranger.opened, stranger.asked], [null, []], 'only a personal URL is ever opened');
});
