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
// their keys (included_ai_keys), the first months given (starter_grants) and
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
      if (sql.startsWith('SELECT * FROM included_ai_keys') || sql.startsWith('SELECT key_id FROM included_ai_keys')) return result(rows.filter(r => r.owner_id === args[0]));
      if (sql.startsWith('INSERT INTO included_ai_keys')) {
        if (rows.some(r => r.owner_id === args[0])) return result([]);
        rows.push({ owner_id: args[0], key_id: args[1], granted_usd: args[2], granted_at: new Date(), ends_at: new Date(Date.now() + args[3] * DAY), stopped_at: null });
        return result([{ owner_id: args[0] }]);
      }
      // Replaced only while it still holds the key that was read; the old
      // key waits to be deleted, as 018_key_upkeep.sql's trigger does.
      if (sql.startsWith('UPDATE included_ai_keys SET key_id')) {
        const row = rows.find(r => r.owner_id === args[0] && r.key_id === args[3]);
        if (!row) return result([]);
        retired.add(row.key_id);
        Object.assign(row, { key_id: args[1], base_usd: args[2] });
        return result([{ owner_id: args[0] }]);
      }
      if (sql.startsWith('SELECT key_id, base_usd FROM included_ai_keys')) return result(rows.filter(r => r.owner_id === args[0]));
      if (sql.startsWith('INSERT INTO retired_ai_keys')) { retired.add(args[0]); return result([]); }
      if (sql.startsWith('DELETE FROM retired_ai_keys')) { retired.delete(args[0]); return result([]); }
      if (sql.startsWith('SELECT key_id FROM retired_ai_keys')) return result([...retired].map(key_id => ({ key_id })));
      if (sql.startsWith('UPDATE retired_ai_keys')) return result([]);
      if (sql.startsWith('UPDATE included_ai_keys SET stopped_at = now()')) { rows.find(r => r.owner_id === args[0]).stopped_at = new Date(); return result([]); }
      if (sql.includes('FROM included_ai_keys k')) return result(rows.filter(r => !r.stopped_at && r.ends_at && r.ends_at <= new Date()).map(r => ({ owner_id: r.owner_id })));
      if (sql.startsWith('SELECT provider, subject FROM owners')) return result(owners.has(args[0]) ? [owners.get(args[0])] : []);
      // The subscription is test/plus.js's: nobody here subscribes.
      if (sql.includes('FROM plus_subscriptions')) return result([]);
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
const env = (more = {}) => ({ NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, TOKEN_ENCRYPTION_KEY: ACCOUNT_KEY, ...more });
let people = 0;
const owner = (db, subject = 'g-' + (++people)) => { const id = crypto.randomUUID(); db?.owners.set(id, { provider: 'google', subject }); return id; };
// Each claim from its own connection unless a test says otherwise.
let addresses = 0;
const from = () => ({ ip: '198.51.100.' + (++addresses % 250) });
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };
// The maintainer's notices, as lib/operator-notices.js queues them.
const noticeBox = () => { const told = []; return { told, queue: async text => { told.push(text); } }; };

test('a claim gets a first month of its own: a NEAR key with the fair-use ceiling, never reset, for the chosen model', async () => {
  const near = nearAi(), db = database();
  const ai = create({ db, env: env(), request: near.request });
  const id = owner(db);
  const given = await ai.forOwner(id, from());
  assert.match(given.key, /^sk-[a-f0-9]{32}$/);
  assert.deepEqual(given.models, { provider: 'near', chat: MODEL, background: MODEL, name: 'DeepSeek V4.1 Flash, uncensored' }, 'text only: pictures go to the vision language model on the computer');
  const [keyId, made] = [...near.keys][0];
  assert.equal(made.limit, 20, 'the whole month');
  assert.equal(made.name, 'Closedhand ' + id, 'named by the account, never its email');
  assert.deepEqual(db.rows.map(r => [r.key_id, r.granted_usd]), [[keyId, 20]], 'only NEAR\'s id for it is kept');
  const days = (db.rows[0].ends_at - Date.now()) / DAY;
  assert.ok(days > 29.9 && days <= 30, 'the first month ends in 30 days');
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
  assert.equal(second.limit, 13.75, 'it carries what was left, read afresh');
  assert.equal(db.rows.length, 1);
  const ends = db.rows[0].ends_at;
  assert.ok(ends > new Date(), 'the same first month');
  // Once the month is over, claiming again brings nothing.
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

test('the hourly sweep stops a first month that has run out, once', quiet(async () => {
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
  assert.equal(near.keys.get(db.rows[1].key_id).limit, 20, 'a month still running is left alone');
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
  assert.deepEqual(await ai.usage(id), { limit: 20, used: 0 });
  assert.deepEqual(await ai.usage(id), { limit: 20, used: 0 });
  assert.equal(pages().length, before, 'the new key was kept when it was made: no pages read');
  near.keys.get(db.rows[0].key_id).usage = 3;
  assert.deepEqual(await ai.usage(id), { limit: 20, used: 0 }, 'kept five minutes');
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
  assert.equal(db.grants.length, 0, 'the first month it held is given back');
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
  const ai = create({ db: database(), env: env({ INCLUDED_AI_MODELS: MODEL + ', zai-org/GLM-5.3-Flash', INCLUDED_AI_FAIR_USE_USD: '5' }), request: near.request });
  const given = await ai.forOwner(owner(), from());
  assert.deepEqual(given.models, { provider: 'near', chat: MODEL, background: 'zai-org/GLM-5.3-Flash', name: 'DeepSeek V4.1 Flash, uncensored' });
  assert.deepEqual(ai.current(), given.models, 'computers asking get the same pick');
  assert.equal(create({ db: database(), env: {}, request: near.request }).current(), null, 'none without a sign-in at NEAR');
  assert.equal([...near.keys.values()][0].limit, 5);
});

test('a first month is given once per person: deleting the account and claiming again gives nothing new', quiet(async () => {
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
