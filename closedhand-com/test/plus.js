// Closedhand+ (lib/plus.js) against a real Postgres, in a database of its own
// so it can run beside e2e.js (which empties its own as it starts), with a
// stand-in Polar and a stand-in OpenRouter: nothing leaves this machine.
// Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/plus.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../lib/db');
const { create, verify } = require('../lib/plus');
const { planFor } = require('../lib/plan');

const PLUS = '11111111-1111-4111-8111-111111111111', EXTEND = '22222222-2222-4222-8222-222222222222';
const MANAGEMENT = 'sk-or-v1-' + 'm'.repeat(64);
const SECRET = 'whsec_' + crypto.randomBytes(32).toString('base64');
const NAME = 'closedhand_plus_test';
let admin, db;

before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});

// OpenRouter's keys and guardrails, and Polar's checkouts, portal and
// subscriptions, as far as Closedhand uses them.
function world({ polarFails = null, managed = true } = {}) {
  const keys = new Map(), calls = [];
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  // Polar's view of each subscription (live unless a test ends it), and the
  // orders given back.
  const state = { openRouterDown: false, deleteFails: false, polarSubs: new Map(), polarMonths: new Map(), refunds: [] };
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });
    if (url.startsWith('https://openrouter.ai/api/v1')) {
      assert.equal(opts.headers.Authorization, 'Bearer ' + MANAGEMENT);
      if (state.openRouterDown) throw new Error('fetch failed');
      const path = url.slice('https://openrouter.ai/api/v1'.length);
      if (path.startsWith('/guardrails?')) return reply(200, { data: [{ id: 'rail-1', name: 'Closedhand included AI' }] });
      if (path === '/guardrails/rail-1') return reply(200, { data: {} });
      if (path === '/guardrails/rail-1/assignments/keys') { for (const h of body.key_hashes) keys.get(h).guarded = true; return reply(200, {}); }
      if (path === '/keys' && method === 'POST') {
        const hash = crypto.randomBytes(32).toString('hex'), key = 'sk-or-v1-' + crypto.randomBytes(32).toString('hex');
        keys.set(hash, { key, limit: body.limit, limit_reset: body.limit_reset || null, usage: 0, guarded: false });
        return reply(201, { data: { hash, limit: body.limit }, key });
      }
      const m = path.match(/^\/keys\/([a-f0-9]{64})$/);
      if (m && method === 'GET') { const k = keys.get(m[1]); return k ? reply(200, { data: { limit: k.limit, usage: k.usage, usage_monthly: k.usage_monthly ?? k.usage, limit_reset: k.limit_reset } }) : reply(404, {}); }
      if (m && method === 'PATCH') { Object.assign(keys.get(m[1]), body); return reply(200, { data: keys.get(m[1]) }); }
      if (m && method === 'DELETE') { if (state.deleteFails) return reply(500, {}); keys.delete(m[1]); return reply(200, {}); }
    }
    if (url.startsWith('https://api.polar.sh/') || url.startsWith('https://sandbox-api.polar.sh/')) {
      assert.equal(opts.headers.Authorization, 'Bearer polar-token');
      const path = url.replace(/^https:\/\/(sandbox-)?api\.polar\.sh/, '');
      if (polarFails && path.startsWith(polarFails.path)) return reply(polarFails.status, { error: polarFails.error || 'Unavailable', detail: 'no' });
      if (path === '/v1/checkouts/') return reply(201, { id: 'chk_1', url: 'https://polar.sh/checkout/fixture-' + body.products[0].slice(0, 4) });
      if (path === '/v1/customer-sessions/') return reply(201, { token: 't', customer_portal_url: 'https://polar.sh/portal/fixture' });
      if (path.startsWith('/v1/subscriptions/') && method === 'DELETE') { state.polarSubs.set(decodeURIComponent(path.split('/')[3]), 'canceled'); return reply(200, { status: 'canceled' }); }
      if (path.startsWith('/v1/subscriptions/') && method === 'GET') {
        const id = decodeURIComponent(path.split('/')[3]);
        const month = state.polarMonths.get(id) || { start: new Date(Date.now() - 10 * 86400000).toISOString(), end: new Date(Date.now() + 20 * 86400000).toISOString() };
        return reply(200, { id, status: state.polarSubs.get(id) || 'active', current_period_start: month.start, current_period_end: month.end, cancel_at_period_end: false });
      }
      if (path === '/v1/refunds/' && method === 'POST') {
        if (state.refunds.some(r => r.order_id === body.order_id)) return reply(403, { error: 'RefundedAlready', detail: 'Order is already fully refunded' });
        state.refunds.push(body);
        return reply(201, { id: 'ref_' + state.refunds.length });
      }
      const product = path.match(/^\/v1\/products\/(.+)$/);
      if (product && method === 'GET') {
        const each = (usd, gbp, eur) => [['usd', usd], ['gbp', gbp], ['eur', eur]].map(([c, a]) => ({ amount_type: 'fixed', price_currency: c, price_amount: a, is_archived: false }));
        return reply(200, { id: product[1], prices: product[1] === PLUS ? each(800, 600, 700) : each(800, 600, 750) });
      }
    }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  const env = {
    OPENROUTER_PROVISIONING_KEY: managed ? MANAGEMENT : '', TOKEN_ENCRYPTION_KEY: 'k'.repeat(44),
    POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: SECRET, POLAR_PLUS_PRODUCT_ID: PLUS, POLAR_EXTEND_PRODUCT_ID: EXTEND,
  };
  const includedAi = require('../lib/included-ai').create({ db, env, request });
  const plus = create({ db, env, request, includedAi, baseUrl: 'https://closedhand.com' });
  return { keys, calls, state, plus, includedAi };
}

let people = 0;
async function person({ freeKey = null } = {}, w) {
  const id = (await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', $1, $2) RETURNING id", ['g-plus-' + (++people), `person${people}@example.com`])).rows[0].id;
  if (freeKey) {
    const hash = crypto.randomBytes(32).toString('hex');
    w.keys.set(hash, { key: 'sk-or-v1-free', limit: 10, limit_reset: null, usage: freeKey.usage || 0, guarded: true });
    await db.query('INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd) VALUES ($1, $2, 10)', [id, hash]);
    return { id, hash };
  }
  return { id };
}
const heldKey = async (w, ownerId) => w.keys.get((await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0]?.key_hash);
let events = 0;
// A subscription event, in a paid month from start to end (Polar's own dates,
// from the day the person subscribed).
const subscription = (type, ownerId, { id = 'sub_' + ownerId.slice(0, 8), status = 'active', cancel = false, at = new Date(Date.now() + (++events) * 1000).toISOString(), product = PLUS,
  start = '2026-11-01T00:00:00Z', end = '2026-12-01T00:00:00Z' } = {}) => ({
  type, timestamp: at,
  data: { id, status, product_id: product, customer_id: 'cus_' + ownerId.slice(0, 8), customer: { id: 'cus_' + ownerId.slice(0, 8), external_id: ownerId },
    current_period_start: start, current_period_end: end, cancel_at_period_end: cancel, modified_at: at, metadata: {} },
});
const paid = (ownerId, product = EXTEND) => ({ type: 'order.paid', data: { id: 'ord_1', product_id: product, customer: { external_id: ownerId }, metadata: { owner_id: ownerId } } });
async function settled(ownerId) {
  for (let i = 0; i < 100; i++) {
    const row = (await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
    if (!row || row.key_synced) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the key was never set to match');
}
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };

test('a webhook is accepted only with a fresh, valid signature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'subscription.active', data: {} }));
  const now = Date.now(), at = String(Math.floor(now / 1000)), id = 'msg_1';
  const sign = (key, content = body, stamp = at) => 'v1,' + crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${stamp}.`), content])).digest('base64');
  const standard = Buffer.from(SECRET.slice(6), 'base64');
  const headers = (signature, stamp = at) => ({ 'webhook-id': id, 'webhook-timestamp': stamp, 'webhook-signature': signature });
  assert.equal(verify(headers(sign(standard)), body, SECRET, now), true, 'a Standard Webhooks secret');
  assert.equal(verify(headers(sign(Buffer.from(SECRET, 'utf8'))), body, SECRET, now), true, 'an older secret, signed with its own bytes');
  assert.equal(verify(headers('v1,bm90IGl0 ' + sign(standard)), body, SECRET, now), true, 'any one of several signatures');
  assert.equal(verify(headers(sign(crypto.randomBytes(32))), body, SECRET, now), false, 'another secret');
  assert.equal(verify(headers(sign(standard)), Buffer.from(body.toString().replace('active', 'revoked')), SECRET, now), false, 'a changed body');
  const old = String(Math.floor(now / 1000) - 400);
  assert.equal(verify(headers(sign(standard, body, old), old), body, SECRET, now), false, 'a replay from minutes ago');
  assert.equal(verify({ 'webhook-id': id, 'webhook-timestamp': at }, body, SECRET, now), false, 'no signature');
  assert.equal(verify(headers(sign(standard)), body, '', now), false, 'no secret set');
});

test('checkout, carrying on and the portal go to Polar for this account only', async () => {
  const w = world();
  const p = await person({}, w);
  assert.equal(await w.plus.checkout({ id: p.id, email: 'person@example.com' }), 'https://polar.sh/checkout/fixture-1111');
  const asked = w.calls.at(-1);
  assert.equal(asked.url, 'https://api.polar.sh/v1/checkouts/');
  assert.deepEqual(asked.body, { products: [PLUS], trial_interval: 'month', trial_interval_count: 1, external_customer_id: p.id, customer_email: 'person@example.com', success_url: 'https://closedhand.com/account?plus=welcome', metadata: { owner_id: p.id } }, 'never had Closedhand+: its first month is free');
  await w.plus.extend({ id: p.id });
  assert.deepEqual(w.calls.at(-1).body.products, [EXTEND]);
  assert.equal(w.calls.at(-1).body.allow_trial, false, 'carrying on is never free');
  assert.equal(w.calls.at(-1).body.success_url, 'https://closedhand.com/account?plus=extended');
  assert.equal(await w.plus.portal({ id: p.id }), 'https://polar.sh/portal/fixture');
  assert.deepEqual(w.calls.at(-1).body, { external_customer_id: p.id, return_url: 'https://closedhand.com/account' });
  // Polar's sandbox, for trying it out.
  const sandbox = create({ db, env: { POLAR_SERVER: 'sandbox', POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: SECRET, POLAR_PLUS_PRODUCT_ID: PLUS }, request: (u, o) => { w.calls.push({ url: u }); return new Response(JSON.stringify({ url: 'https://sandbox.polar.sh/c' })); }, includedAi: w.includedAi });
  await sandbox.checkout({ id: p.id });
  assert.equal(w.calls.at(-1).url, 'https://sandbox-api.polar.sh/v1/checkouts/');
});

test('subscribing sets the key to a paid month of fair use; carrying on doubles it this month; ending stops it', async () => {
  const w = world();
  const p = await person({ freeKey: { usage: 3 } }, w);
  assert.equal(await w.plus.handle(subscription('subscription.created', p.id, { status: 'incomplete' })), 'subscription incomplete');
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [10, null], 'a payment not through yet changes nothing');
  assert.equal((await w.plus.state(p.id)).active, false);

  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [23, null], 'the whole fair use, leaving out the 3 the first month used');
  assert.deepEqual(await w.plus.state(p.id), { available: true, active: true, renews_at: '2026-12-01T00:00:00.000Z', extended: false, nearly: false });

  assert.equal(await w.plus.handle(paid(p.id)), 'carried on to the end of the month');
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 43);
  assert.equal((await w.plus.state(p.id)).extended, true);
  assert.equal(await w.plus.handle(paid(p.id, PLUS)), 'paid', 'a payment for Closedhand+ itself carries nothing on');
  assert.deepEqual(w.state.refunds, []);

  // Cancelled: it runs to the end of the paid month.
  await w.plus.handle(subscription('subscription.canceled', p.id, { cancel: true }));
  await settled(p.id);
  assert.deepEqual(await w.plus.state(p.id), { available: true, active: true, ends_at: '2026-12-01T00:00:00.000Z', extended: true, nearly: false });
  assert.equal((await heldKey(w, p.id)).limit, 43, 'still on until it ends');
  // An older event arriving late changes nothing.
  assert.equal(await w.plus.handle(subscription('subscription.updated', p.id, { at: '2020-01-01T00:00:00Z' })), 'older than what is known');

  (await heldKey(w, p.id)).usage = 7.456;
  await w.plus.handle(subscription('subscription.revoked', p.id, { status: 'canceled', cancel: true }));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [7.45, null], 'stopped where it stands');
  assert.equal((await w.plus.state(p.id)).active, false);
});

test('a checkout that never went through leaves the free use alone', async () => {
  const w = world();
  const p = await person({ freeKey: { usage: 2 } }, w);
  await w.plus.handle(subscription('subscription.created', p.id, { status: 'incomplete' }));
  await w.plus.handle(subscription('subscription.updated', p.id, { status: 'incomplete_expired' }));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [10, null]);
});

test('events for other products or unknown accounts are ignored', async () => {
  const w = world();
  const p = await person({}, w);
  assert.equal(await w.plus.handle(subscription('subscription.active', p.id, { product: '33333333-3333-4333-8333-333333333333' })), 'another product');
  assert.equal(await w.plus.handle(subscription('subscription.active', crypto.randomUUID())), 'no account, stopped', 'nobody is charged again for an account that no longer exists');
  assert.equal(await w.plus.handle({ type: 'checkout.updated', data: {} }), 'not used');
  assert.equal((await db.query('SELECT 1 FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rowCount, 0);
});

test('a subscriber whose account has no key gets one from their computer, once; nobody else does', async () => {
  const w = world();
  const p = await person({}, w), free = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.equal(await w.includedAi.collect(free.id), null, 'not a subscriber');
  const got = await w.includedAi.collect(p.id);
  assert.match(got.key, /^sk-or-v1-[a-f0-9]{64}$/);
  const held = await heldKey(w, p.id);
  assert.equal(held.key, got.key);
  assert.deepEqual([held.limit, held.limit_reset, held.guarded], [20, null, true], 'a paid month of fair use, behind the guardrail');
  const row = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [p.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(got.key), 'only its hash is kept');
  assert.equal(Number(row.granted_usd), 0, 'no free use was given');
  assert.equal(await w.includedAi.collect(p.id), null, 'handed over once');
  // Claiming again from another computer makes a fresh subscriber key.
  const again = await w.includedAi.forOwner(p.id, { ip: '198.51.100.9' });
  assert.ok(again.key && again.key !== got.key);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [20, null]);
});

test('each renewal on the day they subscribed starts a new paid month of fair use; carrying on is for the month paid in; a key OpenRouter missed is set by the sweep', quiet(async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { start: '2026-11-15T00:00:00Z', end: '2026-12-15T00:00:00Z' }));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [20, null], 'no reset on the 1st: the month is theirs');
  (await heldKey(w, p.id)).usage = 18;
  w.state.openRouterDown = true;
  await w.plus.handle(paid(p.id));
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].key_synced, false, 'not set while OpenRouter is down');
  w.state.openRouterDown = false;
  await w.plus.sweep();
  assert.equal((await heldKey(w, p.id)).limit, 40, 'carried on in this paid month');
  assert.equal((await w.plus.state(p.id)).extended, true);
  // Polar renews on the 15th: a whole new fair use from what is used now; carrying on stays with the month it was bought in.
  (await heldKey(w, p.id)).usage = 31;
  await w.plus.handle(subscription('subscription.updated', p.id, { start: '2026-12-15T00:00:00Z', end: '2027-01-15T00:00:00Z' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 51, 'what was used before stays used');
  assert.equal((await w.plus.state(p.id)).extended, false);
  // The same month told again changes nothing.
  (await heldKey(w, p.id)).usage = 40;
  await w.plus.handle(subscription('subscription.updated', p.id, { start: '2026-12-15T00:00:00Z', end: '2027-01-15T00:00:00Z' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 51);
}));

test('a renewal Polar is still retrying a card for gives no new month until it is paid', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { start: '2026-11-15T00:00:00Z', end: '2026-12-15T00:00:00Z' }));
  await settled(p.id);
  (await heldKey(w, p.id)).usage = 20;
  await w.plus.handle(subscription('subscription.updated', p.id, { status: 'past_due', start: '2026-12-15T00:00:00Z', end: '2027-01-15T00:00:00Z' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 20, 'the last paid month stands');
  await w.plus.handle(subscription('subscription.updated', p.id, { status: 'active', start: '2026-12-15T00:00:00Z', end: '2027-01-15T00:00:00Z' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 40, 'paid: the new month begins');
});

test('a renewal that never reached closedhand.com is read from Polar by the hourly sweep', quiet(async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  const past = new Date(Date.now() - 31 * 86400000).toISOString(), lapsed = new Date(Date.now() - 2 * 3600000).toISOString();
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_late', start: past, end: lapsed }));
  await settled(p.id);
  (await heldKey(w, p.id)).usage = 20;
  const start = new Date(Date.now() - 2 * 3600000).toISOString(), end = new Date(Date.now() + 29 * 86400000).toISOString();
  w.state.polarMonths.set('sub_late', { start, end });
  await w.plus.sweep();
  assert.equal((await heldKey(w, p.id)).limit, 40, 'the renewal Polar made is honoured');
  assert.equal(new Date((await db.query('SELECT current_period_end FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].current_period_end).toISOString(), end);
}));

test('a new subscription is not undone by the old one ending late', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_new' }));
  await w.plus.handle(subscription('subscription.revoked', p.id, { id: 'sub_old', status: 'canceled' }));
  await settled(p.id);
  assert.equal((await w.plus.state(p.id)).active, true);
  assert.equal((await heldKey(w, p.id)).limit, 20);
});

test('deleting an account stops its subscription at Polar first, and waits when Polar can not be reached', async () => {
  const w = world();
  const p = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_fixture_1' }));
  assert.equal(await w.plus.forget(p.id), true);
  assert.deepEqual([w.calls.at(-1).method, w.calls.at(-1).url], ['DELETE', 'https://api.polar.sh/v1/subscriptions/sub_fixture_1']);

  const gone = world({ polarFails: { path: '/v1/subscriptions/', status: 403, error: 'AlreadyCanceledSubscription' } });
  const q = await person({}, gone);
  await gone.plus.handle(subscription('subscription.active', q.id));
  assert.equal(await gone.plus.forget(q.id), true, 'already cancelled at Polar is fine');

  const barred = world({ polarFails: { path: '/v1/subscriptions/', status: 403, error: 'InsufficientScope' } });
  const s = await person({}, barred);
  await barred.plus.handle(subscription('subscription.active', s.id));
  await assert.rejects(barred.plus.forget(s.id), /Polar answered 403/, 'a token that may not cancel keeps the account');

  const down = world({ polarFails: { path: '/v1/subscriptions/', status: 503 } });
  const r = await person({}, down);
  await down.plus.handle(subscription('subscription.active', r.id));
  await assert.rejects(down.plus.forget(r.id), /Polar answered 503/);

  const none = await person({}, w);
  assert.equal(await w.plus.forget(none.id), false, 'nothing to stop');
});

test('prices are shown in the currency Polar will charge where the person is', async () => {
  const w = world();
  const { currencyFor } = require('../lib/plus');
  assert.deepEqual(['GB', 'JE', 'DE', 'ie', 'US', 'JP', '', undefined].map(currencyFor), ['gbp', 'gbp', 'eur', 'eur', 'usd', 'usd', 'usd', 'usd']);
  assert.deepEqual(await w.plus.prices('GB'), { plus: '£6', extend: '£6' });
  assert.deepEqual(await w.plus.prices('FR'), { plus: '€7', extend: '€7.50' });
  assert.deepEqual(await w.plus.prices('US'), { plus: '$8', extend: '$8' }, 'each currency written as its own customers write it');
  const asked = w.calls.filter(c => c.url.includes('/v1/products/')).length;
  await w.plus.prices('GB');
  assert.equal(w.calls.filter(c => c.url.includes('/v1/products/')).length, asked, 'read once an hour, not per visit');
});

test('the account page is told when most of this month\'s fair use is used, never how much', async () => {
  const w = world();
  const p = await person({ freeKey: true }, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.equal((await w.plus.state(p.id)).nearly, false);
  const [, key] = [...w.keys][0];
  key.usage = 17;
  const now = await w.plus.state(p.id);
  assert.equal(now.nearly, true);
  assert.ok(!JSON.stringify(now).includes('17'), 'no amount reaches the page');
});

// Money: nothing here may hand out more Managed Models than was paid for or
// given, and no key may stay live once nothing points at it.
// Keys waiting to be deleted, from the test that asks only: each starts with none.
const retired = async () => (await db.query('SELECT key_hash, tries FROM retired_ai_keys ORDER BY retired_at')).rows;
const noneWaiting = () => db.query('DELETE FROM retired_ai_keys');

test('claiming again never starts a subscriber\'s fair use again; the next paid month, it is whole', async () => {
  await noneWaiting();
  const w = world();
  const p = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  const first = await w.includedAi.collect(p.id);
  const before = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [p.id])).rows[0].key_hash;
  w.keys.get(before).usage = 15;
  const again = await w.includedAi.forOwner(p.id, { ip: '198.51.100.20' });
  assert.ok(again.key && again.key !== first.key);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [5, null], 'what the old key used stays used');
  assert.equal(w.keys.has(before), false, 'the old key is deleted at OpenRouter');
  assert.deepEqual(await retired(), [], 'and nothing waits');
  assert.deepEqual(await w.includedAi.usage(p.id), { limit: 20, used: 15 }, 'the same paid month, counted the same');
  // Renewed: the new key's month is whole.
  await w.plus.handle(subscription('subscription.updated', p.id, { start: '2026-12-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 20);
});

test('claims at once hand out one key, and no other key stays live', quiet(async () => {
  await noneWaiting();
  const w = world();
  const p = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  await w.includedAi.collect(p.id);
  const got = (await Promise.all(Array.from({ length: 6 }, (_, i) => w.includedAi.forOwner(p.id, { ip: '198.51.100.' + (30 + i) })))).filter(Boolean);
  assert.ok(got.length >= 1);
  const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [p.id])).rows[0].key_hash;
  assert.deepEqual([...w.keys.keys()], [held], 'only the key held stays live: every other one made is deleted');
  assert.ok(got.some(g => g.key === w.keys.get(held).key));
  assert.equal(w.keys.get(held).limit, 20, 'with no more to use than before');
  assert.deepEqual(await retired(), []);
}));

test('a key whose account goes is deleted at OpenRouter, however it goes and even when that fails at first', quiet(async () => {
  await noneWaiting();
  const w = world();
  const p = await person({ freeKey: {} }, w);
  w.state.deleteFails = true;
  await db.query('DELETE FROM owners WHERE id = $1', [p.id]);
  assert.deepEqual((await retired()).map(r => r.key_hash), [p.hash], 'listed as its row goes, cascades included');
  await w.includedAi.sweep();
  assert.equal((await retired())[0].tries, 1, 'still waiting while OpenRouter refuses');
  assert.equal(w.keys.has(p.hash), true);
  w.state.deleteFails = false;
  await w.includedAi.sweep();
  assert.equal(w.keys.has(p.hash), false);
  assert.deepEqual(await retired(), []);
}));

test('paying after a used-up first month gives the whole fair use at once', async () => {
  const w = world();
  const p = await person({ freeKey: { usage: 10 } }, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [30, null], 'the 10 the first month used is left out');
  const row = (await db.query('SELECT base_usd, base_for FROM included_ai_keys WHERE owner_id = $1', [p.id])).rows[0];
  assert.deepEqual([Number(row.base_usd), new Date(row.base_for).toISOString()], [10, '2026-11-01T00:00:00.000Z']);
  await w.plus.handle(subscription('subscription.updated', p.id));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 30, 'the same on every later event this paid month');
});

test('a month that ends caps the key at what it used, never at 0', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.includedAi.end(p.id);
  assert.deepEqual([w.keys.get(p.hash).limit, w.keys.get(p.hash).limit_reset], [0.01, null]);
  const used = await person({ freeKey: { usage: 7.256 } }, w);
  await w.includedAi.end(used.id);
  assert.equal(w.keys.get(used.hash).limit, 7.25);
});

test('Closedhand+ changes wait while Managed Models are switched off, and are made once they are on', async () => {
  const off = world({ managed: false });
  const p = await person({ freeKey: {} }, off);
  await off.plus.handle(subscription('subscription.active', p.id));
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].key_synced, false);
  const on = world();
  on.keys.set(p.hash, off.keys.get(p.hash) || { key: 'sk-or-v1-free', limit: 10, limit_reset: null, usage: 0, guarded: true });
  await on.plus.sweep();
  assert.deepEqual([on.keys.get(p.hash).limit, on.keys.get(p.hash).limit_reset], [20, null]);
});

// A Polar order, as its webhooks carry it.
const order = (type, ownerId, { id = 'ord_' + crypto.randomUUID().slice(0, 8), product = PLUS, sub = null, status = 'paid', at = new Date().toISOString(), amount = 800 } = {}) => ({
  type, data: { id, status, product_id: product, subscription_id: sub, created_at: at, net_amount: amount, refundable_amount: status === 'refunded' ? 0 : amount,
    customer: { external_id: ownerId }, metadata: { owner_id: ownerId } },
});

test('a payment for an account that no longer exists is given back, and its subscription stopped', async () => {
  const w = world();
  const gone = crypto.randomUUID();
  assert.equal(await w.plus.handle(order('order.paid', gone, { id: 'ord_gone', sub: 'sub_gone' })), 'no account, given back');
  assert.deepEqual(w.state.refunds, [{ order_id: 'ord_gone', reason: 'other', amount: 800 }]);
  assert.equal(w.state.polarSubs.get('sub_gone'), 'canceled');
  assert.equal(await w.plus.handle(order('order.paid', gone, { id: 'ord_gone', sub: 'sub_gone' })), 'no account, given back', 'sent again: done once');
  assert.equal(w.state.refunds.length, 1);
  assert.equal(await w.plus.handle(order('order.paid', gone, { product: EXTEND, id: 'ord_gone_2' })), 'nothing to carry on, given back');
});

test('a second subscription for one account is stopped and given back; one after the old has truly ended takes over', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_a' }));
  await settled(p.id);
  assert.equal(await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_b' })), 'a second subscription, stopped');
  assert.equal(w.state.polarSubs.get('sub_b'), 'canceled');
  assert.equal((await db.query('SELECT polar_subscription_id FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].polar_subscription_id, 'sub_a');
  assert.equal(await w.plus.handle(order('order.paid', p.id, { id: 'ord_b', sub: 'sub_b' })), 'a second subscription, given back');
  assert.deepEqual(w.state.refunds, [{ order_id: 'ord_b', reason: 'duplicate', amount: 800 }]);
  assert.equal(await w.plus.handle(order('order.paid', p.id, { id: 'ord_a', sub: 'sub_a' })), 'paid', 'the one held is kept');
  // sub_a ended at Polar, and its last event is late: a new one takes over.
  w.state.polarSubs.set('sub_a', 'canceled');
  assert.equal(await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_c' })), 'subscription active');
  assert.equal((await db.query('SELECT polar_subscription_id FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].polar_subscription_id, 'sub_c');
  assert.equal(w.state.polarSubs.get('sub_c'), undefined, 'not stopped');
});

test('carrying on bought twice in a month, or without Closedhand+, is given back; the same order sent again is not', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w), free = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.equal(await w.plus.handle(order('order.paid', p.id, { product: EXTEND, id: 'ord_x1' })), 'carried on to the end of the month');
  assert.equal(await w.plus.handle(order('order.paid', p.id, { product: EXTEND, id: 'ord_x1' })), 'carried on to the end of the month', 'sent again');
  assert.deepEqual(w.state.refunds, []);
  assert.equal(await w.plus.handle(order('order.paid', p.id, { product: EXTEND, id: 'ord_x2' })), 'nothing to carry on, given back');
  assert.equal(await w.plus.handle(order('order.paid', free.id, { product: EXTEND, id: 'ord_x3' })), 'nothing to carry on, given back');
  assert.deepEqual(w.state.refunds.map(r => [r.order_id, r.reason]), [['ord_x2', 'duplicate'], ['ord_x3', 'duplicate']]);
});

test('a payment given back in full stops what it paid for; part given back, or an earlier month, changes nothing', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_r' }));
  await settled(p.id);
  await w.plus.handle(order('order.paid', p.id, { product: EXTEND, id: 'ord_more' }));
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 40);
  assert.equal(await w.plus.handle(order('order.refunded', p.id, { product: EXTEND, id: 'ord_more', status: 'partially_refunded' })), 'nothing to stop');
  assert.equal(await w.plus.handle(order('order.refunded', p.id, { product: EXTEND, id: 'ord_more', status: 'refunded' })), 'given back, carry-on ended');
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 20, 'back to fair use');
  const old = new Date(Date.now() - 45 * 86400000).toISOString();
  assert.equal(await w.plus.handle(order('order.refunded', p.id, { sub: 'sub_r', status: 'refunded', at: old })), 'an earlier month, nothing to stop');
  assert.equal(w.state.polarSubs.get('sub_r'), undefined);
  assert.equal(await w.plus.handle(order('order.refunded', p.id, { sub: 'sub_r', status: 'refunded' })), 'given back, stopped');
  assert.equal(w.state.polarSubs.get('sub_r'), 'canceled', 'Polar\'s revoked event then stops the key');
});

test('the Polar check says which rights the token has and the prices, never the token or what Polar answered', async () => {
  const { check } = require('../tools/polar-check');
  const seen = [];
  const request = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    const path = url.replace('https://api.polar.sh', '');
    const reply = (status, body = { detail: 'secret detail' }) => new Response(JSON.stringify(body), { status });
    if (path.startsWith('/v1/refunds/')) return reply(403, { error: 'insufficient_scope', detail: 'secret detail' });
    if (path === '/v1/products/' + PLUS) return reply(200, { recurring_interval: 'month', prices: [{ amount_type: 'fixed', is_archived: false, price_amount: 1000, price_currency: 'usd' }] });
    if (path === '/v1/products/' + EXTEND) return reply(200, { prices: [{ amount_type: 'fixed', is_archived: false, price_amount: 1000, price_currency: 'usd' }] });
    if (opts.method === 'POST') return reply(422);
    if (opts.method === 'DELETE') return reply(404);
    return reply(200, { items: [] });
  };
  const out = await check({ POLAR_ACCESS_TOKEN: 'polar-token', POLAR_PLUS_PRODUCT_ID: PLUS, POLAR_EXTEND_PRODUCT_ID: EXTEND }, request);
  assert.match(out, /refunds:write \(giving a payment back\): MISSING \(insufficient_scope\)/);
  assert.match(out, /subscriptions:write \(stopping one\): allowed/);
  assert.match(out, /checkouts:write \(subscribing\): allowed/);
  assert.match(out, /orders:read \(payments and invoices in My Account\): allowed/);
  assert.match(out, /Closedhand\+: 10\.00 USD, every month/);
  assert.match(out, /Carrying on past fair use: 10\.00 USD, once/);
  assert.doesNotMatch(out, /polar-token|secret detail/);
  assert.ok(seen.every(h => h === 'Bearer polar-token'));
});

test("Closedhand+'s first month is free for an account that never had it, shown as such, and never again", async () => {
  const w = world();
  const p = await person({}, w);
  assert.equal((await w.plus.state(p.id)).free_month, true, 'offered before it is had');
  assert.equal((await planFor(db, {}, p.id)).plus_trial, true, 'and the computer is told, for what Closedhand says');
  await w.plus.handle(subscription('subscription.created', p.id, { status: 'trialing' }));
  await settled(p.id);
  const trying = await w.plus.state(p.id);
  assert.deepEqual([trying.active, trying.trial, trying.renews_at, trying.free_month], [true, true, '2026-12-01T00:00:00.000Z', undefined], 'in its free month: live, renewing when it ends');
  const plan = await planFor(db, {}, p.id);
  assert.deepEqual([plan.name, plan.trial, plan.renews_at], ['plus', true, '2026-12-01T00:00:00.000Z']);
  await w.plus.handle(subscription('subscription.updated', p.id, { status: 'trialing', cancel: true }));
  assert.deepEqual([(await w.plus.state(p.id)).trial, (await w.plus.state(p.id)).ends_at], [true, '2026-12-01T00:00:00.000Z'], 'cancelled in its free month: it ends then');
  await w.plus.handle(subscription('subscription.canceled', p.id, { status: 'canceled', cancel: true }));
  assert.equal((await w.plus.state(p.id)).free_month, undefined, 'once had, never again');
  await w.plus.checkout({ id: p.id });
  assert.equal(w.calls.at(-1).body.allow_trial, false);
  assert.equal(w.calls.at(-1).body.trial_interval, undefined);
  assert.equal((await planFor(db, {}, p.id)).plus_trial, undefined);
});
