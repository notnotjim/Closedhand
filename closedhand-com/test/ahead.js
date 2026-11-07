// Closedhand Managed Models other than monthly: the subscription every 6 or 12
// months (lib/plus.js) through a stand-in Polar, and paid ahead in crypto
// (lib/ahead.js) through a stand-in BTCPay Server, against a real Postgres in
// a database of its own and a stand-in NEAR AI. Nothing leaves this machine.
// Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/ahead.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
// Seals closedhand.com's sign-in at NEAR (lib/near-session.js).
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');
const { migrate } = require('../lib/db');
const { planFor } = require('../lib/plan');
const { addMonths, monthIn, monthOfPeriod } = require('../lib/months');
const { verifyBtcpay } = require('../lib/ahead');
const { nearAi, SIGN_IN, BROWSER } = require('./near-ai');
const near = nearAi();

const PLUS = '11111111-1111-4111-8111-111111111111', EXTEND = '22222222-2222-4222-8222-222222222222';
const SIX = '66666666-6666-4666-8666-666666666666', TWELVE = '12121212-1212-4121-8121-121212121212';
const STORE = 'StoreFixture1', HOOK = 'btcpay-webhook-secret-fixture', PAY = 'https://pay.example.test';
const NAME = 'closedhand_ahead_test';
const AGREE = 'Tick the box first: this payment starts straight away.';
const DAY = 86400000;
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

// NEAR's keys, Polar's checkouts and prices, and BTCPay's invoices, as far as
// Closedhand uses them.
function world(more = {}) {
  near.keys.clear();
  Object.assign(near.state, { down: false, deleteFails: false, refuse: false });
  const calls = [], state = { invoices: new Map(), made: [], prefix: crypto.randomBytes(4).toString('hex') };
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  const each = (usd, gbp, eur) => [['usd', usd], ['gbp', gbp], ['eur', eur]].map(([c, a]) => ({ amount_type: 'fixed', price_currency: c, price_amount: a, is_archived: false }));
  const priced = { [PLUS]: each(3000, 2400, 2900), [EXTEND]: each(3000, 2400, 2900), [SIX]: each(16200, 13000, 15700), [TWELVE]: each(28800, 23000, 27800) };
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });
    if (url.startsWith('https://cloud-api.near.ai/')) return near.request(url, opts);
    if (url.startsWith('https://api.polar.sh/')) {
      const path = url.slice('https://api.polar.sh'.length);
      if (path === '/v1/checkouts/') return reply(201, { id: 'chk_1', url: 'https://polar.sh/checkout/fixture-' + body.products[0].slice(0, 4) });
      const product = path.match(/^\/v1\/products\/(.+)$/);
      if (product) return reply(200, { id: product[1], prices: priced[product[1]] || [] });
    }
    if (url.startsWith(PAY + '/api/v1/stores/' + STORE)) {
      assert.equal(opts.headers.Authorization, 'token btcpay-key-fixture', "the store's own key");
      const path = url.slice((PAY + '/api/v1/stores/' + STORE).length);
      if (path === '/invoices' && method === 'POST') {
        const id = 'Inv' + state.prefix + (state.made.length + 1);
        state.made.push({ id, body });
        state.invoices.set(id, { id, status: 'New', amount: body.amount, currency: body.currency, metadata: body.metadata });
        return reply(200, { id, checkoutLink: PAY + '/i/' + id });
      }
      const one = path.match(/^\/invoices\/([^/]+)$/);
      if (one && method === 'GET') { const found = state.invoices.get(decodeURIComponent(one[1])); return found ? reply(200, found) : reply(403, {}); } // as BTCPay answers an id it never made
    }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  const env = {
    NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44),
    INCLUDED_AI_FAIR_USE_USD: '20', OPERATOR_EMAILS: 'keeper@example.com',
    POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: 'whsec_' + crypto.randomBytes(32).toString('base64'),
    POLAR_PLUS_PRODUCT_ID: PLUS, POLAR_EXTEND_PRODUCT_ID: EXTEND, POLAR_6_MONTHS_PRODUCT_ID: SIX, POLAR_12_MONTHS_PRODUCT_ID: TWELVE,
    BTCPAY_URL: PAY, BTCPAY_STORE_ID: STORE, BTCPAY_API_KEY: 'btcpay-key-fixture', BTCPAY_WEBHOOK_SECRET: HOOK,
    ...more,
  };
  const includedAi = require('../lib/included-ai').create({ db, env, request });
  const ahead = require('../lib/ahead').create({ db, env, request, includedAi, baseUrl: 'https://closedhand.com' });
  const plus = require('../lib/plus').create({ db, env, request, includedAi, ahead, baseUrl: 'https://closedhand.com' });
  return { calls, state, includedAi, ahead, plus, env };
}

let people = 0;
// An account with its personal URL, and, when asked, its free days' key.
async function person({ freeUsage = null, address = true, email = null, verified = false } = {}) {
  const n = ++people;
  const id = (await db.query("INSERT INTO owners (provider, subject, email, email_verified) VALUES ('google', $1, $2, $3) RETURNING id", ['g-ahead-' + n, email || `ahead${n}@example.com`, verified])).rows[0].id;
  if (address) await db.query("INSERT INTO addresses (id, owner_id, secret_hash, hostname, state) VALUES ($1, $2, $3, $4, 'active')", [crypto.randomUUID(), id, crypto.randomBytes(32).toString('hex'), `ahead-${n}.closedhand.ai`]);
  if (freeUsage !== null) {
    const key = crypto.randomUUID();
    near.keys.set(key, { name: 'Closedhand ' + id, key: 'sk-' + crypto.randomBytes(16).toString('hex'), limit: 12, usage: freeUsage });
    await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, 12, now() + interval '14 days')", [id, key]);
  }
  return id;
}
const keyOf = async id => near.keys.get((await db.query('SELECT key_id FROM included_ai_keys WHERE owner_id = $1', [id])).rows[0]?.key_id);
const planOf = async id => (await db.query('SELECT starts_at, ends_at, ended_at, extended_for FROM ahead_plans WHERE owner_id = $1', [id])).rows[0];
let events = 0;
// Polar's events for a subscription, as lib/plus.js reads them.
const subscription = (ownerId, { product = SIX, start, end, status = 'active', cancel = false }) => ({
  type: 'subscription.active',
  data: { id: 'sub_' + ownerId.slice(0, 8), status, product_id: product, customer_id: 'cus_' + ownerId.slice(0, 8), customer: { id: 'cus_' + ownerId.slice(0, 8), external_id: ownerId },
    current_period_start: start.toISOString(), current_period_end: end.toISOString(), cancel_at_period_end: cancel, modified_at: new Date(Date.now() + (++events) * 1000).toISOString(), metadata: {} },
});
const carryOnOrder = (id, ownerId) => ({ type: 'order.paid', data: { id, product_id: EXTEND, customer: { external_id: ownerId }, metadata: { owner_id: ownerId } } });
async function synced(ownerId) {
  for (let i = 0; i < 100; i++) {
    if ((await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0]?.key_synced) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the key was never set to match');
}
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };

test('a month of fair use within a paid period: from the day it began, never one past its end', () => {
  const start = new Date('2026-01-31T09:00:00Z'), end = addMonths(start, 6);
  assert.equal(end.toISOString(), '2026-07-31T09:00:00.000Z');
  assert.deepEqual(monthOfPeriod(start, end, new Date('2026-03-01T00:00:00Z')), { from: new Date('2026-02-28T09:00:00Z'), next: new Date('2026-03-31T09:00:00Z') }, 'a month from 31 January is the last day of February');
  assert.deepEqual(monthOfPeriod(start, end, new Date('2026-07-30T00:00:00Z')).next, end, 'the last month ends with the period');
  assert.deepEqual(monthOfPeriod(start, end, new Date('2026-09-01T00:00:00Z')).from, new Date('2026-06-30T09:00:00Z'), 'a renewal not yet paid begins no new month');
});

test('the subscription every 6 or 12 months: Polar\'s checkout for that length with no free days, and the box ticked first for whatever charges at once', quiet(async () => {
  const w = world();
  const fresh = await person(), had = await person({ freeUsage: 0 });
  assert.equal(await w.plus.cannotSubscribe({ id: fresh }, 1, false), null, 'monthly with the free days first charges nothing now');
  assert.equal(await w.plus.cannotSubscribe({ id: had }, 1, false), AGREE, 'monthly without them charges at once');
  assert.equal(await w.plus.cannotSubscribe({ id: fresh }, 6, false), AGREE, 'every 6 months charges at once, free days or not');
  assert.equal(await w.plus.cannotSubscribe({ id: had }, 12, true), null);
  assert.equal(await w.plus.cannotSubscribe({ id: had }, 3, true), 'Choose every month, every 6 months or every 12 months.');
  assert.equal(await w.plus.checkout({ id: fresh, email: 'ahead@example.com' }, undefined, 12), 'https://polar.sh/checkout/fixture-1212');
  const sent = w.calls.at(-1).body;
  assert.deepEqual([sent.products, sent.allow_trial, sent.trial_interval, sent.success_url, sent.metadata], [[TWELVE], false, undefined, 'https://closedhand.com/account?plus=welcome', { owner_id: fresh }],
    'the free days are for the monthly subscription only');
  assert.deepEqual(await w.plus.longerPrices('GB'), [{ months: 6, price: '£130', monthly: '£21.67' }, { months: 12, price: '£230', monthly: '£19.17' }]);
  assert.deepEqual(await w.plus.longerPrices('US'), [{ months: 6, price: '$162', monthly: '$27' }, { months: 12, price: '$288', monthly: '$24' }]);
  const off = world({ POLAR_12_MONTHS_PRODUCT_ID: '' });
  assert.deepEqual(await off.plus.longerPrices('US'), [], 'offered only with both lengths set');
  assert.equal(await off.plus.cannotSubscribe({ id: had }, 6, true), 'Choose every month, every 6 months or every 12 months.');
}));

test('a subscription every 6 months has a month of fair use for each month of its period, with the carry-over; carrying on is for the month running', quiet(async () => {
  const w = world();
  const id = await person({ freeUsage: 2 });
  // Taken out 40 days ago: in its second month now.
  const start = new Date(Date.now() - 40 * DAY), end = addMonths(start, 6);
  assert.equal(await w.plus.handle(subscription(id, { start, end })), 'subscription active');
  await synced(id);
  assert.equal((await keyOf(id)).limit, 32, 'what it used (2), a month of fair use (20) and what the free days left (10)');
  assert.equal(new Date((await db.query('SELECT base_for FROM included_ai_keys WHERE owner_id = $1', [id])).rows[0].base_for).getTime(), addMonths(start, 1).getTime(), 'this month, not the period');
  const state = await w.plus.state(id);
  assert.deepEqual([state.every, state.renews_at, state.extended], [6, end.toISOString(), false]);
  let told = await planFor(db, w.env, id);
  assert.deepEqual([told.name, told.every, told.renews_at, told.fair_use_renews_at], ['plus', 6, end.toISOString(), addMonths(start, 2).toISOString()], "Polar renews in months; this month's fair use renews next month");
  assert.equal(await w.plus.handle(carryOnOrder('ord_carry_1', id)), 'carried on to the end of the month');
  await synced(id);
  assert.equal((await keyOf(id)).limit, 52, 'another month of fair use');
  assert.equal((await w.plus.state(id)).extended, true);
  assert.equal((await planFor(db, w.env, id)).extended, true);
  assert.equal(await w.plus.handle(carryOnOrder('ord_carry_2', id)), 'nothing to carry on, given back', 'once a month');

  // Its next month begins: the hourly sweep sets it, with what this one left.
  const later = new Date(start.getTime() - 25 * DAY);
  await db.query('UPDATE plus_subscriptions SET current_period_start = $2, current_period_end = $3 WHERE owner_id = $1', [id, later, addMonths(later, 6)]);
  (await keyOf(id)).usage = 30;
  await w.plus.sweep();
  assert.equal((await keyOf(id)).limit, 70, 'what it used (30), a month (20) and what last month left, up to a month (20)');
  assert.equal((await w.plus.state(id)).extended, false, 'carrying on stays with the month it was bought in');
  await w.plus.sweep();
  assert.equal((await keyOf(id)).limit, 70, 'once a month');
  told = await planFor(db, w.env, id);
  assert.equal(told.fair_use_renews_at, addMonths(later, 3).toISOString());
}));

test('paying 3 months ahead in crypto starts a plan with a month of fair use and what the free days left, counted once', quiet(async () => {
  const w = world();
  const id = await person({ freeUsage: 2 });
  assert.equal(await w.ahead.checkout({ id }, { months: 3, agreed: true }), 'https://closedhand.com/pay/' + w.state.made[0].id);
  assert.deepEqual(w.state.made[0].body, { amount: '90', currency: 'USD', metadata: { ownerId: id, months: 3 }, checkout: { redirectURL: 'https://closedhand.com/account?plus=ahead', redirectAutomatically: true } },
    'an invoice in US dollars carrying the account and months, and nothing about the payer');
  const made = w.state.made[0].id;
  w.state.invoices.get(made).status = 'Settled';
  assert.equal(await w.ahead.settled(made), 'paid ahead 3 months');
  assert.equal(await w.ahead.settled(made), 'already counted', 'BTCPay sending it again changes nothing');
  const plan = await planOf(id);
  assert.equal(new Date(plan.ends_at).getTime(), addMonths(plan.starts_at, 3).getTime(), 'three calendar months from now');
  assert.equal((await keyOf(id)).limit, 32, 'what it used (2), a month of fair use (20) and what the free days left (10)');
  assert.deepEqual((await db.query('SELECT id, kind, months, amount_cents, currency FROM ahead_payments WHERE owner_id = $1', [id])).rows,
    [{ id: 'btcpay:' + made, kind: 'plan', months: 3, amount_cents: 9000, currency: 'usd' }], 'the invoice, its months, amount and nothing about the payer');
  const told = await planFor(db, w.env, id);
  assert.deepEqual([told.name, told.ends_at, told.fair_use_renews_at, told.extended], ['ahead', new Date(plan.ends_at).toISOString(), addMonths(plan.starts_at, 1).toISOString(), false],
    "this month's fair use renews a month from the day the plan began");
  assert.equal((await w.plus.state(id)).ahead_until, new Date(plan.ends_at).toISOString());
  // Closedhand's own email address comes with it.
  const mail = require('../lib/db-driver-pg').createPgClient({ pool: db });
  assert.equal(await require('../lib/assistant-mail-usage').entitled(mail, id), true);
  // The free days running out never stop a plan paid ahead.
  await db.query("UPDATE included_ai_keys SET ends_at = now() - interval '1 hour' WHERE owner_id = $1", [id]);
  await w.includedAi.sweep();
  assert.equal((await db.query('SELECT stopped_at FROM included_ai_keys WHERE owner_id = $1', [id])).rows[0].stopped_at, null);
  // Paying ahead again moves the end on, from the end, not from now.
  await w.ahead.checkout({ id }, { months: 6, agreed: true });
  w.state.invoices.get(w.state.made[1].id).status = 'Settled';
  assert.equal(await w.ahead.settled(w.state.made[1].id), 'paid ahead 6 months');
  assert.equal(new Date((await planOf(id)).ends_at).getTime(), addMonths(plan.ends_at, 6).getTime());
  assert.equal((await planOf(id)).starts_at.getTime(), plan.starts_at.getTime(), 'its months still count from the day it began');
}));

test('paying in crypto asks for agreement first, and paying ahead is never for the maintainer, a subscriber by card or an account without a personal URL', quiet(async () => {
  const w = world();
  const id = await person();
  const refused = async (args, who = { id }) => { try { await w.ahead.checkout(who, args); return null; } catch (e) { return [e.status, e.message]; } };
  assert.deepEqual(await refused({ months: 3, agreed: false }), [400, AGREE]);
  assert.deepEqual(await refused({ months: 3 }), [400, AGREE]);
  assert.deepEqual(await refused({ months: 12, agreed: true }), [400, 'Choose 3, 6 or 9 months.']);
  const keeper = await person({ email: 'keeper@example.com', verified: true });
  assert.equal((await refused({ months: 3, agreed: true }, { id: keeper }))[0], 409, 'the maintainer has Managed Models already');
  const nowhere = await person({ address: false });
  assert.deepEqual(await refused({ months: 3, agreed: true }, { id: nowhere }), [409, 'Claim your personal URL from Closedhand on your computer first.']);
  const subscriber = await person();
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status) VALUES ($1, 'sub_y', 'active')", [subscriber]);
  assert.deepEqual(await refused({ months: 3, agreed: true }, { id: subscriber }), [409, 'You have the Closedhand subscription by card. Paying ahead in crypto is instead of a subscription by card.']);
  assert.deepEqual(await refused({ extend: true, agreed: true }), [409, 'Carrying on in crypto is for an account paid ahead in crypto.']);
  assert.equal(w.state.made.length, 0, 'no invoice made for any of them');
}));

test('carrying on in crypto adds a month of fair use to this month of a plan, once', quiet(async () => {
  const w = world();
  const id = await person({ freeUsage: 0 });
  await w.ahead.checkout({ id }, { months: 3, agreed: true });
  w.state.invoices.get(w.state.made[0].id).status = 'Settled';
  await w.ahead.settled(w.state.made[0].id);
  assert.equal((await keyOf(id)).limit, 32);
  assert.equal(await w.ahead.checkout({ id }, { extend: true, agreed: true }), 'https://closedhand.com/pay/' + w.state.made[1].id);
  assert.deepEqual(w.state.made[1].body, { amount: '30', currency: 'USD', metadata: { ownerId: id, extend: true }, checkout: { redirectURL: 'https://closedhand.com/account?plus=carrying', redirectAutomatically: true } });
  w.state.invoices.get(w.state.made[1].id).status = 'Settled';
  assert.equal(await w.ahead.settled(w.state.made[1].id), 'carried on to the end of the month');
  assert.equal(await w.ahead.settled(w.state.made[1].id), 'already counted');
  assert.equal((await keyOf(id)).limit, 52, 'another month of fair use');
  assert.equal((await w.plus.state(id)).extended, true);
  assert.equal((await planFor(db, w.env, id)).extended, true);
  await assert.rejects(w.ahead.checkout({ id }, { extend: true, agreed: true }), { status: 409, message: 'You can already carry on to the end of this month.' });
  // One paid twice anyway (two pages open at once) is kept, not counted twice.
  w.state.invoices.set('InvTwice0001', { id: 'InvTwice0001', status: 'Settled', amount: '30', currency: 'USD', metadata: { ownerId: id, extend: true } });
  assert.equal(await w.ahead.settled('InvTwice0001'), 'nothing to carry on');
  assert.equal((await keyOf(id)).limit, 52);
  assert.deepEqual((await w.ahead.cryptoPayments(id)).map(p => [p.what, p.months, p.crypto, p.amount]).sort(),
    [['ahead', 3, true, '$90.00'], ['extend', undefined, true, '$30.00'], ['extend', undefined, true, '$30.00']], 'My Account lists them, with nothing about how but that it was crypto');
}));

test('a settled crypto invoice is read back from BTCPay itself; anything else changes nothing', quiet(async () => {
  const w = world();
  const id = await person({ freeUsage: 1 });
  await w.ahead.checkout({ id }, { months: 9, agreed: true });
  const made = w.state.made[0].id, invoice = w.state.invoices.get(made);
  assert.equal(await w.ahead.settled(made), 'not settled', 'not paid yet');
  invoice.status = 'Expired';
  assert.equal(await w.ahead.settled(made), 'not settled', 'expired');
  invoice.status = 'Settled';
  assert.equal(await w.ahead.settled(made), 'paid ahead 9 months');
  w.state.invoices.set('InvForgedMonths', { id: 'InvForgedMonths', status: 'Settled', amount: '1', currency: 'USD', metadata: { ownerId: id, months: 24 } });
  assert.equal(await w.ahead.settled('InvForgedMonths'), 'not ours', 'only the lengths sold');
  w.state.invoices.set('InvNoAccount1', { id: 'InvNoAccount1', status: 'Settled', amount: '90', currency: 'USD', metadata: { ownerId: crypto.randomUUID(), months: 3 } });
  assert.equal(await w.ahead.settled('InvNoAccount1'), 'no account');
  assert.equal(await w.ahead.settled('InvNeverMade'), 'not settled');
  assert.equal(await w.ahead.settled('../evil'), 'no invoice');
}));

test("BTCPay's webhook is taken only with its signature, and settles the plan once however often it comes", quiet(async () => {
  const w = world();
  const id = await person();
  await w.ahead.checkout({ id }, { months: 6, agreed: true });
  const made = w.state.made[0].id;
  w.state.invoices.get(made).status = 'Settled';
  const body = Buffer.from(JSON.stringify({ type: 'InvoiceSettled', storeId: STORE, invoiceId: made }));
  const sign = (secret, raw = body) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyBtcpay(sign(HOOK), body, HOOK), true);
  assert.equal(verifyBtcpay(sign('another-secret'), body, HOOK), false);
  assert.equal(verifyBtcpay(sign(HOOK), Buffer.from(body.toString().replace(made, made + 'X')), HOOK), false, 'a changed body');
  assert.equal(verifyBtcpay(undefined, body, HOOK), false);
  assert.equal(verifyBtcpay(sign(''), body, ''), false, 'no secret set');
  const app = express();
  app.use('/api/ahead/btcpay', express.raw({ type: '*/*' }));
  w.ahead.register(app, { sessions: { owner: () => null } });
  const server = app.listen(0);
  try {
    const at = `http://127.0.0.1:${server.address().port}/api/ahead/btcpay`;
    const post = (signature, raw = body) => fetch(at, { method: 'POST', headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': signature }, body: raw });
    assert.equal((await post(sign('another-secret'))).status, 403);
    assert.equal(await planOf(id), undefined);
    assert.equal((await post(sign(HOOK))).status, 200);
    assert.ok(await planOf(id), 'paid ahead');
    assert.equal((await post(sign(HOOK))).status, 200, 'again: answered, counted once');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ahead_payments WHERE owner_id = $1', [id])).rows[0].n, 1);
    const other = Buffer.from(JSON.stringify({ type: 'InvoiceSettled', storeId: 'AnotherStore', invoiceId: made }));
    assert.equal((await post(sign(HOOK, other), other)).status, 200, "another store's invoice is not ours to count");
    const redirect = await fetch(`http://127.0.0.1:${server.address().port}/pay/${made}`, { redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), PAY + '/i/' + made, "the checkout on closedhand.com's own payment server");
  } finally { server.close(); }
}));

test('each month of a plan has its own fair use from the day it began, with the carry-over; a plan past its end stops the key', quiet(async () => {
  const w = world();
  const id = await person({ freeUsage: 2 });
  await w.ahead.checkout({ id }, { months: 6, agreed: true });
  w.state.invoices.get(w.state.made[0].id).status = 'Settled';
  await w.ahead.settled(w.state.made[0].id);
  // A month and a day later, 30 of it used.
  const started = new Date(Date.now() - 32 * DAY);
  await db.query('UPDATE ahead_plans SET starts_at = $2, ends_at = $3 WHERE owner_id = $1', [id, started, addMonths(started, 6)]);
  (await keyOf(id)).usage = 30;
  await w.ahead.sweep();
  assert.equal((await keyOf(id)).limit, 52, 'what it used (30), a month (20) and what last month left (2)');
  const held = (await db.query('SELECT base_for FROM included_ai_keys WHERE owner_id = $1', [id])).rows[0];
  assert.equal(new Date(held.base_for).getTime(), monthIn(started).from.getTime(), 'counted from the day the plan began');
  await w.ahead.sweep();
  assert.equal((await keyOf(id)).limit, 52, 'once a month');
  // Past its end.
  await db.query("UPDATE ahead_plans SET ends_at = now() - interval '1 minute' WHERE owner_id = $1", [id]);
  (await keyOf(id)).usage = 41;
  await w.ahead.sweep();
  assert.ok((await planOf(id)).ended_at);
  assert.equal((await keyOf(id)).limit, 41, 'stopped where it stands');
  const told = await planFor(db, w.env, id);
  assert.deepEqual([told.name, told.was], ['ended', 'ahead']);
  const mail = require('../lib/db-driver-pg').createPgClient({ pool: db });
  assert.equal(await require('../lib/assistant-mail-usage').entitled(mail, id), false, 'the email address goes with it');
}));

test('what paying ahead in crypto costs, in dollars, each length with its price a month, and carrying on', quiet(async () => {
  const w = world();
  assert.deepEqual(w.ahead.options(), {
    crypto: [{ months: 3, price: '$90', monthly: '$30' }, { months: 6, price: '$168', monthly: '$28' }, { months: 9, price: '$243', monthly: '$27' }],
    extend: '$30',
  });
  const off = world({ BTCPAY_API_KEY: '' });
  assert.equal(off.ahead.cryptoOn(), false, 'crypto is off while its settings are missing');
  assert.deepEqual(off.ahead.options(), {}, 'and nothing is offered');
}));
