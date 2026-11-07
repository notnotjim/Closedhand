// The AI that comes with Closedhand (lib/included-ai.js), against a stand-in
// NEAR AI and a stand-in database: nothing leaves this machine.
// Run: node --test closedhand-com/test/included-ai.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');
const { create } = require('../lib/included-ai');

const { nearAi, SIGN_IN, BROWSER } = require('./near-ai');
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated';

// The few queries included-ai.js makes, over lists of rows: accounts (owners),
// their keys (included_ai_keys), the free days given (starter_grants) and
// the sign-in at NEAR (near_session).
function database() {
  const rows = [], grants = [], owners = new Map(), retired = new Set();
  const sessions = [];
  const result = list => ({ rows: list, rowCount: list.length });
  return {
    rows, grants, owners, retired, sessions,
    async query(sql, args = []) {
      if (sql.startsWith('SELECT refresh_token, seed_hash FROM near_session')) return result(sessions.slice(0, 1));
      if (sql.startsWith('INSERT INTO near_session')) { sessions[0] = { refresh_token: args[0], seed_hash: args[1], failed_at: null, warned_for: null }; return result([]); }
      if (sql.startsWith('UPDATE near_session SET refresh_token')) { Object.assign(sessions[0], { refresh_token: args[0], expires_at: args[1], failed_at: null }); return result([]); }
      if (sql.startsWith('UPDATE near_session SET failed_at')) {
        if (!sessions[0] || sessions[0].failed_at) return result([]);
        sessions[0].failed_at = new Date();
        return result([{ id: 1 }]);
      }
      if (sql.startsWith('UPDATE near_session SET warned_for = NULL')) { if (sessions[0]) sessions[0].warned_for = null; return result([]); }
      if (sql.startsWith('UPDATE near_session SET warned_for')) {
        if (!sessions[0] || sessions[0].warned_for) return result([]);
        sessions[0].warned_for = args[0];
        return result([{ id: 1 }]);
      }
      if (sql.startsWith('SELECT * FROM included_ai_keys') || /^SELECT key_id(, stopped_at)? FROM included_ai_keys/.test(sql)) return result(rows.filter(r => (Array.isArray(args[0]) ? args[0].includes(r.owner_id) : r.owner_id === args[0])));
      if (sql.startsWith('INSERT INTO included_ai_keys')) {
        if (rows.some(r => r.owner_id === args[0])) return result([]);
        // The maintainer's key: no end, its months from the first.
        if (sql.includes('maintainer')) rows.push({ owner_id: args[0], key_id: args[1], granted_usd: 0, base_usd: 0, base_for: args[2], carry_usd: 0, granted_at: new Date(), ends_at: null, stopped_at: null, maintainer: true });
        else rows.push({ owner_id: args[0], key_id: args[1], granted_usd: args[2], granted_at: new Date(), ends_at: new Date(Date.now() + args[3] * DAY), stopped_at: null });
        return result([{ owner_id: args[0] }]);
      }
      if (sql.startsWith('UPDATE included_ai_keys SET maintainer = true')) { Object.assign(rows.find(r => r.owner_id === args[0]), { maintainer: true, stopped_at: null }); return result([]); }
      if (sql.startsWith('UPDATE included_ai_keys SET maintainer = false')) { rows.find(r => r.owner_id === args[0]).maintainer = false; return result([]); }
      // A month that has just begun (beginMonth).
      if (sql.startsWith('UPDATE included_ai_keys SET base_usd = $2, base_for = $3, carry_usd = $4')) { Object.assign(rows.find(r => r.owner_id === args[0]), { base_usd: args[1], base_for: args[2], carry_usd: args[3], left_usd: null }); return result([]); }
      // Replaced only while it still holds the key that was read; the old
      // key waits to be deleted, as 018_key_upkeep.sql's trigger does.
      if (sql.startsWith('UPDATE included_ai_keys SET key_id')) {
        const row = rows.find(r => r.owner_id === args[0] && r.key_id === args[3]);
        if (!row) return result([]);
        retired.add(row.key_id);
        Object.assign(row, { key_id: args[1], base_usd: args[2] }, sql.includes('maintainer = true') ? { base_for: args[4], carry_usd: args[5], maintainer: true, stopped_at: null } : {});
        return result([{ owner_id: args[0] }]);
      }
      if (sql.startsWith('SELECT key_id, base_usd FROM included_ai_keys')) return result(rows.filter(r => r.owner_id === args[0]));
      if (sql.startsWith('INSERT INTO retired_ai_keys')) { retired.add(args[0]); return result([]); }
      if (sql.startsWith('DELETE FROM retired_ai_keys')) { retired.delete(args[0]); return result([]); }
      if (sql.startsWith('SELECT key_id FROM retired_ai_keys')) return result([...retired].map(key_id => ({ key_id })));
      if (sql.startsWith('UPDATE retired_ai_keys')) return result([]);
      if (sql.startsWith('UPDATE included_ai_keys SET stopped_at = now()')) { const r = rows.find(r => r.owner_id === args[0]); r.stopped_at = new Date(); if (args[1] != null) r.left_usd = args[1]; return result([]); }
      if (sql.includes('FROM included_ai_keys k')) return result(rows.filter(r => !r.stopped_at && r.ends_at && r.ends_at <= new Date()).map(r => ({ owner_id: r.owner_id })));
      if (sql.startsWith('SELECT provider, subject FROM owners') || sql.startsWith('SELECT email, email_verified FROM owners')) return result(owners.has(args[0]) ? [owners.get(args[0])] : []);
      // The subscription is test/plus.js's, paying ahead test/ahead.js's: nobody here does either.
      if (sql.includes('FROM plus_subscriptions')) return result([]);
      if (sql.includes('FROM ahead_plans')) return result([]);
      if (sql.startsWith('UPDATE starter_grants SET network_hash = NULL')) { for (const g of grants) if (Date.now() - g.granted_at > 30 * DAY) g.network_hash = null; return result([]); }
      if (sql.startsWith('SELECT 1 FROM starter_grants WHERE person_hash')) return result(grants.filter(g => g.person_hash === args[0]));
      if (sql.includes('FROM starter_grants WHERE network_hash')) return result([{ n: grants.filter(g => g.network_hash === args[0] && Date.now() - g.granted_at < 30 * DAY).length }]);
      if (sql.startsWith('INSERT INTO starter_grants')) {
        if (grants.some(g => g.person_hash === args[0])) return result([]);
        const g = { id: grants.length + 1, person_hash: args[0], network_hash: args[1], granted_usd: args[2], granted_at: new Date() };
        grants.push(g);
        return result([{ id: g.id }]);
      }
      if (sql.startsWith('DELETE FROM starter_grants')) { grants.splice(grants.findIndex(g => g.id === args[0]), 1); return result([]); }
      throw new Error('unexpected query ' + sql);
    },
  };
}
const DAY = 24 * 3600 * 1000;
// An account signed in with an invented Google account.
const ACCOUNT_KEY = 'k'.repeat(44);
// A paid month's fair use set to 15 here, so the sums below read plainly; unset, it is 20.
const env = (more = {}) => ({ NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, TOKEN_ENCRYPTION_KEY: ACCOUNT_KEY, INCLUDED_AI_FAIR_USE_USD: '15', ...more });
let people = 0;
const owner = (db, subject = 'g-' + (++people), email = null) => { const id = crypto.randomUUID(); db?.owners.set(id, { provider: 'google', subject, email, email_verified: !!email }); return id; };
// Each claim from its own connection unless a test says otherwise.
let addresses = 0;
const from = () => ({ ip: '198.51.100.' + (++addresses % 250) });
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };
// The maintainer's notices, as lib/operator-notices.js queues them.
const noticeBox = () => { const told = []; return { told, queue: async text => { told.push(text); } }; };

test('a claim gets 14 free days of its own: a NEAR key with their own ceiling, never reset, for the chosen model', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const id = owner(db);
  const given = await ai.forOwner(id, from());
  assert.match(given.key, /^sk-[a-f0-9]{32}$/);
  assert.deepEqual(given.models, { provider: 'near', chat: MODEL, background: MODEL, name: 'DeepSeek V4.1 Flash Abliterated' }, 'text only: pictures go to the vision language model on the computer');
  const [keyId, made] = [...near.keys][0];
  assert.equal(made.limit, 12, 'the free days\' ceiling');
  assert.equal(made.name, 'Closedhand ' + id, 'named by the account, never its email');
  assert.deepEqual(db.rows.map(r => [r.key_id, r.granted_usd]), [[keyId, 12]], 'only NEAR\'s id for it is kept');
  const days = (db.rows[0].ends_at - Date.now()) / DAY;
  assert.ok(days > 13.9 && days <= 14, 'the free days end in 14 days');
  assert.ok(!JSON.stringify(db.rows).includes(given.key), 'the key itself is never stored');
});

test('the sign-in at NEAR: each replacement is kept sealed before it is used, and a new one handed over starts again', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  await ai.forOwner(owner(db), from());
  assert.equal(near.state.renewals, 1, 'one access token for the whole claim');
  const kept = db.sessions[0].refresh_token;
  assert.match(kept, /^enc:v1:/, 'sealed');
  assert.ok(!kept.includes(near.state.refresh) && !kept.includes(SIGN_IN), 'never in plain text');
  assert.equal(require('../lib/crypto-tokens').decryptString(kept), near.state.refresh, 'NEAR\'s replacement, not the one handed over');
  assert.ok(!JSON.stringify(db.sessions).includes(SIGN_IN), 'only a hash of the one handed over');
  // Another process (a tool beside the service) carries on from the one kept.
  const tool = create({ db, env: env(), request: near.request });
  assert.ok(await tool.forOwner(owner(db), from()), 'not from the spent one handed over');
  assert.equal(near.state.renewals, 2);
  // A new one handed over (a new NEAR_REFRESH_TOKEN) is started from.
  near.state.refresh = 'rt_' + 'b2'.repeat(24);
  const handed = create({ db, env: env({ NEAR_REFRESH_TOKEN: near.state.refresh }), request: near.request });
  assert.ok(await handed.forOwner(owner(db), from()));
  assert.equal(near.state.renewals, 3);
});

test('when NEAR stops taking the sign-in the maintainer is told once, and keys wait; a working one clears it', quiet(async () => {
  const near = nearAi(), db = database(), notices = noticeBox();
  const ai = create({ db, env: env(), request: near.request, notices });
  near.state.refuse = true;
  assert.equal(await ai.forOwner(owner(db), from()), null, 'the claim goes on without a key');
  await ai.settle();
  await ai.sweep();
  assert.equal(notices.told.length, 1, 'once, not every hour');
  assert.match(notices.told[0], /^Closedhand: NEAR AI no longer accepts closedhand\.com's sign-in.*Keys already given keep working\. Sign in at cloud\.near\.ai again and set its new sign-in as NEAR_REFRESH_TOKEN on Railway\.$/);
  assert.ok(!/rt_|sk-|\d{3}/.test(notices.told[0]), 'plain words: no token, no status code');
  near.state.refuse = false;
  near.state.refresh = 'rt_' + 'c3'.repeat(24);
  const again = create({ db, env: env({ NEAR_REFRESH_TOKEN: near.state.refresh }), request: near.request, notices });
  assert.ok(await again.forOwner(owner(db), from()));
  assert.equal(db.sessions[0].failed_at, null, 'working again');
  // A tool run beside the service can't tell the maintainer, so marks nothing.
  near.state.refuse = true;
  const tool = create({ db, env: env({ NEAR_REFRESH_TOKEN: near.state.refresh }), request: near.request });
  await tool.settle();
  assert.equal(db.sessions[0].failed_at, null);
  assert.equal(notices.told.length, 1);
}));

test('a sign-in whose end renewing no longer moves on is told of once, in its last two days', quiet(async () => {
  const quiet7 = nearAi({ ends: 7 }), calm = database(), told = noticeBox();
  await create({ db: calm, env: env(), request: quiet7.request, notices: told }).settle();
  assert.equal(told.told.length, 0, 'a week ahead, as every renewal gives: nothing said');
  const near = nearAi({ ends: 1.5 }), db = database(), notices = noticeBox();
  const ai = create({ db, env: env(), request: near.request, notices });
  await ai.settle();
  assert.equal(notices.told.length, 1);
  assert.match(notices.told[0], /^Closedhand: closedhand\.com's sign-in at NEAR AI ends on \d{1,2} [A-Z][a-z]+\. /);
  assert.equal(db.sessions[0].warned_for.getTime(), db.sessions[0].expires_at.getTime(), 'remembered for that end');
  await create({ db, env: env(), request: near.request, notices }).settle();
  assert.equal(notices.told.length, 1, 'not again on the next renewal');
}));

test('claiming again gets a new key with what was left and the same end; the old one stops working', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const id = owner(db);
  await ai.forOwner(id, from());
  const [firstId, first] = [...near.keys][0];
  first.usage = 6.25;
  const again = await ai.forOwner(id, from());
  assert.ok(again.key);
  assert.ok(!near.keys.has(firstId), 'the old key is deleted');
  const [, second] = [...near.keys][0];
  assert.equal(second.limit, 5.75, 'it carries what was left, read afresh');
  assert.equal(db.rows.length, 1);
  const ends = db.rows[0].ends_at;
  assert.ok(ends > new Date(), 'the same free days');
  // Once they are over, claiming again brings nothing.
  db.rows[0].ends_at = new Date(Date.now() - 1000);
  assert.equal(await ai.forOwner(id, from()), null);
});

test('how many people start is never a reason to refuse one', quiet(async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env({ INCLUDED_AI_MONTHLY_PEOPLE: '2', INCLUDED_AI_DAILY_PEOPLE: '2' }), request: near.request });
  for (let i = 0; i < 6; i++) assert.ok(await ai.forOwner(owner(db), from()), 'person ' + (i + 1));
  assert.equal(await ai.offered(from()), true);
  assert.equal(near.keys.size, 6);
}));

test('the hourly sweep stops free days that have run out, once, keeping what they left', quiet(async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const id = owner(db), still = owner(db);
  await ai.forOwner(id, from());
  await ai.forOwner(still, from());
  const made = near.keys.get(db.rows[0].key_id);
  made.usage = 7.326;
  db.rows[0].ends_at = new Date(Date.now() - 1000);
  assert.equal(await ai.sweep(), 1);
  assert.equal(made.limit, 7.326, 'stopped where it stands');
  assert.ok(db.rows[0].stopped_at);
  assert.equal(db.rows[0].left_usd, 4.67, 'what they left, for a subscription that comes later');
  assert.equal(near.keys.get(db.rows[1].key_id).limit, 12, 'free days still running are left alone');
  assert.equal(await ai.sweep(), 0, 'stopped once');
}));

test('as closedhand.com starts, the sign-in at NEAR is renewed, so one that stopped working is told before anyone needs a key', quiet(async () => {
  const near = nearAi(), db = database();
  await create({ db, env: env(), request: near.request }).settle();
  assert.equal(near.state.renewals, 1);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /const \{ app, hourly, settle \} = createApp\(\{ db \}\);\n\s+settle\(\);/, 'as it starts, before computers ask');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /const notices = require\('\.\/lib\/operator-notices'\)\.create\(\{ db, env, request \}\);\n\s+const includedAi = require\('\.\/lib\/included-ai'\)\.create\(\{ db, env, request, notices \}\);/, 'with the maintainer\'s notices');
}));

test('NEAR lists keys a page at a time: they are read in pages and kept five minutes; a key not among them is looked for afresh', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  for (let i = 0; i < 150; i++) near.keys.set('k-' + i, { name: 'Closedhand someone', limit: 20, usage: 0.5, key: 'sk-' + i });
  assert.equal((await ai.allKeys()).length, 150);
  const pages = () => near.calls.filter(c => c.startsWith('GET /v1/workspaces/ws-1/api-keys?'));
  assert.deepEqual(pages().map(c => c.match(/offset=(\d+)/)[1]), ['0', '100']);
  const id = owner(db);
  await ai.forOwner(id, from());
  const before = pages().length;
  assert.deepEqual(await ai.usage(id), { limit: 12, used: 0 });
  assert.deepEqual(await ai.usage(id), { limit: 12, used: 0 });
  assert.equal(pages().length, before, 'the new key was kept when it was made: no pages read');
  near.keys.get(db.rows[0].key_id).usage = 3;
  assert.deepEqual(await ai.usage(id), { limit: 12, used: 0 }, 'kept five minutes');
  assert.equal(await create({ db, env: env(), request: near.request }).usage(id).then(u => u.used), 3, 'read afresh by a process without the list');
});

test('this month\'s spend is added up from NEAR\'s use by model since the first of the month', async () => {
  const near = nearAi({ byModel: [{ model: MODEL, total_cost: 41.5e9 }, { model: 'other', total_cost: 0.25e9 }] });
  const ai = create({ db: database(), env: env(), request: near.request });
  assert.equal(await ai.spentThisMonth(new Date('2027-03-11T09:00:00Z')), 41.75);
  assert.ok(near.calls.includes('GET /v1/organizations/org-1/usage/by-model?period=custom&start=' + encodeURIComponent('2027-03-01T00:00:00.000Z')));
});

test('what is left of the credit every key draws on, and how long it lasts at the last 30 days\' pace', async () => {
  const day = (d, cost) => ({ date: `2027-03-${d}`, requests: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: cost });
  const at = new Date('2027-03-11T09:00:00Z');
  const near = nearAi({ balance: { remaining: 60e9 }, series: [day('01', 0), day('05', 3), day('09', 1.5)] });
  assert.deepEqual(await create({ db: database(), env: env(), request: near.request }).credit(at), { left: 60, days: 80 },
    '$4.50 over the six days since the first use, $0.75 a day');
  const idle = nearAi({ balance: { remaining: null, credit_limits: [{ available: 6e9 }, { available: 4e9 }] } });
  assert.deepEqual(await create({ db: database(), env: env(), request: idle.request }).credit(at), { left: 10, days: null }, 'without a total, each credit\'s; nothing used, no pace');
  const unread = nearAi({ balance: { remaining: 7.5e9 }, series: null });
  assert.deepEqual(await create({ db: database(), env: env(), request: unread.request }).credit(at), { left: 7.5, days: null }, 'the credit shows without the use');
});

test('nothing is made without a sign-in at NEAR, or when NEAR is unreachable', quiet(async () => {
  const near = nearAi();
  assert.equal(await create({ db: database(), env: { TOKEN_ENCRYPTION_KEY: ACCOUNT_KEY }, request: near.request }).forOwner(owner(), from()), null);
  assert.equal(await create({ db: database(), env: env({ NEAR_REFRESH_TOKEN: 'sk-not-a-sign-in' }), request: near.request }).forOwner(owner(), from()), null);
  assert.equal(near.calls.length, 0);
  const down = nearAi(), db = database();
  down.state.down = true;
  assert.equal(await create({ db, env: env(), request: down.request }).forOwner(owner(db), from()), null);
  assert.equal(db.grants.length, 0, 'the free days it held are given back');
}));

test('deleting the account deletes its key', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const id = owner(db);
  await ai.forOwner(id, from());
  await ai.forget(id);
  assert.equal(near.keys.size, 0);
});

test('the provider and models come from the settings: chat first, support second', async () => {
  const near = nearAi();
  const ai = create({ db: database(), env: env({ INCLUDED_AI_MODELS: MODEL + ', zai-org/GLM-5.3-Flash', INCLUDED_AI_TRIAL_USD: '5', INCLUDED_AI_VISION_MODEL: 'some/vision-model' }), request: near.request });
  const given = await ai.forOwner(owner(), from());
  assert.deepEqual(given.models, { provider: 'near', chat: MODEL, background: 'zai-org/GLM-5.3-Flash', name: 'DeepSeek V4.1 Flash Abliterated' }, 'never a vision model on NEAR: its encryption carries words');
  assert.deepEqual(ai.current(), given.models, 'computers asking get the same pick');
  assert.equal(create({ db: database(), env: {}, request: near.request }).current(), null, 'none without a sign-in at NEAR');
  assert.equal([...near.keys.values()][0].limit, 5);
});

test('the free days are given once per person: deleting the account and claiming again gives nothing new', quiet(async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const first = owner(db, 'g-avery');
  assert.ok(await ai.forOwner(first, from()));
  await ai.forget(first);
  db.rows.length = 0; // the account's row goes with it
  assert.equal(await ai.forOwner(owner(db, 'g-avery'), from()), null, 'the same sign-in, as a new account');
  assert.ok(await ai.forOwner(owner(db, 'g-blake'), from()), 'someone else still gets it');
  const kept = JSON.stringify(db.grants);
  for (const plain of ['g-avery', 'g-blake', '198.51.100.']) assert.ok(!kept.includes(plain), 'only fingerprints are kept, never ' + plain);
}));

test('one connection gets it a few times a month, then no more; others still do', quiet(async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const home = { ip: '2001:db8:4:7:a::1' };
  // Ten by default, so an office or a household sharing one connection all get theirs.
  for (let i = 0; i < 10; i++) assert.ok(await ai.forOwner(owner(db), home), 'claim ' + (i + 1));
  assert.equal(await ai.forOwner(owner(db), { ip: '2001:db8:4:7:b::2' }), null, 'another address in the same home');
  assert.equal(await ai.offered(home), false, 'setup is told before claiming');
  assert.equal(await ai.offered({ ip: '203.0.113.9' }), true);
  assert.ok(await ai.forOwner(owner(db), { ip: '203.0.113.9' }));
  // After 30 days the connection's fingerprint is forgotten.
  for (const g of db.grants) g.granted_at = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  assert.ok(await ai.forOwner(owner(db), home));
  assert.equal(db.grants.filter(g => g.network_hash === null).length, 11);
}));

// OpenRouter, kept so Managed Models can move back (INCLUDED_AI_PROVIDER):
// the same rules, keys made with the provisioning key from the settings,
// each behind one guardrail. A stand-in OpenRouter as far as Closedhand uses it.
const MANAGEMENT = 'sk-or-v1-' + 'm'.repeat(64);
function openRouter({ failAssign = false, credits = { total_credits: 0, total_usage: 0 }, activity = [] } = {}) {
  const keys = new Map(), guardrails = [], calls = [];
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', where = url.replace('https://openrouter.ai/api/v1', '');
    calls.push(method + ' ' + where);
    assert.equal(opts.headers.Authorization, 'Bearer ' + MANAGEMENT, 'only the provisioning key from the settings is used');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === 'GET' && where.startsWith('/guardrails')) return reply(200, { data: guardrails });
    if (method === 'POST' && where === '/guardrails') { const g = { id: crypto.randomUUID(), ...body }; guardrails.push(g); return reply(201, { data: g }); }
    if (method === 'PATCH' && where.startsWith('/guardrails/')) { Object.assign(guardrails.find(g => g.id === where.split('/')[2]), body); return reply(200, { data: {} }); }
    let m = where.match(/^\/guardrails\/([^/]+)\/assignments\/keys$/);
    if (m && method === 'POST') {
      if (failAssign) return reply(500, { error: 'unavailable' });
      for (const hash of body.key_hashes) keys.get(hash).guardrail = m[1];
      return reply(200, { assigned_count: body.key_hashes.length });
    }
    if (method === 'POST' && where === '/keys') {
      const hash = crypto.randomBytes(32).toString('hex'), key = 'sk-or-v1-' + crypto.randomBytes(32).toString('hex');
      keys.set(hash, { name: body.name, limit: body.limit, limit_reset: body.limit_reset || null, usage: 0, usage_monthly: 0, key, guardrail: null });
      return reply(201, { data: { hash, name: body.name, limit: body.limit, usage: 0 }, key });
    }
    m = where.match(/^\/keys\/([a-f0-9]{64})$/);
    if (m && method === 'GET') { const k = keys.get(m[1]); return k ? reply(200, { data: { hash: m[1], name: k.name, limit: k.limit, usage: k.usage } }) : reply(404, { error: 'not found' }); }
    if (m && method === 'PATCH') { Object.assign(keys.get(m[1]), body); return reply(200, { data: keys.get(m[1]) }); }
    if (m && method === 'DELETE') { keys.delete(m[1]); return reply(200, { deleted: true }); }
    if (method === 'GET' && where === '/credits') return reply(200, { data: credits });
    if (method === 'GET' && where === '/activity') return reply(200, { data: activity });
    m = where.match(/^\/keys\?offset=(\d+)$/);
    if (m && method === 'GET') return reply(200, { data: [...keys].slice(Number(m[1]), Number(m[1]) + 100).map(([hash, k]) => ({ hash, name: k.name, limit: k.limit, usage: k.usage, usage_monthly: k.usage_monthly })) });
    throw new Error('unexpected ' + method + ' ' + url);
  };
  return { request, keys, guardrails, calls };
}
const onOpenRouter = (more = {}) => ({ INCLUDED_AI_PROVIDER: 'openrouter', OPENROUTER_PROVISIONING_KEY: MANAGEMENT, TOKEN_ENCRYPTION_KEY: ACCOUNT_KEY, ...more });

test('on OpenRouter: the same free days, a key behind a guardrail of the chosen models on providers that keep nothing, and the computer told so', async () => {
  const router = openRouter(), db = database();
  const ai = create({ db, env: onOpenRouter(), request: router.request });
  const id = owner(db);
  const given = await ai.forOwner(id, from());
  assert.match(given.key, /^sk-or-v1-/);
  assert.deepEqual(given.models, { provider: 'openrouter', chat: 'deepseek/deepseek-v4.1-flash', background: 'deepseek/deepseek-v4.1-flash', vision: 'xiaomi/mimo-v2.6-flash', name: 'DeepSeek V4.1 Flash' });
  const [hash, made] = [...router.keys][0];
  assert.equal(made.limit, 12);
  assert.equal(made.guardrail, router.guardrails[0].id, 'never without its guardrail');
  assert.deepEqual(router.guardrails[0].allowed_models, ['deepseek/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-flash']);
  for (const f of ['enforce_zdr_anthropic', 'enforce_zdr_openai', 'enforce_zdr_google', 'enforce_zdr_xai', 'enforce_zdr_other']) assert.equal(router.guardrails[0][f], true, f);
  assert.equal(router.guardrails[0].enable_paid_model_training, false);
  assert.equal(db.rows[0].key_id, hash, 'only OpenRouter\'s id for it is kept');
  made.usage = 3.456;
  db.rows[0].ends_at = new Date(Date.now() - 1000);
  assert.equal(await ai.sweep(), 1);
  assert.equal(made.limit, 3.46, 'stopped where it stands, to the cent OpenRouter takes');
  assert.equal(made.limit_reset, null);
  await ai.forget(id);
  assert.equal(router.keys.size, 0);
});

test('on OpenRouter: a key its guardrail could not be attached to never leaves; spend and credit come from OpenRouter\'s own counts', quiet(async () => {
  const broken = openRouter({ failAssign: true }), db = database();
  assert.equal(await create({ db, env: onOpenRouter(), request: broken.request }).forOwner(owner(db), from()), null);
  assert.equal(broken.keys.size, 0, 'deleted at once');
  assert.equal(db.grants.length, 0, 'the free days it held are given back');
  const at = new Date('2027-03-11T09:00:00Z');
  const router = openRouter({ credits: { total_credits: 100, total_usage: 40 }, activity: [{ date: '2027-03-05', usage: 3 }, { date: '2027-03-09', usage: 3 }] });
  const ai = create({ db: database(), env: onOpenRouter(), request: router.request });
  router.keys.set('a'.repeat(64), { name: 'Closedhand one', limit: 15, usage: 2, usage_monthly: 2.5 });
  router.keys.set('b'.repeat(64), { name: 'Closedhand two', limit: 15, usage: 1, usage_monthly: 1.25 });
  assert.equal(await ai.spentThisMonth(at), 3.75);
  assert.deepEqual(await ai.credit(at), { left: 60, days: 60 }, '$6 over six days, a dollar a day');
  assert.deepEqual((await ai.allKeys()).map(k => [k.name, k.limit, k.usage]), [['Closedhand one', 15, 2], ['Closedhand two', 15, 1]]);
  const op = await ai.forOperator();
  assert.equal(op.base, 'https://openrouter.ai/api/v1');
  assert.equal([...router.keys.values()].find(k => k.name === 'Closedhand insights').limit_reset, 'monthly');
}));

test('the provider is one setting; an unknown one or one without its settings makes nothing, and no key is ever in the code', async () => {
  assert.equal(create({ db: database(), env: onOpenRouter({ INCLUDED_AI_PROVIDER: 'elsewhere' }) }).enabled(), false);
  assert.equal(create({ db: database(), env: onOpenRouter({ OPENROUTER_PROVISIONING_KEY: '' }) }).enabled(), false);
  assert.equal(create({ db: database(), env: env() }).current().provider, 'near', 'NEAR unless set otherwise');
  for (const f of ['included-ai.js', 'included-ai-near.js', 'included-ai-openrouter.js', 'near-session.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8'), /sk-or-v1-[A-Za-z0-9]{20,}|rt_[A-Za-z0-9]{20,}|sk-[a-f0-9]{32}/, f);
  }
});

test('this month\'s spend, apart: the maintainer\'s own keys closedhand.com did not make, their own Managed Models, and everyone else\'s', async () => {
  const db = database();
  const mine = owner(db), someone = owner(db);
  const near = nearAi({ byModel: [{ model: MODEL, total_cost: 30e9 }], history: { 'k-own': [4, 1.5], 'k-mine': [2], 'k-insights': [0.25], 'k-someone': [22.25] } });
  near.keys.set('k-own', { name: 'My own key', limit: null, usage: 40, key: 'sk-own' });
  near.keys.set('k-mine', { name: 'Closedhand ' + mine, limit: 15, usage: 2, key: 'sk-mine' });
  near.keys.set('k-insights', { name: 'Closedhand insights', limit: 1, usage: 0.25, key: 'sk-ins' });
  near.keys.set('k-someone', { name: 'Closedhand ' + someone, limit: 15, usage: 22.25, key: 'sk-some' });
  db.rows.push({ owner_id: mine, key_id: 'k-mine' }, { owner_id: someone, key_id: 'k-someone' });
  const ai = create({ db, env: env(), request: near.request });
  assert.deepEqual(await ai.spendSplit([mine], new Date('2027-03-11T09:00:00Z')), { total: 30, own: 5.5, you: 2.25, others: 22.25 },
    'a key closedhand.com did not make is the maintainer\'s own use, not Managed Models');
  assert.ok(near.calls.some(c => c.startsWith('GET /v1/organizations/org-1/usage/history?api_key_id=k-own&start_time=' + encodeURIComponent('2027-03-01T00:00:00.000Z'))));
  assert.deepEqual(await ai.spendSplit([], new Date('2027-03-11T09:00:00Z')), { total: 30, own: 5.5, you: 0.25, others: 24.25 }, 'with nobody marked, only closedhand.com\'s own key is the maintainer\'s');
});

// The maintainer's own account (a verified sign-in email in OPERATOR_EMAILS)
// has Managed Models with no charge: a subscriber's monthly fair use, renewing
// on the first of each month with the same carry-over, never free days, and
// never stopped by the sweep or a subscription ending.
const thisMonth = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); };
test('a month of fair use is 20 unless set', () => {
  assert.equal(create({ db: database(), env: env({ INCLUDED_AI_FAIR_USE_USD: '' }) }).fairUse, 20);
});

test('the maintainer\'s account gets a month of fair use, never free days, never stopped, and claiming again carries on', quiet(async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env({ OPERATOR_EMAILS: 'Keeper@Example.com' }), request: near.request });
  const keeper = owner(db, 'g-keeper', 'keeper@example.com');
  const given = await ai.forOwner(keeper, from());
  assert.match(given.key, /^sk-/);
  const [firstId, first] = [...near.keys][0];
  assert.equal(first.limit, 15, 'a month of fair use, as a subscriber has');
  assert.equal(db.grants.length, 0, 'never free days');
  assert.deepEqual([db.rows[0].maintainer, db.rows[0].ends_at, db.rows[0].base_for.getTime()], [true, null, thisMonth().getTime()], 'its month runs from the first');
  first.usage = 6;
  db.rows[0].ends_at = null;
  assert.equal(await ai.sweep(), 0);
  assert.equal(await ai.end(keeper), true);
  assert.equal(await ai.subscribe(keeper), true);
  assert.equal(near.keys.get(firstId).limit, 15, 'neither the sweep, nor a subscription ending or starting, changes it');
  const again = await ai.forOwner(keeper, from());
  assert.ok(again.key && again.key !== given.key);
  assert.ok(!near.keys.has(firstId), 'the old key is deleted');
  assert.equal([...near.keys.values()][0].limit, 9, 'claiming again carries what was left');
  assert.deepEqual(await create({ db, env: env({ OPERATOR_EMAILS: 'keeper@example.com' }), request: near.request }).usage(keeper), { limit: 15, used: 6 }, 'the same month, counted the same');
  const now = create({ db, env: env({ OPERATOR_EMAILS: 'Keeper@Example.com' }), request: near.request });
  assert.equal(await now.collect(keeper), null, 'its computer already has it');
  const guest = await now.forOwner(owner(db, 'g-guest', 'guest@example.com'), from());
  assert.ok(guest && [...near.keys.values()].at(-1).limit === 12, 'anyone else gets the usual free days');
}));

test('the maintainer\'s month renews on the first with the same carry-over, and a key held from before starts its first month at the hourly check', quiet(async () => {
  const near = nearAi(), db = database();
  const before = create({ db, env: env(), request: near.request });
  const keeper = owner(db, 'g-keeper2', 'keeper@example.com');
  await before.forOwner(keeper, from());
  const [id, key] = [...near.keys][0];
  assert.equal(key.limit, 12, 'free days, before closedhand.com knew whose it was');
  key.usage = 4;
  const ai = create({ db, env: env({ OPERATOR_EMAILS: 'keeper@example.com' }), request: near.request });
  assert.equal(await ai.collect(keeper), null, 'nothing new to hand over');
  assert.equal(near.keys.get(id).limit, 27, 'from the 4 used: a month of fair use and the 8 left, carried in');
  assert.equal(db.rows[0].maintainer, true);
  assert.equal(await ai.collect(keeper), null);
  assert.equal(near.keys.get(id).limit, 27, 'the same month is not begun twice');
  // A new month: from what is used now, with what the last one left, up to a month.
  key.usage = 10;
  db.rows[0].base_for = new Date(Date.UTC(2020, 0, 1));
  await ai.collect(keeper);
  assert.equal(near.keys.get(id).limit, 40, '10 used, 15 for the month and the 15 the last one left, the most that carries');
  assert.deepEqual(await ai.usage(keeper), { limit: 30, used: 0 });
  // No longer the maintainer's: the usual rules again, from what it used.
  key.usage = 12.5;
  assert.equal(await create({ db, env: env(), request: near.request }).collect(keeper), null);
  assert.equal(db.rows[0].maintainer, false);
  assert.equal(near.keys.get(id).limit, 12.5, 'stopped where it stands, like any ended period');
}));
