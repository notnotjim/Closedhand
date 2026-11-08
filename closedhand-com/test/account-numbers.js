// Closedhand used anonymously: paid for first in crypto, the account made
// with an account number instead of an email (lib/account-number.js), through
// the real routes against a real Postgres in a database of its own, with
// stand-ins for Google, NEAR AI, Polar and BTCPay Server. Nothing leaves this
// machine. Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/account-numbers.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');
const { migrate } = require('../lib/db');
const { createApp } = require('../server');
const accountNumber = require('../lib/account-number');
const { nearAi, SIGN_IN, BROWSER } = require('./near-ai');
const near = nearAi();

const NAME = 'closedhand_account_numbers_test';
const BASE = 'https://closedhand.com';
const PLUS = '11111111-1111-4111-8111-111111111111', EXTEND = '22222222-2222-4222-8222-222222222222';
const SIX = '66666666-6666-4666-8666-666666666666', TWELVE = '12121212-1212-4121-8121-121212121212';
const PAY = 'https://pay.example.test', STORE = 'StoreFixture1';
const GOOGLE_APP = '123456789012-closedhanddesktop.apps.googleusercontent.com';
const CARDLESS = 'Your Closedhand account uses an account number, so you pay ahead in crypto, never by card.';
const WRONG = "That account number didn't work. Check the number and try again.";
const googleKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  BASE_URL: BASE, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
  PHONE_ENROLLMENT_ENABLED: '1', PHONE_PROVISIONER_SECRET: 'p'.repeat(40), ADDRESS_RATE_PER_MINUTE: '1000',
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_ASSOCIATED_CLIENT_IDS: GOOGLE_APP,
  NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, OPERATOR_EMAILS: 'keeper@example.com',
  POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: 'whsec_' + crypto.randomBytes(32).toString('base64'),
  POLAR_PLUS_PRODUCT_ID: PLUS, POLAR_EXTEND_PRODUCT_ID: EXTEND, POLAR_6_MONTHS_PRODUCT_ID: SIX, POLAR_12_MONTHS_PRODUCT_ID: TWELVE,
  BTCPAY_URL: PAY, BTCPAY_STORE_ID: STORE, BTCPAY_API_KEY: 'btcpay-key-fixture', BTCPAY_WEBHOOK_SECRET: 'btcpay-webhook-secret-fixture',
};
const reply = (status, body) => new Response(JSON.stringify(body), { status });
const priced = c => [['usd', c], ['gbp', c], ['eur', c]].map(([currency, amount]) => ({ amount_type: 'fixed', price_currency: currency, price_amount: amount, is_archived: false }));
const invoices = [], status = new Map();
const request = async (url, opts = {}) => {
  if (url.startsWith('https://cloud-api.near.ai/')) return near.request(url, opts);
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return reply(200, { keys: [{ ...googleKeys.publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig' }] });
  if (url.startsWith('https://api.polar.sh/v1/products/')) return reply(200, { id: url.split('/').pop(), prices: priced(3000) });
  if (url.startsWith('https://api.polar.sh/')) throw new Error('nothing goes to Polar for an account made with an account number: ' + url);
  if (url === PAY + '/api/v1/stores/' + STORE + '/invoices' && opts.method === 'POST') {
    const id = 'InvNumber' + (invoices.length + 1);
    invoices.push({ id, body: JSON.parse(opts.body) });
    status.set(id, 'New');
    return reply(200, { id, checkoutLink: PAY + '/i/' + id });
  }
  const one = url.match(/\/api\/v1\/stores\/StoreFixture1\/invoices\/([^/]+)$/);
  if (one && (opts.method || 'GET') === 'GET') {
    const made = invoices.find(i => i.id === decodeURIComponent(one[1]));
    return made ? reply(200, { id: made.id, status: status.get(made.id), amount: made.body.amount, currency: 'USD', metadata: made.body.metadata }) : reply(403, {});
  }
  throw new Error('unexpected request ' + url);
};
let admin, db, server, base;

before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
  ({ server, base } = await listen(env));
});
after(async () => {
  server?.close();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});
async function listen(given) {
  const { app } = createApp({ db, env: given, request, startMailWorker: () => {} });
  const s = await new Promise(r => { const l = app.listen(0, () => r(l)); });
  return { server: s, base: 'http://127.0.0.1:' + s.address().port };
}
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };

// A computer running Closedhand, as the service sees it, on an internet connection.
let connections = 0;
const place = () => '198.51.100.' + (++connections);
function computer(ip = place()) {
  const secret = crypto.randomBytes(32).toString('hex');
  return { ip, hash: crypto.createHash('sha256').update(secret).digest('hex'), auth: { Authorization: `Bearer ${crypto.randomUUID()}.${secret}` } };
}
// Through Cloudflare and Railway's edge: the address Cloudflare saw comes first.
const from = ip => ({ 'X-Forwarded-For': ip + ', 10.0.0.1' });
async function call(method, path, body, headers = {}, at = base) {
  const r = await fetch(at + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, headers: r.headers };
}
const ask = (copy, body = { port: 3000, acceptedTerms: true, months: 3 }, at) => call('POST', '/api/phone-enrollment/claim-anonymous', body, { ...copy.auth, ...from(copy.ip) }, at);
const poll = copy => call('GET', '/api/phone-enrollment/claim-anonymous', undefined, copy.auth);
// BTCPay's webhook, signed with the webhook's secret as BTCPay signs it.
async function webhook(type, invoiceId) {
  const body = JSON.stringify({ type, invoiceId, storeId: STORE, deliveryId: crypto.randomUUID() });
  const sig = 'sha256=' + crypto.createHmac('sha256', env.BTCPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return (await fetch(base + '/api/ahead/btcpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sig }, body })).status;
}
const invoiceOf = url => url.split('/pay/')[1];
// Used anonymously, start to end: asked, paid, collected.
async function claim(copy, months = 3) {
  const asked = await ask(copy, { port: 3000, acceptedTerms: true, months });
  status.set(invoiceOf(asked.json.url), 'Settled');
  assert.equal(await webhook('InvoiceSettled', invoiceOf(asked.json.url)), 200);
  return poll(copy);
}
const signIn = (number, ip = place(), origin = BASE) => call('POST', '/auth/number', { number }, { Origin: origin, ...from(ip) });
const cookieOf = r => (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
const signedIn = cookie => ({ cookie, Origin: BASE });

test('using Closedhand anonymously is paid for first: the claim waits with no account, and once paid the account, its personal URL and its plan are made together', quiet(async () => {
  near.keys.clear();
  const copy = computer();
  const unagreed = await ask(copy, { port: 3000, months: 3 });
  assert.deepEqual([unagreed.status, unagreed.json.error], [400, 'Agree to the Terms and Privacy policy first.']);
  assert.deepEqual([(await ask(copy, { port: 3000, acceptedTerms: true, months: 4 })).status], [400], 'only 3, 6 or 9 months');
  const asked = await ask(copy);
  assert.equal(asked.status, 200);
  assert.equal(asked.json.state, 'waiting');
  assert.match(asked.json.url, /^https:\/\/closedhand\.com\/pay\/InvNumber\d+$/, "closedhand.com's own payment page");
  const made = invoices.at(-1);
  assert.deepEqual(Object.keys(made.body.metadata).sort(), ['months', 'pendingClaim'], 'the invoice names the waiting claim and the months, nothing about the person');
  assert.deepEqual([made.body.amount, made.body.currency, made.body.metadata.months], ['90', 'USD', 3]);
  assert.deepEqual(made.body.checkout.paymentMethods, ['USDT-TRON', 'USDT-ETHEREUM', 'USDT-POLYGON', 'USDT-BSC'], 'paid in USDT only, as every invoice: Bitcoin is left out for now');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM owners WHERE provider = 'anonymous'")).rows[0].n, 0, 'no account before the payment');
  assert.deepEqual((await poll(copy)).json, { state: 'waiting' });

  // Settled: the webhook is read back from BTCPay before anything is made.
  assert.equal(await webhook('InvoiceSettled', made.id), 200);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM owners WHERE provider = 'anonymous'")).rows[0].n, 0, 'a webhook BTCPay does not back up makes nothing');
  status.set(made.id, 'Settled');
  assert.equal(await webhook('InvoiceSettled', made.id), 200);
  assert.equal(await webhook('InvoiceSettled', made.id), 200, 'sent again, it changes nothing');
  const owner = (await db.query("SELECT * FROM owners WHERE provider = 'anonymous'")).rows;
  assert.equal(owner.length, 1, 'one account');
  assert.deepEqual([owner[0].email, owner[0].email_verified, owner[0].terms_version], [null, false, '2026-11-06']);
  const plan = (await db.query('SELECT starts_at, ends_at FROM ahead_plans WHERE owner_id = $1', [owner[0].id])).rows[0];
  assert.ok(plan && new Date(plan.ends_at) > new Date(Date.now() + 85 * 86400000), 'three months paid ahead');
  assert.deepEqual((await db.query('SELECT id, months FROM ahead_payments WHERE owner_id = $1', [owner[0].id])).rows, [{ id: 'btcpay:' + made.id, months: 3 }]);
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE owner_id = $1 AND secret_hash = $2", [owner[0].id, copy.hash])).rowCount, 1, 'the personal URL, for the computer that asked');
  const told = (await db.query("SELECT text FROM operator_notices WHERE text LIKE 'Closedhand: new sign-up%'")).rows.map(r => r.text);
  assert.match(told.at(-1), /^Closedhand: new sign-up with an account number, no email, took [a-z]+-[a-z]+-\d+\.closedhand\.ai\./);

  // The computer collects it once: the number, the URL and the key to Managed Models.
  const collected = await poll(copy);
  assert.match(collected.json.accountNumber, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}( [ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}){4}$/);
  assert.match(collected.json.url, /^https:\/\/[a-z]+-[a-z]+-\d+\.closedhand\.ai$/);
  assert.equal(collected.json.anonymous, true);
  assert.match(collected.json.included_ai?.key || '', /^sk-/, 'Managed Models collected as for a subscriber');
  const number = collected.json.accountNumber.replace(/ /g, '');
  assert.equal(owner[0].subject, crypto.createHmac('sha256', env.TOKEN_ENCRYPTION_KEY).update('account-number:' + number).digest('hex'), 'only its keyed fingerprint');
  assert.deepEqual((await poll(copy)).json, { state: 'none' }, 'answered once');
  for (const table of ['owners', 'addresses', 'anonymous_pending', 'operator_notices', 'ahead_payments']) {
    assert.equal((await db.query(`SELECT 1 FROM ${table} t WHERE row_to_json(t)::text LIKE $1`, ['%' + number + '%'])).rowCount, 0, 'the number is kept nowhere: ' + table);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM starter_grants')).rows[0].n, 0, 'no free days');
  const again = await ask(copy);
  assert.deepEqual([again.status, again.json.error], [409, 'This computer already has a personal URL.']);
}));

test('an invoice that lapses lets the claim go, a payment after that makes nothing, and a webhook gone astray is read back while the computer waits', quiet(async () => {
  const copy = computer();
  const first = await ask(copy);
  const lapsed = invoiceOf(first.json.url);
  assert.equal(await webhook('InvoiceExpired', lapsed), 200);
  assert.deepEqual((await poll(copy)).json, { state: 'none' }, 'let go');
  const owners = (await db.query('SELECT count(*)::int AS n FROM owners')).rows[0].n;
  status.set(lapsed, 'Settled');
  assert.equal(await webhook('InvoiceSettled', lapsed), 200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM owners')).rows[0].n, owners, 'paid late, nothing is made: support sorts it out');

  // Asking twice keeps only the latest claim.
  await ask(copy);
  const latest = await ask(copy, { port: 3000, acceptedTerms: true, months: 6 });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM anonymous_pending WHERE secret_hash = $1', [copy.hash])).rows[0].n, 1);
  assert.equal(invoices.at(-1).body.amount, '168');
  // No webhook: the computer's next question reads the invoice back.
  status.set(invoiceOf(latest.json.url), 'Settled');
  await db.query("UPDATE anonymous_pending SET checked_at = now() - interval '1 minute' WHERE secret_hash = $1", [copy.hash]);
  const got = await poll(copy);
  assert.match(got.json.accountNumber || '', /^[A-Z2-9]{4} /, 'read back and made');
  const owner = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [copy.hash])).rows[0].owner_id;
  assert.ok(new Date((await db.query('SELECT ends_at FROM ahead_plans WHERE owner_id = $1', [owner])).rows[0].ends_at) > new Date(Date.now() + 170 * 86400000), 'six months');

  // Every personal URL taken: nothing waits and nothing is charged.
  const taken = (await db.query("SELECT count(*)::int AS n FROM addresses WHERE state <> 'revoked'")).rows[0].n;
  const full = await listen({ ...env, ADDRESS_LIMIT: String(taken) });
  try {
    const before = invoices.length, late = computer();
    const refused = await ask(late, undefined, full.base);
    assert.deepEqual([refused.status, refused.json.error], [409, 'Personal URLs are full for now. Try again later.']);
    assert.equal(invoices.length, before, 'no invoice made');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM anonymous_pending WHERE secret_hash = $1', [late.hash])).rows[0].n, 0);
  } finally { full.server.close(); }
}));

test('signing in with the account number finds the account, never makes one, and each run of wrong tries waits longer', quiet(async () => {
  const copy = computer();
  const { accountNumber: shown, url } = (await claim(copy)).json;
  const cross = await signIn(shown, place(), 'https://elsewhere.example');
  assert.equal(cross.status, 403, 'only from closedhand.com');
  const ok = await signIn(shown.toLowerCase().replace(/ /g, '-'));
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  const account = (await call('GET', '/api/account', undefined, { cookie })).json;
  assert.deepEqual([account.signedIn, account.provider, account.email, account.anonymous, account.address], [true, 'anonymous', null, true, new URL(url).hostname]);
  assert.deepEqual(account.signIns, [], 'no sign-in to list');

  const owners = Number((await db.query('SELECT count(*)::int AS n FROM owners')).rows[0].n);
  const unknown = accountNumber.grouped(accountNumber.make());
  for (const typed of [unknown, 'not a number', '']) {
    const r = await signIn(typed);
    assert.deepEqual([r.status, r.json.error], [400, WRONG], 'the same words whatever was wrong');
  }
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM owners')).rows[0].n), owners, 'signing in never makes an account');

  // Five wrong tries from one connection, then it waits, even with the right number.
  const busy = place();
  for (let i = 0; i < 5; i++) assert.equal((await signIn(accountNumber.make(), busy)).status, 400);
  const waiting = await signIn(shown, busy);
  assert.equal(waiting.status, 429);
  assert.equal(waiting.json.error, 'Too many tries. Please wait 1 minute and try again.');
  assert.equal((await signIn(shown)).status, 200, 'another connection is not held up');
  // Five wrong tries at one number from anywhere, then that number waits.
  const guessed = accountNumber.make();
  for (let i = 0; i < 5; i++) assert.equal((await signIn(guessed)).status, 400);
  assert.equal((await signIn(guessed)).status, 429, 'from a sixth connection too');
}));

test('an account made with an account number pays in crypto only, on closedhand.com and from its computer', quiet(async () => {
  const copy = computer();
  const { accountNumber: shown } = (await claim(copy)).json;
  const cookie = cookieOf(await signIn(shown));
  const site = (await call('GET', '/api/account', undefined, { cookie })).json;
  assert.equal(site.plus.available, true, 'Managed Models are there for it in crypto');
  assert.deepEqual(site.plus.crypto.map(o => o.months), [3, 6, 9]);
  for (const card of ['longer', 'prices', 'free_month', 'card']) assert.equal(site.plus[card], undefined, 'nothing by card: ' + card);
  assert.equal(site.plan.name, 'ahead', 'paid ahead from the start');
  assert.ok(site.plus.ahead_until && site.plus.crypto_extend, 'and can carry on, or pay ahead again, in crypto');

  // While the plan paid ahead runs, there is no subscription to start, and once
  // it ends, still none by card.
  const AHEAD = 'Your account is paid ahead in crypto, so there is no subscription by card to start.';
  const refusals = async expected => {
    for (const body of [{ months: 1 }, { months: 1, agreed: true }, { months: 6, agreed: true }]) {
      const r = await call('POST', '/api/plus/checkout', body, signedIn(cookie));
      assert.deepEqual([r.status, r.json.error], expected, 'on closedhand.com: ' + JSON.stringify(body));
    }
    for (const body of [{ kind: 'plus', months: 1, agreed: true }, { kind: 'plus', months: 12, agreed: true }]) {
      const r = await call('POST', '/api/phone-enrollment/plus/checkout', body, copy.auth);
      assert.deepEqual([r.status, r.json.error], expected, 'from its computer: ' + body.months);
    }
  };
  await refusals([409, AHEAD]);
  const sub = await call('GET', '/subscribe', undefined, { cookie });
  assert.deepEqual([sub.status, sub.headers.get('location')], [302, '/account'], "chat's one-tap link goes to the account page");
  const page = (await call('GET', '/api/managed-models', undefined, { cookie })).json;
  assert.deepEqual([page.subscribe, page.freeDays], [false, undefined]);
  const mine = (await call('GET', '/api/phone-enrollment/account', undefined, copy.auth)).json.account;
  assert.deepEqual([mine.provider, mine.email, mine.anonymous, mine.signIns, mine.plan.name], ['anonymous', null, true, [], 'ahead']);
  assert.equal(mine.plus.longer, undefined);
  const owner = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [copy.hash])).rows[0].owner_id;
  await db.query("UPDATE ahead_plans SET ends_at = now() - interval '1 day', ended_at = now() WHERE owner_id = $1", [owner]);
  await refusals([400, CARDLESS]);
  const extend = await call('POST', '/api/phone-enrollment/plus/checkout', { kind: 'extend', agreed: true }, copy.auth);
  assert.equal(extend.status, 409, 'nothing to carry on by card');
  const ahead = await call('POST', '/api/phone-enrollment/plus/checkout', { kind: 'ahead', months: 3, agreed: true }, copy.auth);
  assert.equal(ahead.status, 200);
  assert.equal(ahead.json.url, BASE + '/pay/' + invoices.at(-1).id, 'paying ahead in crypto works');
  assert.deepEqual(Object.keys(invoices.at(-1).body.metadata).sort(), ['months', 'ownerId'], 'and the invoice carries nothing about the payer');
  const onSite = await call('POST', '/api/ahead/checkout', { months: 6, agreed: true }, signedIn(cookie));
  assert.equal(onSite.status, 200, 'on closedhand.com too');
}));

test('no Google or Microsoft sign-in is ever kept for an account made with an account number', quiet(async () => {
  const copy = computer();
  const { accountNumber: shown } = (await claim(copy)).json;
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: GOOGLE_APP, sub: 'g-number-rowan', email: 'rowan@example.com', email_verified: true, iat: now, exp: now + 3600 })).toString('base64url');
  const idToken = head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), googleKeys.privateKey).toString('base64url');
  const added = await call('POST', '/api/phone-enrollment/sign-in-google', { idToken }, copy.auth);
  assert.deepEqual([added.status, added.json.error], [409, 'Your Closedhand account uses an account number, so no Google or Microsoft sign-in is added.']);
  const claimed = await call('POST', '/api/phone-enrollment/claim-google', { idToken, port: 3000 }, copy.auth);
  assert.deepEqual(claimed.json, { state: 'unconfirmed', claimHere: true });
  assert.equal((await db.query("SELECT 1 FROM owners WHERE subject = 'g-number-rowan'")).rowCount, 0, 'no account made for the sign-in');
  assert.equal((await db.query("SELECT 1 FROM owner_sign_ins WHERE subject = 'g-number-rowan'")).rowCount, 0, 'nor added to this one');
  const cookie = cookieOf(await signIn(shown));
  assert.deepEqual((await call('GET', '/api/account', undefined, { cookie })).json.signIns, []);
}));

test('deleting an account made with an account number forgets it; the number then finds nothing', quiet(async () => {
  const copy = computer();
  const { accountNumber: shown } = (await claim(copy)).json;
  const cookie = cookieOf(await signIn(shown));
  const gone = await call('POST', '/api/account/delete', {}, signedIn(cookie));
  assert.deepEqual([gone.status, gone.json.deleted], [200, true]);
  const fingerprint = accountNumber.fingerprint(shown.replace(/ /g, ''), env.TOKEN_ENCRYPTION_KEY);
  assert.equal((await db.query('SELECT 1 FROM owners WHERE subject = $1', [fingerprint])).rowCount, 0);
  const after = await signIn(shown);
  assert.deepEqual([after.status, after.json.error], [400, WRONG]);
  // From its computer, the same.
  const other = computer();
  (await claim(other)).json;
  assert.equal((await call('POST', '/api/phone-enrollment/account/delete', {}, other.auth)).json.deleted, true);
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE secret_hash = $1 AND state <> 'revoked'", [other.hash])).rowCount, 0);
}));

test('the maintainer hears once a day when many accounts are made with an account number', quiet(async () => {
  const notices = { told: [], queue: async text => { notices.told.push(text); } };
  const made = Number((await db.query("SELECT count(*)::int AS n FROM owners WHERE provider = 'anonymous' AND created_at > now() - interval '1 day'")).rows[0].n);
  assert.ok(made >= 5, 'this file made more than five today');
  const capacity = require('../lib/capacity').create({ db, env: { ...env, ANONYMOUS_DAILY_ACCOUNTS: '5' }, notices });
  let told = await capacity.check();
  assert.deepEqual(told.filter(t => t.includes('account number')), [`Closedhand: ${made} accounts were made with an account number in the last 24 hours, more than usual. Worth a look for account farming.`]);
  told = await capacity.check();
  assert.deepEqual(told.filter(t => t.includes('account number')), [], 'once a day');
  await db.query("DELETE FROM operator_alerts WHERE kind = 'anonymous-burst'");
  const quietDay = require('../lib/capacity').create({ db, env: { ...env, ANONYMOUS_DAILY_ACCOUNTS: String(made + 1) }, notices });
  assert.deepEqual((await quietDay.check()).filter(t => t.includes('account number')), [], 'under the setting, nothing');
}));
