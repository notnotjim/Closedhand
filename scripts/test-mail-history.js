// The last year of every mailbox is read into the cache and index, not just
// the newest few hundred messages: archived and sent mail too, never spam or
// trash, indexed from its own words with no summary. Invented mail and
// stand-in services only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const DAY = 86400000;

function withModules(stubs, target) {
  const saved = {};
  for (const [rel, exports] of Object.entries(stubs)) {
    const p = require.resolve(rel);
    saved[p] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  const t = require.resolve(target);
  delete require.cache[t];
  const mod = require(target);
  return { mod, restore() { for (const [p, m] of Object.entries(saved)) { if (m) require.cache[p] = m; else delete require.cache[p]; } delete require.cache[t]; } };
}

// data_cache and mail_coverage, enough of the query builder for mail-history.
function fakeDb(tables) {
  return {
    from(name) {
      const rows = tables[name] || (tables[name] = []);
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        async maybeSingle() { return { data: rows.find((r) => filters.every((f) => f(r))) || null, error: null }; },
        async upsert(row) {
          const at = rows.findIndex((r) => r.user_id === row.user_id && r.source === row.source);
          if (at >= 0) rows[at] = { ...rows[at], ...row }; else rows.push({ done: false, ...row });
          return { error: null };
        },
        then(resolve) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve); },
      };
      return q;
    },
  };
}

// A Gmail account holding `mail` ({ id, at, spam?, bulk? }), answering list
// and get. Like Gmail, its order is only roughly newest first: neighbours are
// swapped, across page edges too. Bulk mail is in Gmail's categories, left
// out by a search that leaves them out.
function fakeGmail(mail, asked) {
  return async (method, url) => {
    const u = new URL(url);
    const one = /\/messages\/([^/?]+)$/.exec(u.pathname);
    if (one) { asked.gets.push(one[1]); const m = mail.find((x) => x.id === one[1]); return { id: m.id, internalDate: String(m.at) }; }
    const q = u.searchParams.get('q');
    asked.lists.push(q);
    const before = Number(/before:(\d+)/.exec(q)[1]) * 1000, after = Number(/after:(\d+)/.exec(q)[1]) * 1000;
    const own = /-category:promotions -category:social -category:updates -category:forums/.test(q);
    const hits = mail.filter((m) => !m.spam && !(own && m.bulk) && m.at < before && m.at > after).sort((a, b) => b.at - a.at);
    for (let i = 4; i + 1 < hits.length; i += 5) [hits[i], hits[i + 1]] = [hits[i + 1], hits[i]];
    const from = Number(u.searchParams.get('pageToken') || 0), size = Number(u.searchParams.get('maxResults'));
    return { messages: hits.slice(from, from + size).map((m) => ({ id: m.id })), ...(from + size < hits.length ? { nextPageToken: String(from + size) } : {}) };
  };
}

function setup(mail, cached = []) {
  const tables = { data_cache: cached.map((m) => ({ user_id: 'u1', source: 'gmail', type: 'email', external_id: m.id, received_at: new Date(m.at).toISOString() })), mail_coverage: [] };
  const asked = { lists: [], gets: [] }, stored = [], indexed = [];
  const { mod, restore } = withModules({
    '../user-store': { supabase: fakeDb(tables) },
    '../lib/services/google': { googleApiRequest: fakeGmail(mail, asked) },
    '../lib/services/data-sync': {
      gmailItem: (d, account) => ({ external_id: d.id, id: d.id, account, date: new Date(Number(d.internalDate)).toUTCString() }),
      upsertCacheItems: async (userId, source, type, items) => { stored.push(...items); for (const i of items) tables.data_cache.push({ user_id: userId, source, type, external_id: i.external_id, received_at: new Date(i.date).toISOString() }); },
    },
    '../lib/services/usi': { indexSyncedCacheRows: async (userId, type, rows) => { indexed.push(...rows); } },
  }, '../lib/services/mail-history');
  return { mod, restore, tables, asked, stored, indexed };
}

const now = Date.now();
const mailbox = () => {
  const mail = [];
  for (let i = 0; i < 500; i++) mail.push({ id: 'm' + i, at: now - i * 0.9 * DAY - 3600000, bulk: i % 3 === 0 });
  for (let i = 0; i < 90; i++) mail.push({ id: 'old' + i, at: now - (420 + i * 20) * DAY, bulk: i % 2 === 0 });
  mail.push({ id: 'junk', at: now - 5 * DAY, spam: true });
  return mail;
};

test('a mailbox is read back a year, newest first, then its own mail on to five years, keeping only what is not cached yet', async () => {
  const mail = mailbox();
  const recent = mail.filter((m) => !m.spam && m.at > now - 20 * DAY);
  const s = setup(mail, recent);
  try {
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(done, true);
    const want = mail.filter((m) => !m.spam && !recent.includes(m) && (m.at > now - 365 * DAY || (!m.bulk && m.at > now - 5 * 365 * DAY))).map((m) => m.id).sort();
    assert.deepEqual(s.stored.map((i) => i.external_id).sort(), want, 'everything in the year that was missing, the person\'s own mail on to five years, nothing bulk past the year and nothing past five');
    assert.ok(s.stored.some((i) => /^old/.test(i.external_id)) && mail.some((m) => m.at < now - 5 * 365 * DAY), 'the five years reached, and mail older left');
    assert.ok(s.stored.every((i) => i.from_history), 'marked, so it is indexed without a summary');
    assert.deepEqual(s.indexed.map((r) => r.external_id).sort(), want, 'and indexed');
    assert.equal(s.asked.gets.filter((id) => recent.some((m) => m.id === id)).length, 0, 'mail already cached is never fetched again');
    assert.ok(s.asked.lists.every((q) => /-in:spam -in:trash -in:drafts/.test(q)), 'spam, trash and drafts are left out');
    const cov = s.tables.mail_coverage.find((c) => c.source === 'gmail');
    assert.equal(cov.done, true);
    assert.ok(Math.abs(Date.parse(cov.complete_since) - (now - 365 * DAY)) < 60000, 'complete back to the year, for every kind of mail');
    const own = s.tables.mail_coverage.find((c) => c.source === 'gmail#personal');
    assert.equal(own.done, true);
    assert.ok(Math.abs(Date.parse(own.complete_since) - (now - 5 * 365 * DAY)) < 60000, 'and the person\'s own back to five years, kept apart');
  } finally { s.restore(); }
});

test('a run that runs out of time keeps how far it got, and the next carries on', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    let pages = 0;
    const deadlineAfterTwoPages = { valueOf: () => (pages++ < 2 ? Date.now() + 60000 : 0) };
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: deadlineAfterTwoPages });
    assert.equal(done, false);
    const cov = s.tables.mail_coverage[0];
    assert.equal(cov.done, false);
    const reached = Date.parse(cov.complete_since);
    assert.ok(reached < now - 60 * DAY && reached > now - 365 * DAY, 'claimed up to the second page');
    const kept = new Set(s.stored.map((i) => i.external_id));
    assert.ok(mail.filter((m) => !m.spam && m.at >= reached).every((m) => kept.has(m.id)), 'everything newer than what is claimed is kept');
    assert.ok(cov.walk_next, 'and where to carry on');
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(s.tables.mail_coverage[0].done, true);
    assert.equal(new Set(s.stored.map((i) => i.external_id)).size, s.stored.length, 'nothing read twice');
  } finally { s.restore(); }
});

test('an email that fails to come stops the walk there, to be read again', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    const google = require.cache[require.resolve('../lib/services/google')].exports;
    const real = google.googleApiRequest;
    let failing = true;
    google.googleApiRequest = async (method, url) => { if (failing && /\/messages\/m150\?/.test(url)) throw new Error('Google API 403: insufficient permission'); return real(method, url); };
    await assert.rejects(s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 }), /could not be read/);
    assert.equal(s.tables.mail_coverage[0].done, false);
    failing = false;
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.ok(s.stored.some((i) => i.external_id === 'm150'), 'read on the next run');
    assert.equal(s.tables.mail_coverage[0].done, true);
  } finally { s.restore(); }
});

test('a read Gmail turns away is tried again, and an email deleted meanwhile is skipped', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    const google = require.cache[require.resolve('../lib/services/google')].exports;
    const real = google.googleApiRequest;
    const tries = {};
    google.googleApiRequest = async (method, url) => {
      const id = (/\/messages\/([^/?]+)\?/.exec(url) || [])[1];
      if (id === 'm40' && (tries.m40 = (tries.m40 || 0) + 1) === 1) throw new Error('Google API 429: rateLimitExceeded');
      if (id === 'm41') throw new Error('Google API 404: Requested entity was not found.');
      return real(method, url);
    };
    const done = await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.equal(done, true, 'neither stops the walk');
    assert.equal(tries.m40, 2);
    assert.ok(s.stored.some((i) => i.external_id === 'm40'));
    assert.ok(!s.stored.some((i) => i.external_id === 'm41'));
  } finally { s.restore(); }
});

test("Gmail's per-minute quota is waited out, while a refusal of another kind is not tried again", async () => {
  const { mod, restore } = setup(mailbox());
  try {
    const quota = new Error('Google API 403: {"error":{"code":403,"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute\'"}}');
    assert.match(quota.message, mod.TRY_AGAIN);
    let n = 0;
    assert.deepEqual(await mod.fetchOnce(async () => { if (n++ < 2) throw quota; return { id: 'x' }; }, [1, 1]), { id: 'x' });
    const denied = new Error('Google API 403: {"error":{"code":403,"message":"Request had insufficient authentication scopes."}}');
    assert.doesNotMatch(denied.message, mod.TRY_AGAIN);
    await assert.rejects(mod.fetchOnce(async () => { throw denied; }, [1, 1]), /insufficient/);
  } finally { restore(); }
});

test('mail archived before the regular sync saw it is caught by the next sweep', async () => {
  const mail = mailbox();
  const s = setup(mail);
  try {
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    mail.push({ id: 'archived-at-once', at: Date.now() - 3600000 });
    s.tables.mail_coverage[0].swept_at = new Date(Date.now() - 7 * 3600000).toISOString();
    await s.mod.runAccount({ reader: 'gmail', userId: 'u1', store: null, serviceKey: 'google', source: 'gmail', deadline: Date.now() + 60000 });
    assert.ok(s.stored.some((i) => i.external_id === 'archived-at-once'));
  } finally { s.restore(); }
});

test('an IMAP mailbox is read back too: inbox, sent and archive, newest first, missing ones only', async () => {
  const folders = { INBOX: [], Sent: [], Archive: [] };
  for (let i = 0; i < 260; i++) folders[['INBOX', 'Sent', 'Archive'][i % 3]].push({ uid: 1000 - i, at: now - i * 1.6 * DAY, bulk: i % 4 === 0 });
  const tables = { data_cache: [{ user_id: 'u1', source: 'imap', type: 'email', external_id: 'imap-7-1000', received_at: new Date(now).toISOString() }], mail_coverage: [] };
  const stored = [];
  const client = {
    open: null,
    async list() { return [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Archive', specialUse: '\\Archive' }, { path: 'All', specialUse: '\\All' }]; },
    async mailboxOpen(path) { this.open = path; return { exists: folders[path].length, uidValidity: 7 }; },
    async search({ since, before }) { return folders[this.open].filter((m) => m.at >= since.getTime() && m.at < before.getTime()).map((m) => m.uid); },
    async *fetch(uids) { for (const uid of uids) yield { uid, source: JSON.stringify(folders[this.open].find((m) => m.uid === uid)) }; },
  };
  const imap = {
    imapSettings: () => ({ email: 'robin@example.org' }),
    withClient: async (settings, fn) => fn(client),
    idPrefix: (key, v) => (key === 'inbox' ? `imap-${v}-` : `imap-${key}-${v}-`),
    parseMessage: async (source) => JSON.parse(source),
    itemFromParsed: (id, parsed, account, label) => ({ external_id: id, id, account, labels: [label], date: new Date(parsed.at).toISOString(), bulk: !!parsed.bulk }),
    HISTORY_FOLDERS: [{ key: 'inbox', label: 'INBOX' }, { key: 'sent', label: 'SENT', specialUse: '\\Sent' }, { key: 'archive', label: 'ARCHIVE', specialUse: '\\Archive' }],
  };
  const { mod, restore } = withModules({
    '../user-store': { supabase: fakeDb(tables) },
    '../lib/services/imap-mail': imap,
    '../lib/services/data-sync': { upsertCacheItems: async (userId, source, type, items) => { stored.push(...items); for (const i of items) tables.data_cache.push({ user_id: userId, source, type, external_id: i.external_id, received_at: i.date }); } },
    '../lib/services/usi': { indexSyncedCacheRows: async () => {} },
  }, '../lib/services/mail-history');
  try {
    const store = { getConnection: (k) => (k === 'imap' ? { metadata: { email: 'robin@example.org' } } : null) };
    assert.equal(await mod.runAccount({ reader: 'imap', userId: 'u1', store, serviceKey: 'imap', source: 'imap', deadline: Date.now() + 60000 }), true);
    const want = Object.values(folders).flat().filter((m) => m.at > now - 365 * DAY || !m.bulk).length - 1;
    assert.equal(stored.length, want, 'every message of the year in the three folders, and the person\'s own past it, but the one already cached');
    assert.ok(!stored.some((i) => i.bulk && Date.parse(i.date) < now - 366 * DAY), 'no bulk mail past the year');
    assert.ok(stored.some((i) => i.external_id.startsWith('imap-sent-7-')) && stored.some((i) => i.external_id.startsWith('imap-archive-7-')));
    assert.ok(stored.every((i) => i.from_history));
    assert.ok(tables.mail_coverage.every((c) => c.done));
  } finally { restore(); }
});

// No language model writes into the index: each item is filed by code from
// its own words and embedded. Tested against LLM summaries on invented mail,
// events and chats (2026-11-02): the item that answers reached the model
// either way, so the summaries only sent every synced item to an LLM.
test('mail is indexed from its own words and never summarised, and a year of it is kept', () => {
  const usi = read('lib/services/usi.js');
  const pass = usi.slice(usi.indexOf('async function indexItemsWithModels('), usi.indexOf('\n}\n', usi.indexOf('async function indexItemsWithModels(')));
  assert.doesNotMatch(pass, /cheapChat\(|_enrichCompletion\(|complete\(/, 'no model call while filing');
  assert.doesNotMatch(usi, /_enrichSummarize|enrichService|phase2/);
  // Whole items, never cut: in pieces the embedder reads in full, each headed
  // by what the item is; a piece is its own row pointing at the item's first,
  // so deleting the item deletes its pieces.
  // Two rounds: every item's first piece, then the rest; bulk mail keeps its
  // first piece, and every file that came with an item is in its pieces
  // (lib/item-files.js reads them; scripts/test-item-files.js).
  assert.match(pass, /const body = piecesOf\(item\.gist \|\| item\.text\);/);
  assert.ok(pass.indexOf("writeFirst(") < pass.indexOf("for (const x of later)"), "first pieces before the rest");
  assert.match(pass, /const rest = x\.item\.bulk \? \[\] : x\.body\.slice\(1\)\.map/, "bulk mail by its first piece");
  assert.match(pass, /for \(const file of x\.item\.files \|\| \[\]\) \{/);
  assert.match(pass, /if \(vecs\.some\(\(v\) => !v\)\) continue;/, 'whole or not at all');
  assert.match(usi, /piece_of: firstId, source_metadata: \{ \.\.\.meta, _piece_of: item\.external_id, _piece: k \+ 1 \}/);
  assert.match(usi, /if \(!complete\) return true;\n\s*const \{ error: hashErr \} = await supabase\.from\("data_vectors"\)\.update\(\{ source_metadata: \{ \.\.\.meta, _pieces: rest\.length \+ 1, _content_hash: item\._content_hash \} \}\)/, 'the hash last');
  // Bulk mail, the same for every mailbox, and no stored body cut short.
  const { emailRecord } = require('../lib/services/email-record');
  assert.equal(emailRecord({ id: 'a', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }).bulk, true);
  assert.equal(emailRecord({ id: 'b', labels: ['INBOX', 'CATEGORY_PERSONAL'] }).bulk, false);
  assert.equal(emailRecord({ id: 'c', bulk: true }).bulk, true, 'Outlook Other, a list header on IMAP');
  const syncSrc = read('lib/services/data-sync.js');
  assert.doesNotMatch(syncSrc, /body\.length > 10000/, 'whole bodies');
  assert.match(syncSrc, /bulk: msg\.inferenceClassification === "other",/);
  assert.doesNotMatch(read('lib/services/imap-mail.js'), /BODY_CAP/);

  assert.match(read('migrations/085_vector_pieces.sql'), /ADD COLUMN IF NOT EXISTS piece_of uuid REFERENCES data_vectors\(id\) ON DELETE CASCADE;/);
  assert.match(usi, /const unseen = \(vectors \|\| \[\]\)\.filter\(\(v\) => !v\.piece_of && !seen\.has\(v\.external_id\)\);/, 'pieces go with their item, not as stale on their own');
  assert.match(usi, /const key = r\.service \+ ":" \+ \(r\.source_metadata\?\._piece_of \|\| r\.external_id\);/, 'an item counts once in the search, by its best piece');
  const at = usi.indexOf('const PIECE_CHARS'), piecesOf = new Function(usi.slice(at, usi.indexOf('const pad =', at)) + '; return piecesOf;')();
  const long = Array.from({ length: 900 }, (_, i) => 'word' + i).join(' ');
  const cut = piecesOf(long);
  assert.ok(cut.length > 1 && cut.every((p) => p.length <= 900));
  const kept = new Set(cut.join(' ').split(' '));
  assert.ok(long.split(' ').every((w) => kept.has(w)), 'every word in a piece');
  const wa = read('lib/services/wa-digest.js');
  assert.doesNotMatch(wa, /cheapChat|TRANSCRIPT_CAP/, 'a WhatsApp day is its whole transcript');
  assert.match(wa, /await require\("\.\/usi"\)\.indexItems\(userId, "whatsapp", "chat_day", days, \{ scoped: true, quiet: true \}\);/);
  assert.match(read('lib/brain.js'), /snippet = snippet\.substring\(0, r\.enriched \? 1500 : 1200\);/, 'the matching piece is shown whole');
  assert.match(read('lib/services/reranker.js'), /\.substring\(0, 1200\)\);\n\s*const cap = Math\.min\(documents\.length, 20\);/, 'and ranked on all of it');
  assert.doesNotMatch(read('lib/services/data-sync.js'), /\.join\("\\n"\)\.substring\(0, 8000\)/, 'no cut Slack or Notion text');
  // What is shown and embedded: the subject and the email's own words, not
  // the quoted mail under a reply.
  const box = { require: (m) => require(m === '../item-files' ? '../lib/item-files' : m) };
  require('node:vm').runInNewContext(usi.slice(usi.indexOf('function ownWords('), usi.indexOf('function _eventRowToIndexItem(')) + '\nthis.f = _emailRowToIndexItem;', box);
  const item = box.f({ external_id: 'm1', source: 'gmail', data: {
    from: 'Kofi <kofi@example.com>', subject: 'Re: Fence quote', date: '2026-02-27',
    body: 'Hi,\n\nWe can reuse the posts, so it comes to £950.\n\nKofi\n\nOn Tue, 24 Feb 2026 at 09:12, Alex <alex@example.com> wrote:\n> Can it come down?\n>> It is £1,200.' } });
  assert.equal(item.gist, 'Re: Fence quote\nHi, We can reuse the posts, so it comes to £950. Kofi');
  assert.equal(item.head, 'Subject: Re: Fence quote\nFrom: Kofi <kofi@example.com>');
  assert.match(item.text, /£1,200/, 'the full text stays for the word search and for reading');
  assert.match(read('lib/services/email-record.js'), /from_history: !!f\.from_history,/);
  const sync = read('lib/services/data-sync.js');
  assert.equal((sync.match(/evictOldItems\(userId, sourceTag, "email", 5000, require\("\.\/mail-history"\)\.horizon\(\), new Set\(/g) || []).length, 2, 'Gmail and Outlook keep their year, and what their list just named');
  assert.match(sync, /const aged = since \? gone\.lt\("received_at", since\) : gone;/);
  assert.equal((sync.match(/\{ personalSince: require\("\.\/mail-history"\)\.personalHorizon\(\) \}\);/g) || []).length, 2, "past the year, only bulk mail goes; the person's own stays five years");
  assert.match(sync, /if \(personalSince && keepSince\) \{\n\s+await older\(keepSince, true\);\n\s+await older\(personalSince\);/);
  assert.match(sync, /await unlisted\(bulkOnly \? aged\.eq\("data->>bulk", "true"\) : aged\)/);
  assert.match(sync, /require\("\.\/mail-history"\)\.kick\(userId, store\);/);
  assert.match(read('migrations/061_mail_coverage.sql'), /CREATE TABLE IF NOT EXISTS mail_coverage/);
  assert.match(read('lib/services/mail-history.js'), /\{ quiet: true \}\);/, 'older mail never shows as new mail');
  assert.match(usi, /const progress = opts\.quiet \? async \(\) => \{\} : upsertProgress;/);
});

test('a vector is deleted as stale only when its email is gone from the cache, and the cache is paged without ties', async () => {
  const src = read('lib/services/usi.js');
  const at = src.indexOf('async function staleVectors');
  const vm = require('node:vm');
  const tables = {
    data_vectors: ['seen', 'missed-by-the-pass', 'deleted-mail'].map((external_id, i) => ({ id: i + 1, user_id: 'u1', service: 'email', external_id })),
    data_cache: [{ user_id: 'u1', type: 'email', external_id: 'seen' }, { user_id: 'u1', type: 'email', external_id: 'missed-by-the-pass' }],
  };
  const box = { supabase: fakeDb(tables), Set };
  vm.runInNewContext(src.slice(at, src.indexOf('\n}\n', at) + 2) + '\nthis.f = staleVectors;', box);
  const stale = await box.f('u1', 'email', 'email', new Set(['seen']));
  assert.deepEqual(stale.map((v) => v.external_id), ['deleted-mail']);
  assert.equal((src.match(/\.order\("synced_at", \{ ascending: false \}\)\n(\s*\/\/[^\n]*\n)*\s*\.order\("id", \{ ascending: true \}\)/g) || []).length, 2, 'both passes page with a unique second key');
  assert.equal((src.match(/const toDelete = await staleVectors\(/g) || []).length, 2);
});

test('the dashboard says which kind of reading is going on', () => {
  const dash = read('webapp/views/dashboard.html');
  assert.match(dash, /'<div class="row"><span>Your older mail<\/span><b>back to ' \+ olderTo \+ '<\/b><\/div>'/, 'a row on the first-read card');
  assert.match(dash, /'Reading your last year of mail, now back to ' \+ olderTo/, 'one quiet line after it');
  assert.match(dash, /'Reading ' \+ routine\.join\(' and '\) \+ ', so recall stays up to date'/, 'new mail keeps its own line');
  assert.match(dash, /fetch\('\/api\/index\/older-mail'/);
  assert.match(read('webapp/server.js'), /app\.get\("\/api\/index\/older-mail"/);
});
